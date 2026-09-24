import { ConflictException, BadRequestException } from '@nestjs/common';
import { ConnectionDayOutcome as Outcome, ConnectionStatus as S } from '@prisma/client';
import {
  assertCanClaim, assertDistinctSites, assertTransition, canAccessListing,
  canTransition, isCollecting, isExclusive, reliabilityFrom, releaseReasonFor,
  shouldAutoRelease, shouldEscalateToBusiness, visibilitySql, visibilityWhere,
} from './connection.rules';

const CHARITY = 7;
const OTHER = 99;
const utc = (iso: string) => new Date(iso);

describe('Connection rules', () => {
  describe('status transitions', () => {
    it('lets an invitation be accepted, declined or expire', () => {
      expect(canTransition(S.PENDING, S.ACTIVE)).toBe(true);
      expect(canTransition(S.PENDING, S.DECLINED)).toBe(true);
      expect(canTransition(S.PENDING, S.EXPIRED)).toBe(true);
    });

    it('lets an active connection pause and resume', () => {
      expect(canTransition(S.ACTIVE, S.PAUSED)).toBe(true);
      expect(canTransition(S.PAUSED, S.ACTIVE)).toBe(true);
    });

    it('never revives a terminal connection', () => {
      for (const terminal of [S.DECLINED, S.EXPIRED, S.ENDED]) {
        for (const target of [S.ACTIVE, S.PENDING, S.PAUSED]) {
          expect(canTransition(terminal, target)).toBe(false);
        }
      }
    });

    it('cannot skip straight from pending to paused', () => {
      expect(canTransition(S.PENDING, S.PAUSED)).toBe(false);
    });

    it('throws with both ends named', () => {
      expect(() => assertTransition(S.ENDED, S.ACTIVE)).toThrow(ConflictException);
      expect(() => assertTransition(S.ACTIVE, S.PAUSED)).not.toThrow();
    });

    it('only collects while active', () => {
      expect(isCollecting(S.ACTIVE)).toBe(true);
      for (const s of [S.PENDING, S.PAUSED, S.DECLINED, S.EXPIRED, S.ENDED]) {
        expect(isCollecting(s)).toBe(false);
      }
    });
  });

  describe('listing exclusivity', () => {
    const reserved = { exclusiveToOrgId: CHARITY, releasedAt: null };
    const released = { exclusiveToOrgId: CHARITY, releasedAt: utc('2026-09-24T06:00:00Z') };
    const ordinary = { exclusiveToOrgId: null, releasedAt: null };

    it('is exclusive only while reserved and unreleased', () => {
      expect(isExclusive(reserved)).toBe(true);
      expect(isExclusive(released)).toBe(false);
      expect(isExclusive(ordinary)).toBe(false);
    });

    it('lets the preferred charity in and keeps everyone else out', () => {
      expect(canAccessListing(reserved, CHARITY)).toBe(true);
      expect(canAccessListing(reserved, OTHER)).toBe(false);
      expect(canAccessListing(reserved, null)).toBe(false);
    });

    it('opens to everyone once released', () => {
      expect(canAccessListing(released, OTHER)).toBe(true);
      expect(canAccessListing(released, null)).toBe(true);
    });

    it('leaves ordinary listings public', () => {
      expect(canAccessListing(ordinary, OTHER)).toBe(true);
    });

    it('refuses a claim from an outsider', () => {
      expect(() => assertCanClaim(reserved, OTHER)).toThrow(ConflictException);
      expect(() => assertCanClaim(reserved, CHARITY)).not.toThrow();
      expect(() => assertCanClaim(ordinary, OTHER)).not.toThrow();
    });
  });

  describe('visibility filters match the predicate', () => {
    // The Prisma filter, the SQL filter and canAccessListing must agree, or a
    // listing hidden from one discovery path leaks through another.
    const cases = [
      { listing: { exclusiveToOrgId: null, releasedAt: null }, label: 'public' },
      { listing: { exclusiveToOrgId: CHARITY, releasedAt: null }, label: 'reserved' },
      { listing: { exclusiveToOrgId: CHARITY, releasedAt: utc('2026-01-01T00:00:00Z') }, label: 'released' },
    ];

    const matchesPrismaWhere = (where: any, listing: any): boolean =>
      where.OR.some((clause: any) => {
        if ('exclusiveToOrgId' in clause && typeof clause.exclusiveToOrgId === 'number') {
          return listing.exclusiveToOrgId === clause.exclusiveToOrgId;
        }
        if ('exclusiveToOrgId' in clause) return listing.exclusiveToOrgId === null;
        if ('releasedAt' in clause) return listing.releasedAt !== null;
        return false;
      });

    for (const viewer of [CHARITY, OTHER, null]) {
      for (const { listing, label } of cases) {
        it(`agrees for viewer ${viewer ?? 'anonymous'} on a ${label} listing`, () => {
          expect(matchesPrismaWhere(visibilityWhere(viewer), listing))
            .toBe(canAccessListing(listing, viewer));
        });
      }
    }

    it('emits SQL that names the alias and the viewer', () => {
      expect(visibilitySql('fl', CHARITY)).toContain('"fl"."exclusiveToOrgId" = 7');
      expect(visibilitySql('fl', null)).not.toContain('=');
      expect(visibilitySql('fl', null)).toContain('IS NULL');
    });

    it('never interpolates a non-numeric viewer id into SQL', () => {
      expect(visibilitySql('fl', '7; DROP TABLE users' as unknown as number))
        .not.toContain('DROP');
    });
  });

  describe('fallback timing', () => {
    const day = {
      outcome: Outcome.PUBLISHED,
      cutoffAt: utc('2026-09-24T05:30:00Z'),
      windowStartAt: utc('2026-09-24T06:00:00Z'),
    };

    it('chases the business between cut-off and window start', () => {
      expect(shouldEscalateToBusiness(day, utc('2026-09-24T05:29:00Z'))).toBe(false);
      expect(shouldEscalateToBusiness(day, utc('2026-09-24T05:30:00Z'))).toBe(true);
      expect(shouldEscalateToBusiness(day, utc('2026-09-24T05:59:00Z'))).toBe(true);
      expect(shouldEscalateToBusiness(day, utc('2026-09-24T06:00:00Z'))).toBe(false);
    });

    it('auto-releases once the window opens', () => {
      expect(shouldAutoRelease(day, utc('2026-09-24T05:59:00Z'))).toBe(false);
      expect(shouldAutoRelease(day, utc('2026-09-24T06:00:00Z'))).toBe(true);
    });

    it('leaves a day alone once it has been answered', () => {
      for (const outcome of [Outcome.COLLECTED, Outcome.RELEASED, Outcome.NO_SURPLUS]) {
        expect(shouldAutoRelease({ ...day, outcome }, utc('2026-09-24T07:00:00Z'))).toBe(false);
        expect(shouldEscalateToBusiness({ ...day, outcome }, utc('2026-09-24T05:45:00Z'))).toBe(false);
      }
    });

    it('maps each trigger to a stored reason', () => {
      expect(releaseReasonFor('CHARITY_DECLINED')).toBe('CHARITY_DECLINED');
      expect(releaseReasonFor('AUTO_RELEASED')).toBe('AUTO_RELEASED');
      expect(releaseReasonFor('PARTIAL_REMAINDER')).toBe('PARTIAL_REMAINDER');
    });
  });

  describe('reliability', () => {
    it('is null before anything has been offered', () => {
      expect(reliabilityFrom({ collected: 0, released: 0, missed: 0, noSurplus: 0 }).percent)
        .toBeNull();
    });

    it('counts collected against everything offered', () => {
      const r = reliabilityFrom({ collected: 8, released: 1, missed: 1, noSurplus: 0 });
      expect(r.offered).toBe(10);
      expect(r.percent).toBe(80);
    });

    // A quiet week at the kitchen is not the charity's failure.
    it('excludes days the business had no surplus', () => {
      const r = reliabilityFrom({ collected: 5, released: 0, missed: 0, noSurplus: 20 });
      expect(r.offered).toBe(5);
      expect(r.percent).toBe(100);
    });

    it('reports declines and misses separately', () => {
      const r = reliabilityFrom({ collected: 6, released: 3, missed: 1, noSurplus: 2 });
      expect(r.declined).toBe(3);
      expect(r.missed).toBe(1);
      expect(r.percent).toBe(60);
    });

    it('rounds to one decimal place', () => {
      expect(reliabilityFrom({ collected: 2, released: 1, missed: 0, noSurplus: 0 }).percent)
        .toBe(66.7);
    });
  });

  it('refuses a site connected to itself', () => {
    expect(() => assertDistinctSites(5, 5)).toThrow(BadRequestException);
    expect(() => assertDistinctSites(5, 6)).not.toThrow();
  });
});
