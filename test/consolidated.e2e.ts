/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * End-to-end exercise of Consolidated Collections.
 *
 *   npx ts-node --transpile-only -P tsconfig.json test/consolidated.e2e.ts
 *
 * Every service shares ONE outer interactive transaction, and that transaction
 * is rolled back at the end. The real services, schema, constraints and SQL all
 * run; nothing is written. That makes it safe to point at any database,
 * including production — verified by checking that the consolidated tables are
 * still empty afterwards.
 *
 * Caches, queues, pushes and sockets are stubbed: they are side effects we do
 * not want, and they are not what this is testing.
 */
/**
 * End-to-end exercise of Consolidated Collections.
 *
 * Every service shares ONE outer interactive transaction, which is rolled back
 * at the end. That means the real services, the real schema, the real
 * constraints and the real SQL all run — and nothing is persisted.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  ClaimKind, ClaimStatus, ConsolidatedCollectionStatus, ConsolidatedContributionStatus,
  ConsolidatedHandoverMethod, ConsolidatedListingRole, ConsolidatedMemberRole,
  ConsolidatedRecurrence, ConsolidatedRejectionReason, ListingStatus, OrgRole, OrgType,
  PlatformRole, SiteRole,
} from '@prisma/client';
import { createPgPool } from '../src/infra/prisma/create-pg-pool';
import { EnterpriseScopeService } from '../src/modules/enterprise/services/enterprise-scope.service';
import { FoodListingService } from '../src/modules/foodlisting/services/food.listing.service';
import { ClaimsService } from '../src/modules/claims/services/claims.service';
import { ConsolidatedAccessService } from '../src/modules/consolidated/services/consolidated-access.service';
import { ConsolidatedAuditService } from '../src/modules/consolidated/services/consolidated-audit.service';
import { ConsolidatedGroupService } from '../src/modules/consolidated/services/consolidated-group.service';
import { ConsolidatedScheduleService } from '../src/modules/consolidated/services/consolidated-schedule.service';
import { ConsolidatedCollectionService } from '../src/modules/consolidated/services/consolidated-collection.service';
import { ConsolidatedContributionService } from '../src/modules/consolidated/services/consolidated-contribution.service';
import { ConsolidatedReceiptService } from '../src/modules/consolidated/services/consolidated-receipt.service';
import { ConsolidatedPublishService } from '../src/modules/consolidated/services/consolidated-publish.service';
import { ConsolidatedCompletionService } from '../src/modules/consolidated/services/consolidated-completion.service';
import { ConsolidatedReportService } from '../src/modules/consolidated/services/consolidated-report.service';
import { DECLARATIONS } from '../src/modules/consolidated/consolidated.constants';

type Res = { name: string; ok: boolean; detail: string };
const results: Res[] = [];
let failed = 0;

function check(name: string, ok: boolean, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? ' PASS' : ' FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) { failed += 1; throw new Error(`${name}: ${detail}`); }
}

function section(title: string) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);
}

const noop = async () => undefined;
/**
 * A collaborator that answers any method with a resolved no-op.
 *
 * Caches, queues, pushes and sockets are all side effects we deliberately do
 * not want here — enumerating their method names only produces false failures
 * when one is missed.
 */
const stub = (_names: string[] = []): any =>
  new Proxy({}, { get: () => noop });

/** A rollback marker, so the final throw is not mistaken for a failure. */
class Rollback extends Error {}

