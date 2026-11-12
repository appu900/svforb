import { Injectable, NotFoundException } from '@nestjs/common';
import {
  AuditArea,
  ClaimKind,
  ConsolidatedChangeRequestStatus,
  ConsolidatedCollectionStatus,
  ConsolidatedContributionStatus,
  ConsolidatedDeclarationType,
  ConsolidatedMemberRole,
  ConsolidatedReceiptStatus,
  OrgRole,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import { ConsolidatedAccessService } from './consolidated-access.service';
import { ConsolidatedGroupService } from './consolidated-group.service';
import { ConsolidatedPublishService } from './consolidated-publish.service';

/**
 * Read models for the mobile app and the web portal (SPEC §7.3–7.6).
 *
 * The write services return whatever row they touched; screens need a stable,
 * documented shape instead. Everything a screen reads goes through here, so the
 * contract in SPEC.md has exactly one implementation.
 */

export type CollectionTab = 'upcoming' | 'active' | 'past';

const TAB_STATUSES: Record<CollectionTab, ConsolidatedCollectionStatus[]> = {
  upcoming: [ConsolidatedCollectionStatus.SCHEDULED],
  active: [
    ConsolidatedCollectionStatus.OPEN,
    ConsolidatedCollectionStatus.SUBMISSIONS_CLOSED,
    ConsolidatedCollectionStatus.PUBLISHED,
    ConsolidatedCollectionStatus.CLAIMED,
    ConsolidatedCollectionStatus.AWAITING_ITEM_CHECK,
  ],
  past: [
    ConsolidatedCollectionStatus.COMPLETED,
    ConsolidatedCollectionStatus.CANCELLED,
    ConsolidatedCollectionStatus.EXPIRED,
  ],
};

/** A site has put food into the collection (whatever happened to it after). */
const CONTRIBUTED: ConsolidatedContributionStatus[] = [
  ConsolidatedContributionStatus.SUBMITTED,
  ConsolidatedContributionStatus.LATE_PENDING_APPROVAL,
  ConsolidatedContributionStatus.HANDED_OVER,
  ConsolidatedContributionStatus.RECEIVED,
  ConsolidatedContributionStatus.NOT_RECEIVED,
  ConsolidatedContributionStatus.EXCLUDED,
  ConsolidatedContributionStatus.COMPLETED,
];

const AWAITING_HANDOVER: ConsolidatedContributionStatus[] = [ConsolidatedContributionStatus.SUBMITTED];

const contributionInclude = {
  site: { select: { id: true, name: true, organisationName: true } },
  listing: {
    select: {
      id: true,
      bestBefore: true,
      needsRefrigeration: true,
      needsAmbient: true,
      needsFreezer: true,
      needsHot: true,
      needsReheating: true,
      allergens: true,
      collectionNotes: true,
      photoUrls: true,
      foodItems: {
        select: { id: true, name: true, category: true, totalQtyKg: true, quantityDescription: true },
        orderBy: { id: 'asc' },
      },
    },
  },
  changeRequests: {
    where: { status: ConsolidatedChangeRequestStatus.PENDING },
    select: { id: true },
    orderBy: { createdAt: 'desc' },
    take: 1,
  },
} satisfies Prisma.ConsolidatedContributionInclude;

type ContributionRow = Prisma.ConsolidatedContributionGetPayload<{ include: typeof contributionInclude }>;
type ItemRow = Prisma.ConsolidatedItemGetPayload<object>;
type CollectionRow = Prisma.ConsolidatedCollectionGetPayload<{
  include: { group: { select: { id: true; name: true } } };
}>;
type Person = { id: number; name: string } | null;

function dateKey(value: Date | null | undefined): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

function hhmm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function round(value: number): number {
  return Number(value.toFixed(2));
}

function siteName(site: { name: string | null; organisationName: string | null } | null | undefined): string {
  return site?.name || site?.organisationName || 'Site';
}

@Injectable()
export class ConsolidatedViewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ConsolidatedAccessService,
    private readonly publishing: ConsolidatedPublishService,
    private readonly groups: ConsolidatedGroupService,
  ) {}

  // ─── Who is asking ─────────────────────────────────────────────────────────

  private async passes(check: () => Promise<unknown>): Promise<boolean> {
    try {
      await check();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Manager, receiver, or a site user who can only see their own sites.
   * A caller who is none of these gets a 404 — nothing leaks through the error.
   */
  private async roleFor(caller: Jwtpayload, groupId: number, participatingSiteIds: number[]) {
    const canManage = await this.passes(() => this.access.assertManager(caller, groupId));
    const canReceive = canManage || (await this.passes(() => this.access.assertReceiver(caller, groupId)));
    if (canReceive) return { canManage, canReceive, siteScope: null as number[] | null };

    const reach = await this.access.callerSiteIds(caller);
    const scope = reach === null ? participatingSiteIds : participatingSiteIds.filter((id) => reach.includes(id));
    if (scope.length === 0) throw new NotFoundException('Collection not found.');
    return { canManage: false, canReceive: false, siteScope: scope };
  }

  private async people(ids: (number | null | undefined)[]): Promise<Map<number, string>> {
    const unique = [...new Set(ids.filter((id): id is number => typeof id === 'number'))];
    if (!unique.length) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, firstName: true, lastName: true },
    });
    return new Map(users.map((u) => [u.id, `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || 'User']));
  }

  private person(names: Map<number, string>, id: number | null | undefined): Person {
    if (typeof id !== 'number') return null;
    return { id, name: names.get(id) ?? 'User' };
  }

  // ─── Shared pieces ─────────────────────────────────────────────────────────

  private point(collection: CollectionRow) {
    return {
      id: collection.collectionPointId,
      name: collection.pointName,
      address: collection.pointAddress,
      postcode: collection.pointPostcode,
      lat: collection.pointLat,
      lng: collection.pointLng,
      directions: collection.pointDirections,
    };
  }

  private times(collection: CollectionRow) {
    return {
      opensAt: collection.opensAt,
      submissionsCloseAt: collection.submissionsCloseAt,
      handoverStartAt: collection.handoverStartAt,
      handoverEndAt: collection.handoverEndAt,
      pickupStartAt: collection.pickupStartAt,
      pickupEndAt: collection.pickupEndAt,
      reopenedUntil: collection.reopenedUntil,
    };
  }

  private exceptions(row: ContributionRow, collection: CollectionRow, now: Date): string[] {
    const out: string[] = [];
    if (row.isLate) out.push('LATE');
    if (row.handoverAt && row.handoverAt > collection.handoverEndAt) out.push('LATE_HANDOVER');
    if (AWAITING_HANDOVER.includes(row.status) && now > collection.handoverEndAt) out.push('OVERDUE');
    if (row.receiptStatus === ConsolidatedReceiptStatus.NOT_RECEIVED) out.push('NOT_RECEIVED');
    if (row.changeRequests.length) out.push('CHANGE_REQUESTED');
    return out;
  }

  private contributionRow(
    row: ContributionRow,
    ledger: ItemRow[],
    collection: CollectionRow,
    names: Map<number, string>,
    siteDeclarations: Map<number, { version: string; acceptedAt: Date }>,
    now: Date,
  ) {
    const listing = row.listing;
    const sourceItems = new Map((listing?.foodItems ?? []).map((item) => [item.id, item]));
    const mine = ledger.filter((item) => item.contributionId === row.id);

    // The ledger is the record; a withdrawn contribution has none, so fall back
    // to what the site listed so the row still says what it was.
    const items = mine.length
      ? mine.map((item) => ({
          itemId: item.id,
          foodItemId: item.sourceFoodItemId,
          name: item.name,
          category: item.category,
          quantityDescription: sourceItems.get(item.sourceFoodItemId)?.quantityDescription ?? null,
          submittedQtyKg: item.submittedQtyKg,
          verifiedQtyKg: item.verifiedQtyKg,
          acceptedQtyKg: item.acceptedQtyKg,
          rejectedQtyKg: item.rejectedQtyKg,
          unavailableQtyKg: item.unavailableQtyKg,
          rejectionReason: item.rejectionReason,
          outcome: item.outcome,
          bestBefore: listing?.bestBefore ?? null,
        }))
      : (listing?.foodItems ?? []).map((item) => ({
          itemId: null,
          foodItemId: item.id,
          name: item.name,
          category: item.category,
          quantityDescription: item.quantityDescription,
          submittedQtyKg: item.totalQtyKg,
          verifiedQtyKg: null,
          acceptedQtyKg: null,
          rejectedQtyKg: null,
          unavailableQtyKg: null,
          rejectionReason: null,
          outcome: null,
          bestBefore: listing?.bestBefore ?? null,
        }));

    const declaration = siteDeclarations.get(row.id);

    return {
      id: row.id,
      site: { id: row.siteId, name: siteName(row.site) },
      listingId: row.listingId,
      status: row.status,
      submittedAt: row.submittedAt,
      submittedBy: this.person(names, row.submittedByUserId),
      isLate: row.isLate,
      handover: row.handoverAt ? { at: row.handoverAt, by: this.person(names, row.handoverByUserId) } : null,
      receipt: {
        status: row.receiptStatus,
        at: row.receiptAt,
        by: this.person(names, row.receiptByUserId),
        note: row.receiptNote,
      },
      excluded: row.excludedAt ? { at: row.excludedAt, reason: row.excludeReason } : null,
      declaration: declaration ? { version: declaration.version, at: declaration.acceptedAt } : null,
      items,
      storage: listing
        ? {
            refrigeration: listing.needsRefrigeration,
            ambient: listing.needsAmbient,
            freezer: listing.needsFreezer,
            hot: listing.needsHot,
            reheating: listing.needsReheating,
          }
        : null,
      allergens: listing?.allergens ?? [],
      photoUrls: listing?.photoUrls ?? [],
      collectionNotes: listing?.collectionNotes ?? null,
      bestBefore: listing?.bestBefore ?? null,
      pendingChangeRequestId: row.changeRequests[0]?.id ?? null,
      exceptions: this.exceptions(row, collection, now),
    };
  }

  private async loadCollection(caller: Jwtpayload, collectionId: number) {
    const collection = await this.prisma.consolidatedCollection.findFirst({
      where: { id: collectionId, organisationId: caller.orgId },
      include: { group: { select: { id: true, name: true } } },
    });
    if (!collection) throw new NotFoundException('Collection not found.');
    return collection;
  }

  // ─── Dashboard (SPEC §7.6) ─────────────────────────────────────────────────

  async dashboard(caller: Jwtpayload, collectionId: number) {
    const collection = await this.loadCollection(caller, collectionId);
    const role = await this.roleFor(caller, collection.groupId, collection.participatingSiteIds);
    const now = new Date();

    const siteFilter = role.siteScope ? { siteId: { in: role.siteScope } } : {};
    const [contributions, ledger, declarations] = await Promise.all([
      this.prisma.consolidatedContribution.findMany({
        where: { collectionId, ...siteFilter },
        include: contributionInclude,
        orderBy: { id: 'asc' },
      }),
      this.prisma.consolidatedItem.findMany({
        where: { collectionId, ...siteFilter },
        orderBy: { id: 'asc' },
      }),
      this.prisma.consolidatedDeclaration.findMany({
        where: { collectionId },
        select: { type: true, version: true, acceptedAt: true, contributionId: true, userId: true },
      }),
    ]);

    const siteDeclarations = new Map(
      declarations
        .filter((d) => d.type === ConsolidatedDeclarationType.SITE && d.contributionId)
        .map((d) => [d.contributionId!, { version: d.version, acceptedAt: d.acceptedAt }]),
    );
    const managerDeclaration = declarations.find((d) => d.type === ConsolidatedDeclarationType.MANAGER);

    const names = await this.people([
      ...contributions.flatMap((c) => [c.submittedByUserId, c.handoverByUserId, c.receiptByUserId]),
      collection.publishedByUserId,
    ]);

    const rows = contributions.map((row) =>
      this.contributionRow(row, ledger, collection, names, siteDeclarations, now),
    );

    const base = {
      id: collection.id,
      status: collection.status,
      method: collection.method,
      timezone: collection.timezone,
      scheduleId: collection.scheduleId,
      scheduledDate: dateKey(collection.scheduledDate),
      group: collection.group,
      point: this.point(collection),
      times: this.times(collection),
      contact: { name: collection.contactName, phone: collection.contactPhone },
      instructions: collection.instructions,
      suitabilityNotes: collection.suitabilityNotes,
      participatingSiteIds: collection.participatingSiteIds,
      cancelReason: collection.cancelReason,
    };

    // A site user sees the event and their own food — never other outlets' data.
    if (role.siteScope) {
      return {
        ...base,
        contributions: rows,
        publication: null,
        claim: null,
        pendingMaterialChange: null,
        permissions: { canManage: false, canReceive: false, canPublish: false, publishBlockers: [] },
      };
    }

    const contributed = contributions.filter((c) => CONTRIBUTED.includes(c.status));
    const contributedSites = new Set(contributed.map((c) => c.siteId));
    const missingIds = collection.participatingSiteIds.filter((id) => !contributedSites.has(id));
    const missingSites = missingIds.length
      ? await this.prisma.site.findMany({
          where: { id: { in: missingIds } },
          select: { id: true, name: true, organisationName: true },
        })
      : [];

    const liveLedger = ledger.filter((item) =>
      contributed.some((c) => c.id === item.contributionId),
    );
    const sum = (pick: (item: ItemRow) => number | null) => {
      const values = liveLedger.map(pick).filter((v): v is number => v !== null);
      return values.length ? round(values.reduce((a, b) => a + b, 0)) : null;
    };
    const completed = collection.status === ConsolidatedCollectionStatus.COMPLETED;

    const [claim, pendingChange] = await Promise.all([
      collection.masterListingId
        ? this.prisma.foodClaim.findFirst({
            where: { listingId: collection.masterListingId, claimKind: ClaimKind.CONSOLIDATED_MASTER },
            orderBy: [{ createdAt: 'desc' }],
            select: {
              id: true,
              status: true,
              createdAt: true,
              collectedAt: true,
              claimantOrg: { select: { name: true } },
              claimantSite: { select: { organisationName: true, contactName: true, contactMobile: true } },
              driverPickups: {
                orderBy: { createdAt: 'desc' },
                take: 1,
                select: {
                  status: true,
                  driver: { select: { firstName: true, lastName: true } },
                },
              },
            },
          })
        : null,
      this.prisma.consolidatedChange.findFirst({
        where: { collectionId, isMaterial: true, acknowledgedAt: null },
        orderBy: { createdAt: 'desc' },
        select: { id: true, summary: true, createdAt: true },
      }),
    ]);
    const driver = claim?.driverPickups[0];

    let publishBlockers: string[] = [];
    if (role.canManage && collection.status === ConsolidatedCollectionStatus.SUBMISSIONS_CLOSED) {
      const preview = await this.publishing.publishPreview(caller, collectionId);
      publishBlockers = preview.blockers.map((b) => b.message);
    }

    return {
      ...base,
      totals: {
        submittedKg: sum((i) => i.submittedQtyKg),
        verifiedKg: sum((i) => i.verifiedQtyKg),
        acceptedKg: completed ? sum((i) => i.acceptedQtyKg) ?? 0 : null,
        rejectedKg: completed ? sum((i) => i.rejectedQtyKg) ?? 0 : null,
        unavailableKg: completed ? sum((i) => i.unavailableQtyKg) ?? 0 : null,
      },
      counts: {
        participating: collection.participatingSiteIds.length,
        submitted: contributedSites.size,
        handedOver: contributed.filter((c) => c.handoverAt).length,
        received: contributed.filter((c) => c.receiptStatus === ConsolidatedReceiptStatus.RECEIVED).length,
        notReceived: contributed.filter((c) => c.receiptStatus === ConsolidatedReceiptStatus.NOT_RECEIVED).length,
        noContribution: missingIds.length,
        late: contributed.filter((c) => c.isLate).length,
      },
      contributions: rows,
      sitesWithoutContribution: missingSites.map((s) => ({ id: s.id, name: siteName(s) })),
      publication: {
        masterListingId: collection.masterListingId,
        publishedAt: collection.publishedAt,
        publishedBy: this.person(names, collection.publishedByUserId),
        declarationVersion: managerDeclaration?.version ?? null,
      },
      claim: claim
        ? {
            id: claim.id,
            status: claim.status,
            charityName: claim.claimantOrg?.name ?? claim.claimantSite?.organisationName ?? null,
            claimedAt: claim.createdAt,
            collectedAt: claim.collectedAt,
            driverPickup: driver
              ? {
                  status: driver.status,
                  driverName: driver.driver
                    ? `${driver.driver.firstName ?? ''} ${driver.driver.lastName ?? ''}`.trim() || null
                    : null,
                }
              : null,
          }
        : null,
      pendingMaterialChange: pendingChange,
      permissions: {
        canManage: role.canManage,
        canReceive: role.canReceive,
        canPublish:
          role.canManage &&
          collection.status === ConsolidatedCollectionStatus.SUBMISSIONS_CLOSED &&
          publishBlockers.length === 0,
        publishBlockers,
      },
    };
  }

  // ─── Collections list (SPEC §7.3) ──────────────────────────────────────────

  /** Groups this caller runs or receives for. The org owner sees every group. */
  private async visibleGroupIds(caller: Jwtpayload): Promise<number[] | null> {
    if (caller.orgRole === OrgRole.SUPER_ADMIN) return null;
    const rows = await this.prisma.consolidatedGroupMember.findMany({
      where: { userId: caller.sub, group: { organisationId: caller.orgId } },
      select: { groupId: true },
    });
    return [...new Set(rows.map((r) => r.groupId))];
  }

  async listCollections(
    caller: Jwtpayload,
    query: { tab?: CollectionTab; groupId?: number; page?: number; limit?: number },
  ) {
    this.access.assertProductAccess(caller);
    const tab: CollectionTab = query.tab && TAB_STATUSES[query.tab] ? query.tab : 'active';
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));

    const visible = await this.visibleGroupIds(caller);
    if (visible !== null && visible.length === 0) {
      return { items: [], page, limit, total: 0, totalPages: 1 };
    }
    if (query.groupId && visible !== null && !visible.includes(query.groupId)) {
      return { items: [], page, limit, total: 0, totalPages: 1 };
    }

    const where: Prisma.ConsolidatedCollectionWhereInput = {
      organisationId: caller.orgId,
      status: { in: TAB_STATUSES[tab] },
      ...(query.groupId
        ? { groupId: query.groupId }
        : visible !== null
          ? { groupId: { in: visible } }
          : {}),
    };
    const direction = tab === 'past' ? 'desc' : 'asc';

    const [rows, total] = await Promise.all([
      this.prisma.consolidatedCollection.findMany({
        where,
        orderBy: [{ scheduledDate: direction }, { pickupStartAt: direction }],
        skip: (page - 1) * limit,
        take: limit,
        include: {
          group: { select: { id: true, name: true } },
          contributions: { select: { siteId: true, status: true } },
          items: { select: { contributionId: true, submittedQtyKg: true, verifiedQtyKg: true, acceptedQtyKg: true } },
        },
      }),
      this.prisma.consolidatedCollection.count({ where }),
    ]);

    const items = rows.map((row) => {
      const live = row.contributions.filter((c) => CONTRIBUTED.includes(c.status));
      const verified = row.items.map((i) => i.verifiedQtyKg).filter((v): v is number => v !== null);
      return {
        id: row.id,
        status: row.status,
        method: row.method,
        timezone: row.timezone,
        scheduledDate: dateKey(row.scheduledDate),
        group: row.group,
        point: { id: row.collectionPointId, name: row.pointName, address: row.pointAddress },
        times: this.times(row),
        counts: {
          participating: row.participatingSiteIds.length,
          submitted: new Set(live.map((c) => c.siteId)).size,
        },
        totals: {
          submittedKg: round(row.items.reduce((sum, i) => sum + i.submittedQtyKg, 0)),
          verifiedKg: verified.length ? round(verified.reduce((a, b) => a + b, 0)) : null,
        },
      };
    });

    return { items, page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
  }

  // ─── Contribution (SPEC §7.4) ──────────────────────────────────────────────

  async contribution(caller: Jwtpayload, id: number) {
    const row = await this.prisma.consolidatedContribution.findFirst({
      where: { id, collection: { organisationId: caller.orgId } },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('Contribution not found.');
    return this.contributionView(caller, row.id);
  }

  async contributionByListing(caller: Jwtpayload, listingId: number) {
    const row = await this.prisma.consolidatedContribution.findFirst({
      where: { listingId, collection: { organisationId: caller.orgId } },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('Contribution not found.');
    return this.contributionView(caller, row.id);
  }

  private async contributionView(caller: Jwtpayload, id: number) {
    const row = await this.prisma.consolidatedContribution.findUniqueOrThrow({
      where: { id },
      include: {
        ...contributionInclude,
        collection: { include: { group: { select: { id: true, name: true } } } },
      },
    });
    const collection = row.collection;

    const canManage = await this.passes(() => this.access.assertManager(caller, collection.groupId));
    const canReceive = canManage || (await this.passes(() => this.access.assertReceiver(caller, collection.groupId)));
    if (!canReceive) {
      // Another site's contribution is a 404, not a 403.
      const ownSite = await this.passes(() => this.access.assertSiteUser(caller, row.siteId));
      if (!ownSite) throw new NotFoundException('Contribution not found.');
    }

    const [ledger, declaration] = await Promise.all([
      this.prisma.consolidatedItem.findMany({ where: { contributionId: id }, orderBy: { id: 'asc' } }),
      this.prisma.consolidatedDeclaration.findFirst({
        where: { contributionId: id, type: ConsolidatedDeclarationType.SITE },
        orderBy: { acceptedAt: 'desc' },
        select: { version: true, acceptedAt: true },
      }),
    ]);
    const names = await this.people([row.submittedByUserId, row.handoverByUserId, row.receiptByUserId]);
    const declarations = new Map(declaration ? [[id, declaration]] : []);

    return {
      contribution: this.contributionRow(row, ledger, collection, names, declarations, new Date()),
      collection: {
        id: collection.id,
        status: collection.status,
        method: collection.method,
        timezone: collection.timezone,
        scheduledDate: dateKey(collection.scheduledDate),
        group: collection.group,
        point: this.point(collection),
        times: this.times(collection),
        contact: { name: collection.contactName, phone: collection.contactPhone },
        suitabilityNotes: collection.suitabilityNotes,
        instructions: collection.instructions,
        publishedAt: collection.publishedAt,
      },
      permissions: { canManage, canReceive },
      pendingChangeStatus: row.changeRequests.length ? 'PENDING_APPROVAL' : null,
    };
  }

  // ─── Schedule (SPEC §7.3) ──────────────────────────────────────────────────

  async schedule(caller: Jwtpayload, scheduleId: number) {
    const schedule = await this.prisma.consolidatedSchedule.findFirst({
      where: { id: scheduleId, group: { organisationId: caller.orgId } },
    });
    if (!schedule) throw new NotFoundException('Schedule not found.');
    await this.access.assertManager(caller, schedule.groupId);

    return {
      id: schedule.id,
      groupId: schedule.groupId,
      collectionPointId: schedule.collectionPointId,
      method: schedule.method,
      recurrence: schedule.recurrence,
      status: schedule.status,
      timezone: schedule.timezone,
      startDate: dateKey(schedule.startDate),
      endDate: dateKey(schedule.endDate),
      daysOfWeek: schedule.daysOfWeek,
      customDates: schedule.customDates.map((d) => dateKey(d)),
      opensDaysBefore: schedule.opensDaysBefore,
      times: {
        submissionsClose: hhmm(schedule.submissionsCloseMinutes),
        handoverStart: hhmm(schedule.handoverStartMinutes),
        handoverEnd: hhmm(schedule.handoverEndMinutes),
        pickupStart: hhmm(schedule.pickupStartMinutes),
        pickupEnd: hhmm(schedule.pickupEndMinutes),
      },
      contactName: schedule.contactName,
      contactPhone: schedule.contactPhone,
      instructions: schedule.instructions,
      suitabilityNotes: schedule.suitabilityNotes,
      participatingSiteIds: schedule.participatingSiteIds,
    };
  }

  // ─── Audit (SPEC §7.3) ─────────────────────────────────────────────────────

  async audit(caller: Jwtpayload, collectionId: number) {
    const collection = await this.loadCollection(caller, collectionId);
    await this.access.assertManager(caller, collection.groupId);

    const contributionIds = (
      await this.prisma.consolidatedContribution.findMany({
        where: { collectionId },
        select: { id: true },
      })
    ).map((c) => c.id);

    const entries = await this.prisma.auditLog.findMany({
      where: {
        organisationId: collection.organisationId,
        area: AuditArea.CONSOLIDATED_COLLECTIONS,
        OR: [
          { entityType: 'ConsolidatedCollection', entityId: collectionId },
          ...(contributionIds.length
            ? [{ entityType: 'ConsolidatedContribution', entityId: { in: contributionIds } }]
            : []),
          ...(collection.scheduleId
            ? [{ entityType: 'ConsolidatedSchedule', entityId: collection.scheduleId }]
            : []),
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { id: true, createdAt: true, actorName: true, action: true, summary: true },
    });

    return entries.map((e) => ({
      id: e.id,
      at: e.createdAt,
      actorName: e.actorName,
      action: e.summary,
      code: e.action,
    }));
  }

  // ─── Access summary for UI gating (SPEC §7.1) ──────────────────────────────

  async me(caller: Jwtpayload) {
    const summary = await this.access.meSummary(caller);
    const managed = summary.groups.filter((g) => g.role === ConsolidatedMemberRole.MANAGER).map((g) => g.groupId);
    const received = summary.groups.filter((g) => g.role === ConsolidatedMemberRole.RECEIVER).map((g) => g.groupId);

    let siteIdsWithOpenCollections: number[] = [];
    if (caller.orgId) {
      const open = await this.prisma.consolidatedCollection.findMany({
        where: {
          organisationId: caller.orgId,
          status: ConsolidatedCollectionStatus.OPEN,
        },
        select: { participatingSiteIds: true },
      });
      const all = new Set(open.flatMap((c) => c.participatingSiteIds));
      siteIdsWithOpenCollections = [...all].filter(
        (id) => summary.siteIds === null || summary.siteIds.includes(id),
      );
    }

    const pendingInvitationCount = await this.groups
      .listInvitations(caller)
      .then((rows) => rows.length)
      .catch(() => 0);

    return {
      ...summary,
      pendingInvitationCount,
      managedGroupIds: [...new Set(managed)],
      receiverGroupIds: [...new Set(received)],
      siteIdsWithOpenCollections,
    };
  }
}
