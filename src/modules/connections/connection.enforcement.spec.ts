import * as fs from 'fs';
import * as path from 'path';
import { canAccessListing, visibilitySql } from './connection.rules';

/**
 * Exclusivity has to hold in four independent places. Three are raw SQL or
 * separate services, so a unit test of the predicate alone would pass while a
 * listing leaked through a query nobody updated. These assert the guard is
 * actually present at each call site.
 */
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

describe('Preferred Charity exclusivity is enforced everywhere', () => {
  it('1. the claim path refuses an outsider', () => {
    const src = read('src/modules/claims/services/claims.service.ts');
    expect(src).toContain('assertCanClaim');
    // Must be inside claimListing, not merely imported.
    const claim = src.slice(src.indexOf('async claimListing'));
    expect(claim.slice(0, 4000)).toContain('assertCanClaim(listing, caller.orgId)');
  });

  it('2. authenticated nearby search filters by viewer org', () => {
    const src = read('src/modules/foodlisting/services/food.listing.service.ts');
    expect(src).toContain('fl."exclusiveToOrgId" IS NULL');
    expect(src).toContain('fl."releasedAt" IS NOT NULL');
    expect(src).toContain('fl."exclusiveToOrgId" = ${claimantOrgId}');
  });

  it('3. the public proximity search excludes reserved listings outright', () => {
    const src = read('src/modules/psearch/psearch.service.ts');
    expect(src).toContain('fl."exclusiveToOrgId" IS NULL');
    // No viewer exists on that endpoint and results are cached by location,
    // so it must never match on a viewer id.
    expect(src).not.toContain('fl."exclusiveToOrgId" = ');
  });

  it('4. fetching one listing by id is viewer-aware', () => {
    const src = read('src/modules/foodlisting/services/food.listing.service.ts');
    expect(src).toContain('async getListingById(id: number, viewerOrgId?: number | null)');
    expect(src).toContain('assertCanAccessListing');
  });

  it('the new-listing fan-out is never reached by a Connection listing', () => {
    // The daily loop writes the listing directly rather than through
    // createListing, which is the only caller of enqueueNewListing.
    const daily = read('src/modules/connections/connection.daily.service.ts');
    expect(daily).not.toContain('enqueueNewListing');
    expect(daily).toContain('tx.foodListing.create');

    const listings = read('src/modules/foodlisting/services/food.listing.service.ts');
    expect(listings.match(/enqueueNewListing/g) ?? []).toHaveLength(1);
  });

  it('every nearby query block carries the guard', () => {
    const src = read('src/modules/foodlisting/services/food.listing.service.ts');
    const blocks = (src.match(/fl\."organisationId" <> \$\{claimantOrgId\}/g) ?? []).length;
    const guards = (src.match(/fl\."exclusiveToOrgId" IS NULL/g) ?? []).length;
    // Both query blocks must be covered, not just the first.
    expect(guards).toBeGreaterThanOrEqual(blocks);
  });
});

describe('the SQL guard and the predicate agree', () => {
  const CHARITY = 7;
  const rows = [
    { exclusiveToOrgId: null, releasedAt: null },
    { exclusiveToOrgId: CHARITY, releasedAt: null },
    { exclusiveToOrgId: CHARITY, releasedAt: new Date() },
    { exclusiveToOrgId: 99, releasedAt: null },
  ];

  /** Evaluates the generated SQL predicate against a row, in JS. */
  const evalSql = (sql: string, row: any): boolean => {
    const clauses = sql.replace(/^\(|\)$/g, '').split(' OR ');
    return clauses.some((c) => {
      if (c.includes('IS NULL')) return row.exclusiveToOrgId === null;
      if (c.includes('IS NOT NULL')) return row.releasedAt !== null;
      const m = /= (\d+)/.exec(c);
      return m ? row.exclusiveToOrgId === Number(m[1]) : false;
    });
  };

  for (const viewer of [CHARITY, 99, null]) {
    it(`matches canAccessListing for viewer ${viewer ?? 'anonymous'}`, () => {
      for (const row of rows) {
        expect(evalSql(visibilitySql('fl', viewer), row))
          .toBe(canAccessListing(row, viewer));
      }
    });
  }
});
