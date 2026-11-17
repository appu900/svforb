/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * End-to-end exercise of Make Food Count (B1 + B2).
 *
 *   npx ts-node --transpile-only -P tsconfig.json test/mfc.e2e.ts
 *
 * Real services inside one transaction that is rolled back at the end, so the
 * real schema and constraints run and nothing is written.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { FoodSource, OrgRole, OrgType, PlatformRole, SiteRole } from '@prisma/client';
import { createPgPool } from '../src/infra/prisma/create-pg-pool';
import { EnterpriseScopeService } from '../src/modules/enterprise/services/enterprise-scope.service';
import { MfcAccessService } from '../src/modules/make-food-count/services/mfc-access.service';
import { MfcRecordService } from '../src/modules/make-food-count/services/mfc-record.service';

const results: { name: string; ok: boolean }[] = [];
let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? ' PASS' : ' FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) { failed += 1; throw new Error(`${name}: ${detail}`); }
}
const section = (t: string) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 54 - t.length))}`);
class Rollback extends Error {}

async function main() {
  const prisma = new PrismaClient({ adapter: new PrismaPg(createPgPool({ max: 3 })) });
  let sample: unknown = null;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL idle_in_transaction_session_timeout = 0');
      const px: any = new Proxy(tx, {
        get(t: any, p) { if (p === '$transaction') return (fn: any) => fn(px); return t[p]; },
      });

      const scope = new EnterpriseScopeService(px);
      const access = new MfcAccessService(px, scope);
      const records = new MfcRecordService(px, access, scope);

      section('Fixtures');
      const stamp = Date.now();
      const org = await tx.organisation.create({
        data: { name: `MFC Kitchen ${stamp}`, organizationType: OrgType.BUSINESS_SINGLE,
                region: 'AU', address: '1 Test St' } });
      const charityOrg = await tx.organisation.create({
        data: { name: `MFC Charity ${stamp}`, organizationType: OrgType.CHARITY_SINGLE,
                region: 'AU', address: '2 Test St' } });
      const mk = (l: string) => tx.user.create({ data: {
        firstName: 'MFC', lastName: l, email: `mfc.${l}.${stamp}@example.invalid`,
        passwordHash: 'x', phoneNumber: '0400000000', region: 'AU',
        platformRole: PlatformRole.ORG_USER } });
      const chef = await mk('chef');
      const otherChef = await mk('other');
      const charityUser = await mk('charity');

      const site = await tx.site.create({ data: {
        organisationId: org.id, organisationName: 'Main Kitchen', name: 'Main Kitchen',
        address: '1 Test St', contactName: 'MFC', contactEmail: 'k@example.invalid',
        contactMobile: '0400000000', timezone: 'Australia/Melbourne', isActive: true } });
      const otherSite = await tx.site.create({ data: {
        organisationId: org.id, organisationName: 'Other Kitchen', name: 'Other Kitchen',
        address: '3 Test St', contactName: 'MFC', contactEmail: 'o@example.invalid',
        contactMobile: '0400000000', timezone: 'Australia/Melbourne', isActive: true } });

      await tx.orgMemeberShip.createMany({ data: [
        { userId: chef.id, organisationId: org.id, orgRole: OrgRole.ORG_MEMBER },
        { userId: otherChef.id, organisationId: org.id, orgRole: OrgRole.ORG_MEMBER },
        { userId: charityUser.id, organisationId: charityOrg.id, orgRole: OrgRole.SUPER_ADMIN },
      ] });
      await tx.siteAccess.create({ data: { userId: chef.id, siteId: site.id,
        organisationId: org.id, siteRole: SiteRole.STAFF, grantedBy: chef.id } });
      await tx.siteAccess.create({ data: { userId: otherChef.id, siteId: otherSite.id,
        organisationId: org.id, siteRole: SiteRole.STAFF, grantedBy: chef.id } });

      const jwt = (u: any, orgId: number, orgType: OrgType, orgRole: OrgRole) =>
        ({ sub: u.id, email: u.email, platformRole: PlatformRole.ORG_USER,
           orgId, orgType, orgRole }) as any;
      const chefJwt = jwt(chef, org.id, OrgType.BUSINESS_SINGLE, OrgRole.ORG_MEMBER);
      const otherJwt = jwt(otherChef, org.id, OrgType.BUSINESS_SINGLE, OrgRole.ORG_MEMBER);
      const charityJwt = jwt(charityUser, charityOrg.id, OrgType.CHARITY_SINGLE, OrgRole.SUPER_ADMIN);
      check('Fixtures created', true, `org ${org.id}, site ${site.id}`);

      section('Reach (SPEC §6)');
      check('A charity has no reach at all', (await access.reachSiteIds(charityJwt))!.length === 0);
      let charity404 = false;
      try { await access.assertSiteInReach(charityJwt, site.id); } catch (e: any) { charity404 = e.status === 404; }
      check('A charity gets 404, not 403', charity404);
      check('A chef reaches only their own site',
        JSON.stringify(await access.reachSiteIds(chefJwt)) === JSON.stringify([site.id]));
      let crossSite = false;
      try { await access.assertSiteInReach(chefJwt, otherSite.id); } catch (e: any) { crossSite = e.status === 404; }
      check('Another site is a 404 for them', crossSite);

      section('Create (idempotent)');
      const key = `req-${stamp}`;
      const r1 = await records.create(chefJwt, { siteId: site.id, clientRequestId: key,
        sources: [FoodSource.OVERPRODUCTION, FoodSource.PREPARATION, FoodSource.PLATE_SCRAPS] } as any);
      const r2 = await records.create(chefJwt, { siteId: site.id, clientRequestId: key,
        sources: [FoodSource.OVERPRODUCTION] } as any);
      check('Same clientRequestId returns the same record', r1.id === r2.id, `record ${r1.id}`);
      check('Starts as a DRAFT at version 1', r1.status === 'DRAFT' && r1.version === 1);

      section('Lines — UAT-02');
      const uat02 = await records.putLines(chefJwt, r1.id, { version: r1.version, lines: [
        { clientKey: 'a', source: FoodSource.OVERPRODUCTION, category: 'meat_poultry', subtype: 'chicken', qtyKg: 5, fitForHumans: true },
        { clientKey: 'b', source: FoodSource.OVERPRODUCTION, category: 'meat_poultry', subtype: 'beef', qtyKg: 3, fitForHumans: false },
        { clientKey: 'c', source: FoodSource.OVERPRODUCTION, category: 'seafood', subtype: 'fish', qtyKg: 2, fitForHumans: true },
      ] } as any);
      check('UAT-02: 10 / 7 / 3',
        uat02.totals.recordedKg === 10 && uat02.totals.fitKg === 7 && uat02.totals.notFitKg === 3,
        `${uat02.totals.recordedKg} / ${uat02.totals.fitKg} / ${uat02.totals.notFitKg}`);

      section('Lines — UAT-03');
      const uat03 = await records.putLines(chefJwt, r1.id, { version: uat02.version, lines: [
        { clientKey: 'a', source: FoodSource.OVERPRODUCTION, category: 'meat_poultry', subtype: 'chicken', qtyKg: 5, fitForHumans: true },
        { clientKey: 'b', source: FoodSource.OVERPRODUCTION, category: 'meat_poultry', subtype: 'beef', qtyKg: 3, fitForHumans: false },
        { clientKey: 'c', source: FoodSource.OVERPRODUCTION, category: 'seafood', subtype: 'fish', qtyKg: 2, fitForHumans: true },
        { clientKey: 'd', source: FoodSource.PREPARATION, category: 'peels_trimmings', qtyKg: 4 },
        { clientKey: 'e', source: FoodSource.PLATE_SCRAPS, category: 'plate_scraps', qtyKg: 2 },
      ] } as any);
      check('UAT-03: 16 / 7 / 9',
        uat03.totals.recordedKg === 16 && uat03.totals.fitKg === 7 && uat03.totals.notFitKg === 9,
        `${uat03.totals.recordedKg} / ${uat03.totals.fitKg} / ${uat03.totals.notFitKg}`);
      check('UAT-06/07 prefill split: 7 edible, 9 non-edible',
        uat03.byKind.EDIBLE.eligibleKg === 7 && uat03.byKind.NON_EDIBLE.eligibleKg === 9);

      section('Server-side rules');
      const forced = await records.putLines(chefJwt, r1.id, { version: uat03.version, lines: [
        { clientKey: 'a', source: FoodSource.OVERPRODUCTION, category: 'meat_poultry', subtype: 'chicken', qtyKg: 5, fitForHumans: true },
        { clientKey: 'b', source: FoodSource.OVERPRODUCTION, category: 'meat_poultry', subtype: 'beef', qtyKg: 3, fitForHumans: false },
        { clientKey: 'c', source: FoodSource.OVERPRODUCTION, category: 'seafood', subtype: 'fish', qtyKg: 2, fitForHumans: true },
        { clientKey: 'd', source: FoodSource.PREPARATION, category: 'peels_trimmings', qtyKg: 4, fitForHumans: true },
        { clientKey: 'e', source: FoodSource.PLATE_SCRAPS, category: 'plate_scraps', qtyKg: 2 },
      ] } as any);
      check('fitForHumans is forced false outside Overproduction',
        forced.lines.find((l: any) => l.clientKey === 'd')!.fitForHumans === false
        && forced.totals.fitKg === 7);

      // Actually move a quantity and a fit flag, so the events below are real.
      const edited = await records.putLines(chefJwt, r1.id, { version: forced.version, lines: [
        { clientKey: 'a', source: FoodSource.OVERPRODUCTION, category: 'meat_poultry', subtype: 'chicken', qtyKg: 4.5, fitForHumans: true },
        { clientKey: 'b', source: FoodSource.OVERPRODUCTION, category: 'meat_poultry', subtype: 'beef', qtyKg: 3, fitForHumans: true },
        { clientKey: 'c', source: FoodSource.OVERPRODUCTION, category: 'seafood', subtype: 'fish', qtyKg: 2, fitForHumans: true },
        { clientKey: 'd', source: FoodSource.PREPARATION, category: 'peels_trimmings', qtyKg: 4 },
        { clientKey: 'e', source: FoodSource.PLATE_SCRAPS, category: 'plate_scraps', qtyKg: 2 },
      ] } as any);
      check('A changed quantity is reflected', edited.totals.recordedKg === 15.5,
        `${edited.totals.recordedKg} kg`);
      check('Ticking fit on beef moves 3 kg across',
        edited.totals.fitKg === 9.5 && edited.totals.notFitKg === 6,
        `${edited.totals.fitKg} / ${edited.totals.notFitKg}`);

      const bad = async (lines: any[]) => {
        try { await records.putLines(chefJwt, r1.id, { version: edited.version, lines } as any); return false; }
        catch { return true; }
      };
      check('Unknown category rejected', await bad([
        { clientKey: 'x', source: FoodSource.SPOILAGE, category: 'unicorn', qtyKg: 1 }]));
      check('Category from the wrong source rejected', await bad([
        { clientKey: 'x', source: FoodSource.PLATE_SCRAPS, category: 'dairy', qtyKg: 1 }]));
      check('Unknown subtype rejected', await bad([
        { clientKey: 'x', source: FoodSource.OVERPRODUCTION, category: 'meat_poultry', subtype: 'ostrich', qtyKg: 1 }]));
      check('A source not on the record rejected', await bad([
        { clientKey: 'x', source: FoodSource.SPOILAGE, category: 'dairy', qtyKg: 1 }]));
      check('Duplicate clientKey rejected', await bad([
        { clientKey: 'z', source: FoodSource.PLATE_SCRAPS, category: 'plate_scraps', qtyKg: 1 },
        { clientKey: 'z', source: FoodSource.PLATE_SCRAPS, category: 'plate_scraps', qtyKg: 1 }]));

      section('Concurrency and soft delete');
      let stale = false;
      try { await records.putLines(chefJwt, r1.id, { version: 1, lines: [] } as any); }
      catch (e: any) { stale = e.status === 409 && e.response?.code === 'STALE_VERSION'; }
      check('A stale version returns 409 with the current one', stale);

      const trimmed = await records.putLines(chefJwt, r1.id, { version: edited.version, lines: [
        { clientKey: 'a', source: FoodSource.OVERPRODUCTION, category: 'meat_poultry', subtype: 'chicken', qtyKg: 5, fitForHumans: true },
      ] } as any);
      check('Dropped lines disappear from totals', trimmed.totals.recordedKg === 5 && trimmed.lines.length === 1);
      const deleted = await tx.foodRecordLine.count({ where: { recordId: r1.id, deletedAt: { not: null } } });
      check('They are soft-deleted, not destroyed', deleted === 4, `${deleted} rows kept`);

      const events = await records.events(chefJwt, r1.id);
      check('Every change left an event', events.length >= 10, `${events.length} events`);
      const types = new Set(events.map((e: any) => e.type));
      for (const t of ['RECORD_CREATED', 'LINE_CREATED', 'QTY_CHANGED', 'FIT_CHANGED', 'LINE_DELETED']) {
        check(`  event: ${t}`, types.has(t));
      }

      section('Save and isolation');
      const saved = await records.save(chefJwt, r1.id, { version: trimmed.version } as any);
      check('DRAFT → SAVED', saved.status === 'SAVED');
      const again = await records.save(chefJwt, r1.id, { version: saved.version } as any);
      check('Saving twice is a no-op, not an error', again.status === 'SAVED');

      let foreign = false;
      try { await records.get(otherJwt, r1.id); } catch (e: any) { foreign = e.status === 404; }
      check("Another site's user cannot read it", foreign);
      let charityRead = false;
      try { await records.get(charityJwt, r1.id); } catch (e: any) { charityRead = e.status === 404; }
      check('A charity cannot read it', charityRead);

      const listed = await records.list(chefJwt, {} as any);
      check('It appears in their own list', listed.records.some((r: any) => r.id === r1.id));
      const charityList = await records.list(charityJwt, {} as any);
      check('A charity sees an empty list, not an error', charityList.records.length === 0);

      sample = await records.get(chefJwt, r1.id);
      throw new Rollback('rollback');
    }, { maxWait: 60_000, timeout: 600_000 });
  } catch (err: any) {
    if (!(err instanceof Rollback)) console.error(`\nSTOPPED: ${err.message}`);
  } finally {
    await prisma.$disconnect();
  }

  if (sample) {
    console.log('\n── Sample GET /mfc/records/:id ─────────────────────────');
    console.log(JSON.stringify(sample, null, 2));
  }
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${'='.repeat(60)}`);
  console.log(`RESULT: ${passed}/${results.length} checks passed, ${failed} failed`);
  console.log('Transaction rolled back — nothing was written.');
  console.log('='.repeat(60));
  process.exit(failed === 0 ? 0 : 1);
}
main();