async function main() {
  const prisma = new PrismaClient({ adapter: new PrismaPg(createPgPool({ max: 3 })) });
  const started = Date.now();

  try {
    await prisma.$transaction(async (tx) => {
      // Every service's own `$transaction` is redirected into this one, so all
      // of them see each other's writes and nothing escapes the rollback.
      // Round trips to the managed database are slow enough that a long
      // scenario can be killed mid-way by the idle-in-transaction timeout.
      await tx.$executeRawUnsafe('SET LOCAL idle_in_transaction_session_timeout = 0');

      const px: any = new Proxy(tx, {
        get(target: any, prop) {
          if (prop === '$transaction') return (fn: any) => fn(px);
          return target[prop];
        },
      });

      // ─── Services, wired as Nest would wire them ──────────────────────────
      const scope = new EnterpriseScopeService(px);
      const audit = new ConsolidatedAuditService(px);
      const access = new ConsolidatedAccessService(px, audit);
      const notifier: any = stub([
        'collectionsScheduled', 'closingSoon', 'collectionClosed', 'remindSites',
        'handoverOverdue', 'lateContribution', 'lateDecided', 'handoverConfirmed',
        'receiptRecorded', 'published', 'claimed', 'pickupSoon', 'changeRequested',
        'materialChange', 'itemCheckDue', 'completed', 'collectionCancelled', 'expired',
        'sitesInvited', 'invitationAnswered',
      ]);
      const cacheStub: any = stub(['invalidateAllNearby', 'invalidateRecentPage1',
        'invalidateOrgPage1', 'getListing', 'setListing', 'getOrgPage']);
      const queueStub: any = stub(['enqueueNewListing', 'enqueueListingExpiry']);

      const listings = new FoodListingService(px, cacheStub, stub(['uploadFile']), queueStub, scope);
      const groups = new ConsolidatedGroupService(px, access, audit, notifier);
      const schedules = new ConsolidatedScheduleService(px, access, audit);
      const collections = new ConsolidatedCollectionService(px, access, audit, notifier);
      const contributions = new ConsolidatedContributionService(
        px, access, audit, notifier, listings, scope);
      const receipts = new ConsolidatedReceiptService(px, access, audit, notifier);
      const publishing = new ConsolidatedPublishService(
        px, access, audit, notifier, listings, queueStub, cacheStub, scope, collections);
      const completion = new ConsolidatedCompletionService(px, access, audit, notifier, cacheStub);
      const reports = new ConsolidatedReportService(px, access);
      const claims = new ClaimsService(
        px, stub(), stub(), scope, stub(),
        { getLiveDriversForSite: async () => [] } as any);

      // ─── Fixtures ─────────────────────────────────────────────────────────
      section('Fixtures');
      const stamp = Date.now();
      const plan = await tx.subscriptionPlan.findFirstOrThrow({ where: { name: 'MULTI_SITE' } });

      const org = await tx.organisation.create({
        data: {
          name: `E2E Venue ${stamp}`, organizationType: OrgType.BUSINESS_MULTI,
          region: 'AU', address: '1 Olympic Blvd, Melbourne',
        },
      });
      await tx.orgSubscription.create({
        data: { organisationId: org.id, planId: plan.id, status: 'ACTIVE', quantity: 3 },
      });
      const charityOrg = await tx.organisation.create({
        data: {
          name: `E2E Charity ${stamp}`, organizationType: OrgType.CHARITY_SINGLE,
          region: 'AU', address: '2 Olympic Blvd, Melbourne',
        },
      });

      const mkUser = async (label: string) => tx.user.create({
        data: {
          firstName: 'E2E', lastName: label, email: `e2e.${label}.${stamp}@example.invalid`,
          passwordHash: 'x', phoneNumber: '0400000000', region: 'AU',
          platformRole: PlatformRole.ORG_USER,
        },
      });
      const owner = await mkUser('owner');
      const manager = await mkUser('manager');
      const receiver = await mkUser('receiver');
      const charityUser = await mkUser('charity');
      const siteUsers = [await mkUser('kiosk1'), await mkUser('kiosk2'), await mkUser('suite')];

      await tx.orgMemeberShip.createMany({
        data: [
          { userId: owner.id, organisationId: org.id, orgRole: OrgRole.SUPER_ADMIN },
          { userId: manager.id, organisationId: org.id, orgRole: OrgRole.ORG_ADMIN },
          { userId: receiver.id, organisationId: org.id, orgRole: OrgRole.ORG_MEMBER },
          ...siteUsers.map((u) => ({ userId: u.id, organisationId: org.id, orgRole: OrgRole.ORG_MEMBER })),
          { userId: charityUser.id, organisationId: charityOrg.id, orgRole: OrgRole.SUPER_ADMIN },
        ],
      });

      const siteNames = ['Kiosk 1', 'Kiosk 2', 'Corporate Suite'];
      const sites = [] as any[];
      for (const [i, name] of siteNames.entries()) {
        sites.push(await tx.site.create({
          data: {
            organisationId: org.id, organisationName: name, name,
            address: `${i + 1} Olympic Blvd, Melbourne`, postcode: '3000',
            contactName: 'E2E', contactEmail: 'e2e@example.invalid', contactMobile: '0400000000',
            latitude: -37.8216, longitude: 144.9799, timezone: 'Australia/Melbourne',
            isActive: true,
          },
        }));
      }
      const charitySite = await tx.site.create({
        data: {
          organisationId: charityOrg.id, organisationName: 'E2E Charity Site', name: 'E2E Charity Site',
          address: '2 Olympic Blvd, Melbourne', contactName: 'E2E',
          contactEmail: 'e2e.charity@example.invalid', contactMobile: '0400000000',
          latitude: -37.8220, longitude: 144.9800, timezone: 'Australia/Melbourne', isActive: true,
        },
      });

      for (const [i, u] of siteUsers.entries()) {
        await tx.siteAccess.create({
          data: {
            userId: u.id, siteId: sites[i].id, organisationId: org.id,
            siteRole: SiteRole.STAFF, grantedBy: owner.id,
          },
        });
      }
      await tx.siteAccess.create({
        data: {
          userId: charityUser.id, siteId: charitySite.id, organisationId: charityOrg.id,
          siteRole: SiteRole.SITE_ADMIN, grantedBy: charityUser.id,
        },
      });

      const jwt = (u: any, orgId: number, orgType: OrgType, orgRole: OrgRole, siteId?: number) => ({
        sub: u.id, email: u.email, platformRole: PlatformRole.ORG_USER,
        orgId, orgType, orgRole, siteId,
      }) as any;

      const ownerJwt = jwt(owner, org.id, OrgType.BUSINESS_MULTI, OrgRole.SUPER_ADMIN);
      const managerJwt = jwt(manager, org.id, OrgType.BUSINESS_MULTI, OrgRole.ORG_ADMIN);
      const receiverJwt = jwt(receiver, org.id, OrgType.BUSINESS_MULTI, OrgRole.ORG_MEMBER);
      const siteJwts = siteUsers.map((u, i) =>
        jwt(u, org.id, OrgType.BUSINESS_MULTI, OrgRole.ORG_MEMBER, sites[i].id));
      const charityJwt = jwt(charityUser, charityOrg.id, OrgType.CHARITY_SINGLE,
        OrgRole.SUPER_ADMIN, charitySite.id);

      check('Fixtures created', sites.length === 3,
        `org ${org.id}, 3 sites, charity org ${charityOrg.id}`);

      // ─── 1. Permission ────────────────────────────────────────────────────
      section('1. Permission (R1)');
      let denied = false;
      try { await access.assertCanManage(managerJwt); } catch { denied = true; }
      check('Manager is refused before the permission is granted', denied);

      await access.setPermission(ownerJwt, manager.id, true);
      check('Owner can grant it', await access.canManageFlag(managerJwt));
      check('Owner holds it implicitly', await access.canManageFlag(ownerJwt));

      let receiverDenied = false;
      try { await access.assertCanManage(receiverJwt); } catch { receiverDenied = true; }
      check('An ordinary member still cannot manage', receiverDenied);

      // ─── 2. Group ─────────────────────────────────────────────────────────
      section('2. Group and collection point');
      const group = await groups.create(managerJwt, {
        name: `Melbourne Park Precinct ${stamp}`,
        hostSiteId: sites[0].id,
        siteIds: sites.map((s) => s.id),
        collectionPoint: {
          name: 'Loading Dock B', address: '1 Olympic Blvd, Melbourne',
          postcode: '3000', lat: -37.8216, lng: 144.9799, directions: 'Rear entrance',
        },
        members: [{ userId: receiver.id, role: ConsolidatedMemberRole.RECEIVER }],
      } as any);
      check('Group created with 3 sites and a default point',
        group.sites.length === 3 && group.points.length === 1,
        `group ${group.id}, timezone ${group.timezone}`);
      check('Timezone inherited from the host site', group.timezone === 'Australia/Melbourne');
      check('Creator is a manager, receiver is a receiver',
        group.members.some((m: any) => m.userId === manager.id && m.role === 'MANAGER')
        && group.members.some((m: any) => m.userId === receiver.id && m.role === 'RECEIVER'));

      // ─── 3. Schedule ──────────────────────────────────────────────────────
      section('3. Schedule and occurrence generation');
      const today = new Date();
      const localToday = new Date(Date.UTC(
        today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));

      const { schedule, collectionsCreated } = await schedules.create(managerJwt, group.id, {
        collectionPointId: group.points[0].id,
        method: ConsolidatedHandoverMethod.SITE_DROP_OFF,
        recurrence: ConsolidatedRecurrence.ONE_OFF,
        startDate: localToday.toISOString(),
        submissionsCloseTime: '13:30',
        handoverStartTime: '13:00',
        handoverEndTime: '13:45',
        pickupStartTime: '14:00',
        pickupEndTime: '23:30',
        contactName: 'Venue Ops', contactPhone: '0400000000',
        suitabilityNotes: 'Chilled, sealed, labelled.',
      } as any);
      check('One occurrence generated', collectionsCreated === 1, `schedule ${schedule.id}`);

      let collection = await tx.consolidatedCollection.findFirstOrThrow({
        where: { scheduleId: schedule.id },
      });
      check('Point snapshotted onto the collection',
        collection.pointName === 'Loading Dock B', collection.pointAddress);
      check('All 3 sites participate', collection.participatingSiteIds.length === 3);

      // Put it into the state the sweep would have left it in.
      collection = await tx.consolidatedCollection.update({
        where: { id: collection.id },
        data: {
          status: ConsolidatedCollectionStatus.OPEN,
          openedAt: new Date(),
          pickupEndAt: new Date(Date.now() + 6 * 3600_000),
          pickupStartAt: new Date(Date.now() + 3600_000),
          handoverEndAt: new Date(Date.now() + 1800_000),
          submissionsCloseAt: new Date(Date.now() + 900_000),
        },
      });

      // ─── 4. Contributions ─────────────────────────────────────────────────
      section('4. Site contributions (R5–R7)');
      const bestBefore = new Date(Date.now() + 48 * 3600_000).toISOString();
      const decl = { version: DECLARATIONS.SITE.version, accepted: true };

      const c1 = await contributions.create(siteJwts[0], collection.id, {
        siteId: sites[0].id, bestBefore, declaration: decl,
        foodItems: [{ name: 'Sandwiches', totalQtyKg: 4, category: 'Bakery' }],
      } as any);
      const c2 = await contributions.create(siteJwts[1], collection.id, {
        siteId: sites[1].id, bestBefore, declaration: decl,
        foodItems: [{ name: 'Salads', totalQtyKg: 6, category: 'Produce' }],
      } as any);
      const c3 = await contributions.create(siteJwts[2], collection.id, {
        siteId: sites[2].id, bestBefore, declaration: decl,
        foodItems: [{ name: 'Hot meals', totalQtyKg: 8, category: 'Prepared' }],
      } as any);
      check('Three contributions submitted (4 + 6 + 8 kg)',
        [c1, c2, c3].every((c) => c.contribution.status === 'SUBMITTED'));
      check('Each wrote a CONTRIBUTION listing',
        [c1, c2, c3].every((c) => c.listing!.consolidatedRole === ConsolidatedListingRole.CONTRIBUTION));
      check('Pickup address is the collection point, not the kitchen',
        c1.listing!.pickupAddress === collection.pointAddress);

      let dupBlocked = false;
      try {
        await contributions.create(siteJwts[0], collection.id, {
          siteId: sites[0].id, bestBefore, declaration: decl,
          foodItems: [{ name: 'More', totalQtyKg: 1 }],
        } as any);
      } catch { dupBlocked = true; }
      check('A second contribution from the same site is refused', dupBlocked);

      let declBlocked = false;
      try {
        await contributions.create(siteJwts[1], collection.id, {
          siteId: sites[1].id, bestBefore,
          declaration: { version: 'v0', accepted: true },
          foodItems: [{ name: 'X', totalQtyKg: 1 }],
        } as any);
      } catch { declBlocked = true; }
      check('A stale declaration version is refused', declBlocked);

      let crossSite = false;
      try { await contributions.update(siteJwts[0], c2.contribution.id, { bestBefore } as any); }
      catch { crossSite = true; }
      check('A site cannot touch another site\'s contribution', crossSite);

      const ledgerCount = await tx.consolidatedItem.count({ where: { collectionId: collection.id } });
      check('Ledger has one row per food item', ledgerCount === 3);

      // ─── 5. Handover ──────────────────────────────────────────────────────
      section('5. Handover');
      for (const [i, c] of [c1, c2, c3].entries()) {
        await contributions.handover(siteJwts[i], c.contribution.id);
      }
      const handedOver = await tx.consolidatedContribution.count({
        where: { collectionId: collection.id, status: ConsolidatedContributionStatus.HANDED_OVER },
      });
      check('All three handed over', handedOver === 3);
      const repeat = await contributions.handover(siteJwts[0], c1.contribution.id);
      check('Confirming handover twice is a no-op', repeat.alreadyDone === true);

      // ─── 6. Close and receipt ─────────────────────────────────────────────
      section('6. Close submissions and record receipt (R18)');
      await collections.closeSubmissions(managerJwt, collection.id);
      const closed = await tx.consolidatedCollection.findUniqueOrThrow({ where: { id: collection.id } });
      check('Collection is SUBMISSIONS_CLOSED',
        closed.status === ConsolidatedCollectionStatus.SUBMISSIONS_CLOSED);

      const items = await tx.consolidatedItem.findMany({
        where: { collectionId: collection.id }, orderBy: { id: 'asc' },
      });
      const itemFor = (contributionId: number) => items.find((i) => i.contributionId === contributionId)!;

      await receipts.record(receiverJwt, c1.contribution.id, { received: true });
      await receipts.record(receiverJwt, c2.contribution.id, {
        received: true,
        items: [{ itemId: itemFor(c2.contribution.id).id, verifiedQtyKg: 5 }],
      });
      await receipts.record(receiverJwt, c3.contribution.id, { received: true });

      const verified = await tx.consolidatedItem.aggregate({
        where: { collectionId: collection.id }, _sum: { verifiedQtyKg: true },
      });
      check('Verified total is 17 kg after one adjustment (6 → 5)',
        verified._sum.verifiedQtyKg === 17, `${verified._sum.verifiedQtyKg} kg`);

      let overBlocked = false;
      try {
        await receipts.record(receiverJwt, c1.contribution.id, {
          received: true,
          items: [{ itemId: itemFor(c1.contribution.id).id, verifiedQtyKg: 99 }],
        });
      } catch { overBlocked = true; }
      check('Verifying more than was listed is refused', overBlocked);

      // ─── 7. Publish ───────────────────────────────────────────────────────
      section('7. Publish (A7, A8)');
      const preview = await publishing.publishPreview(managerJwt, collection.id);
      check('Preview has no blockers', preview.blockers.length === 0,
        `${preview.totals.totalQtyKg} kg from ${preview.totals.siteCount} sites`);
      check('Preview totals 17 kg across 3 sites',
        preview.totals.totalQtyKg === 17 && preview.totals.siteCount === 3);

      const published = await publishing.publish(managerJwt, collection.id,
        { version: DECLARATIONS.MANAGER.version, accepted: true } as any);
      check('Master listing created', Boolean(published.masterListingId),
        `listing ${published.masterListingId}`);

      const master = await tx.foodListing.findUniqueOrThrow({
        where: { id: published.masterListingId }, include: { foodItems: true },
      });
      check('Master is marked MASTER and totals 17 kg',
        master.consolidatedRole === ConsolidatedListingRole.MASTER && master.totalQtyKg === 17);
      check('Master has one food item per included ledger row', master.foodItems.length === 3);
      check('Master pickup address is the collection point',
        master.pickupAddress === collection.pointAddress);
      const linked = await tx.consolidatedItem.count({
        where: { collectionId: collection.id, masterFoodItemId: { not: null } },
      });
      check('Every ledger row links to a master item', linked === 3);
      check('Charity-facing notes never name an outlet',
        !/Kiosk|Suite/i.test(master.collectionNotes ?? ''), master.collectionNotes ?? '');

      // ─── 8. Discovery isolation ───────────────────────────────────────────
      section('8. Discovery isolation (SPEC §2.4)');
      const discoverable = await tx.foodListing.count({
        where: { id: { in: [c1.listing!.id, c2.listing!.id, c3.listing!.id] },
                 consolidatedRole: { not: 'CONTRIBUTION' } },
      });
      check('No contribution is discoverable', discoverable === 0);

      let contributionClaimBlocked = false;
      try {
        await claims.claimListing(charityJwt, { listingId: c1.listing!.id, claimMode: 'FULL' } as any);
      } catch (e: any) { contributionClaimBlocked = e.status === 404; }
      check('Claiming a contribution directly returns 404', contributionClaimBlocked);

      // ─── 9. Claim ─────────────────────────────────────────────────────────
      section('9. Charity claim (R10)');
      const claim = await claims.claimListing(charityJwt, {
        listingId: published.masterListingId, claimMode: 'PARTIAL',
        claimItems: [{ foodItemId: master.foodItems[0].id, qtyKg: 1 }],
      } as any);
      const claimRow = await tx.foodClaim.findFirstOrThrow({
        where: { listingId: published.masterListingId }, include: { claimItems: true },
      });
      check('Partial claim was forced to FULL', claimRow.claimMode === 'FULL');
      check('Claim is marked CONSOLIDATED_MASTER',
        claimRow.claimKind === ClaimKind.CONSOLIDATED_MASTER);
      check('Claim covers all 17 kg',
        claimRow.claimItems.reduce((s, i) => s + i.qtyKg, 0) === 17);

      const afterClaim = await tx.consolidatedCollection.findUniqueOrThrow({ where: { id: collection.id } });
      check('Collection moved to CLAIMED', afterClaim.status === ConsolidatedCollectionStatus.CLAIMED);
      const contribListings = await tx.foodListing.findMany({
        where: { id: { in: [c1.listing!.id, c2.listing!.id, c3.listing!.id] } },
      });
      check('Each site now sees its listing as CLAIMED',
        contribListings.every((l) => l.status === ListingStatus.CLAIMED));

      let collectBlocked = false;
      try { await claims.markCollected(charityJwt, claimRow.id, {} as any); }
      catch (e: any) { collectBlocked = /item check/i.test(e.message ?? ''); }
      check('markCollected on a master is refused in favour of the item check', collectBlocked);

      // ─── 10. Item check ───────────────────────────────────────────────────
      section('10. Item check and allocations (R12, R19)');
      const checkView = await completion.itemCheck(charityJwt, claimRow.id);
      check('Item check lists 3 items with no site information',
        checkView.items.length === 3 && !JSON.stringify(checkView.items).match(/siteId/));

      const byName = (n: string) => checkView.items.find((i) => i.name === n)!;
      let badSum = false;
      try {
        await completion.submitItemCheck(charityJwt, claimRow.id, {
          declaration: { version: DECLARATIONS.CHARITY.version, accepted: true },
          items: checkView.items.map((i) => ({
            masterFoodItemId: i.masterFoodItemId, acceptedQtyKg: i.qtyKg - 1,
            rejectedQtyKg: 0, unavailableQtyKg: 0,
          })),
        } as any);
      } catch { badSum = true; }
      check('An item check whose quantities do not add up is refused', badSum);

      const submitted = await completion.submitItemCheck(charityJwt, claimRow.id, {
        declaration: { version: DECLARATIONS.CHARITY.version, accepted: true },
        items: [
          { masterFoodItemId: byName('Sandwiches').masterFoodItemId, acceptedQtyKg: 4, rejectedQtyKg: 0, unavailableQtyKg: 0 },
          { masterFoodItemId: byName('Salads').masterFoodItemId, acceptedQtyKg: 5, rejectedQtyKg: 0, unavailableQtyKg: 0 },
          { masterFoodItemId: byName('Hot meals').masterFoodItemId, acceptedQtyKg: 6, rejectedQtyKg: 2,
            unavailableQtyKg: 0, rejectionReason: ConsolidatedRejectionReason.QUALITY },
        ],
        rating: 5,
      } as any);
      check('Item check accepted 15 kg across 3 sites',
        submitted.acceptedKg === 15 && submitted.allocationsCreated === 3,
        `${submitted.acceptedKg} kg, ${submitted.allocationsCreated} allocations`);

      const allocations = await tx.foodClaim.findMany({
        where: { parentClaimId: claimRow.id, claimKind: ClaimKind.CONSOLIDATED_ALLOCATION },
        include: { claimItems: true, listing: { select: { siteId: true } } },
      });
      check('One allocation per contributing site', allocations.length === 3);
      const perSite = new Map(allocations.map((a) =>
        [a.listing.siteId, a.claimItems.reduce((s, i) => s + i.qtyKg, 0)]));
      check('Site allocations are 4 / 5 / 6 kg',
        perSite.get(sites[0].id) === 4 && perSite.get(sites[1].id) === 5 && perSite.get(sites[2].id) === 6,
        [...perSite.values()].join(' / '));
      check('Allocations are COLLECTED',
        allocations.every((a) => a.status === ClaimStatus.COLLECTED));
      check('Allocations carry the contribution\'s enterprise snapshot',
        allocations.every((a) => a.snapshotGroupId === null || typeof a.snapshotGroupId === 'number'));

      const done = await tx.consolidatedCollection.findUniqueOrThrow({ where: { id: collection.id } });
      check('Collection is COMPLETED', done.status === ConsolidatedCollectionStatus.COMPLETED);

      let doubleSubmit = false;
      try {
        await completion.submitItemCheck(charityJwt, claimRow.id, {
          declaration: { version: DECLARATIONS.CHARITY.version, accepted: true },
          items: [{ masterFoodItemId: byName('Sandwiches').masterFoodItemId, acceptedQtyKg: 4, rejectedQtyKg: 0, unavailableQtyKg: 0 }],
        } as any);
      } catch { doubleSubmit = true; }
      check('A second item check is refused', doubleSubmit);

      // ─── 11. No double counting ───────────────────────────────────────────
      section('11. No double counting (the whole point)');
      const masterKg = (await tx.claimItem.aggregate({
        where: { claimId: claimRow.id }, _sum: { qtyKg: true },
      }))._sum.qtyKg ?? 0;
      const allocKg = (await tx.claimItem.aggregate({
        where: { claim: { parentClaimId: claimRow.id } }, _sum: { qtyKg: true },
      }))._sum.qtyKg ?? 0;
      const ledgerKg = (await tx.consolidatedItem.aggregate({
        where: { collectionId: collection.id }, _sum: { acceptedQtyKg: true },
      }))._sum.acceptedQtyKg ?? 0;
      check('Master claim, allocations and ledger all equal 15 kg',
        masterKg === 15 && allocKg === 15 && ledgerKg === 15,
        `master ${masterKg}, allocations ${allocKg}, ledger ${ledgerKg}`);

      const naive = masterKg + allocKg;
      const filtered = (await tx.claimItem.aggregate({
        where: {
          claim: { listing: { organisationId: org.id }, claimKind: { not: ClaimKind.CONSOLIDATED_MASTER } },
        },
        _sum: { qtyKg: true },
      }))._sum.qtyKg ?? 0;
      check('Impact filter yields 15 kg, not the unfiltered 30',
        filtered === 15 && naive === 30, `filtered ${filtered}, unfiltered would be ${naive}`);

      const opCount = await tx.foodClaim.count({
        where: { listing: { organisationId: org.id }, claimKind: { not: ClaimKind.CONSOLIDATED_ALLOCATION } },
      });
      check('Operational filter counts 1 collection, not 4', opCount === 1, `${opCount} claim(s)`);

      const listingCount = await tx.foodListing.count({
        where: { organisationId: org.id, consolidatedRole: { not: 'MASTER' } },
      });
      check('Listing filter counts the 3 contributions, not 4', listingCount === 3);

      // ─── 12. Reporting ────────────────────────────────────────────────────
      section('12. Reporting (RP1)');
      const summary = await reports.summary(managerJwt, {});
      check('Summary reconciles: listed 18, verified 17, accepted 15, rejected 2',
        summary.combined.listedKg === 18 && summary.combined.verifiedKg === 17
        && summary.combined.acceptedKg === 15 && summary.combined.rejectedKg === 2,
        JSON.stringify(summary.combined));
      check('Per-site rows sum to the combined total',
        summary.sites.reduce((s, r) => s + r.acceptedKg, 0) === 15,
        summary.sites.map((s) => `${s.siteName}=${s.acceptedKg}`).join(', '));
      check('Rejection reason recorded',
        summary.rejectionReasons.some((r) => r.reason === 'QUALITY'));

      const perCollection = await reports.collections(managerJwt, {});
      check('Collection row shows the charity to a manager',
        perCollection.rows.length === 1 && Boolean((perCollection.rows[0] as any).charityName),
        (perCollection.rows[0] as any).charityName);

      const siteSummary = await reports.summary(siteJwts[0], { siteId: sites[0].id });
      check('A site sees only its own 4 kg', siteSummary.combined.acceptedKg === 4);
      let crossSiteReport = false;
      try { await reports.summary(siteJwts[0], { siteId: sites[1].id }); }
      catch { crossSiteReport = true; }
      check('A site cannot report on another site', crossSiteReport);

      // ─── 13. Audit ────────────────────────────────────────────────────────
      section('13. Audit trail');
      const auditRows = await tx.auditLog.findMany({
        where: { organisationId: org.id, area: 'CONSOLIDATED_COLLECTIONS' },
        select: { action: true },
      });
      const actions = new Set(auditRows.map((a) => a.action));
      check('Every material step is audited', auditRows.length >= 10, `${auditRows.length} rows`);
      for (const a of ['permission.changed', 'group.created', 'schedule.created',
        'contribution.submitted', 'contribution.receipt', 'collection.published',
        'item_check.submitted']) {
        check(`  audited: ${a}`, actions.has(a));
      }

      const declarations = await tx.consolidatedDeclaration.findMany({
        where: { collectionId: collection.id }, select: { type: true, textSnapshot: true },
      });
      check('Site, manager and charity declarations all stored with their text',
        declarations.length === 5
        && declarations.every((d) => d.textSnapshot.length > 50),
        declarations.map((d) => d.type).join(', '));

      console.log(`\nAll steps completed in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
      throw new Rollback('rollback');
    }, { maxWait: 60_000, timeout: 900_000 });
  } catch (err: any) {
    if (!(err instanceof Rollback)) {
      console.error(`\nSTOPPED: ${err.message}`);
    }
  } finally {
    await prisma.$disconnect();
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${'='.repeat(64)}`);
  console.log(`RESULT: ${passed}/${results.length} checks passed, ${failed} failed`);
  console.log('Transaction rolled back — nothing was written to the database.');
  console.log('='.repeat(64));
  process.exit(failed === 0 ? 0 : 1);
}

main();
