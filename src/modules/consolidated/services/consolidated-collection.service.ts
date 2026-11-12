import {
  BadRequestException, ConflictException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import {
  ClaimStatus, ConsolidatedCollectionStatus, ConsolidatedContributionStatus,
  ConsolidatedItemOutcome, ConsolidatedReceiptStatus, DriverPickupStatus,
  ListingStatus, Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import { instantForLocalTime, parseLocalTime } from '../../connections/connection.schedule';
import { CONSOLIDATED_ERROR } from '../consolidated.errors';
import {
  CancelCollectionDto, ReopenSubmissionsDto, UpdateCollectionDto,
} from '../dto/collection.dto';
import { ConsolidatedAccessService } from './consolidated-access.service';
import { CONSOLIDATED_ACTION, ConsolidatedAuditService, RequestContext } from './consolidated-audit.service';
import { ConsolidatedNotifierService } from './consolidated-notifier.service';

type Db = PrismaService | Prisma.TransactionClient;

/** Nothing more can happen to a collection in one of these. */
export const FINAL_STATUSES: ConsolidatedCollectionStatus[] = [
  ConsolidatedCollectionStatus.COMPLETED,
  ConsolidatedCollectionStatus.CANCELLED,
  ConsolidatedCollectionStatus.EXPIRED,
];

/** Contribution states that a cancellation still has to clean up. */
const NON_FINAL_CONTRIBUTIONS: ConsolidatedContributionStatus[] = [
  ConsolidatedContributionStatus.SUBMITTED,
  ConsolidatedContributionStatus.LATE_PENDING_APPROVAL,
  ConsolidatedContributionStatus.HANDED_OVER,
  ConsolidatedContributionStatus.RECEIVED,
  ConsolidatedContributionStatus.NOT_RECEIVED,
];

/**
 * The lifecycle of one collection: opening, closing, reopening and cancelling.
 *
 * Publishing lives in the publish service, because building the charity-facing
 * listing is a different job from moving this row between states.
 */
@Injectable()
export class ConsolidatedCollectionService {
  private readonly logger = new Logger(ConsolidatedCollectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ConsolidatedAccessService,
    private readonly audit: ConsolidatedAuditService,
    private readonly notifier: ConsolidatedNotifierService,
  ) {}

  // ─── Read ──────────────────────────────────────────────────────────────────

  private async load(caller: Jwtpayload, collectionId: number) {
    const collection = await this.prisma.consolidatedCollection.findFirst({
      where: { id: collectionId, organisationId: caller.orgId },
      include: { group: { select: { id: true, name: true, organisationId: true } } },
    });
    if (!collection) throw new NotFoundException('Collection not found.');
    return collection;
  }

  async get(caller: Jwtpayload, collectionId: number) {
    const collection = await this.load(caller, collectionId);
    await this.access.assertReceiver(caller, collection.groupId);

    return this.prisma.consolidatedCollection.findUniqueOrThrow({
      where: { id: collectionId },
      include: {
        group: { select: { id: true, name: true, timezone: true } },
        contributions: {
          include: {
            site: { select: { id: true, name: true, organisationName: true } },
            listing: { include: { foodItems: true } },
          },
        },
        items: true,
        declarations: { select: { id: true, type: true, version: true, acceptedAt: true, userId: true } },
      },
    });
  }

  async listForGroup(caller: Jwtpayload, groupId: number, from?: Date, to?: Date) {
    await this.access.assertReceiver(caller, groupId);
    return this.prisma.consolidatedCollection.findMany({
      where: {
        groupId,
        ...(from || to
          ? { scheduledDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
          : {}),
      },
      orderBy: { scheduledDate: 'asc' },
      include: { _count: { select: { contributions: true } } },
    });
  }

  // ─── Manager actions ───────────────────────────────────────────────────────

  /**
   * Closes submissions.
   *
   * Sites that never contributed get an explicit NO_CONTRIBUTION row rather
   * than simply being absent, so the dashboard can show "nothing from this
   * site" as a fact instead of a gap (R20).
   */
  async closeSubmissions(caller: Jwtpayload, collectionId: number, req?: RequestContext) {
    const collection = await this.load(caller, collectionId);
    await this.access.assertManager(caller, collection.groupId);

    if (collection.status !== ConsolidatedCollectionStatus.OPEN) {
      throw new ConflictException(`Submissions are not open (status ${collection.status}).`);
    }

    const actor = await this.audit.actorFrom(caller, req);
    const now = new Date();

    const result = await this.prisma.$transaction(async (tx) => {
      const created = await this.createMissingContributions(tx, collection.id, collection.participatingSiteIds);

      await tx.consolidatedCollection.update({
        where: { id: collectionId },
        data: {
          status: ConsolidatedCollectionStatus.SUBMISSIONS_CLOSED,
          closedAt: now,
          reopenedUntil: null,
        },
      });

      await this.audit.log(tx, actor, {
        organisationId: collection.organisationId,
        action: CONSOLIDATED_ACTION.COLLECTION_CLOSED,
        entityType: 'ConsolidatedCollection',
        entityId: collectionId,
        entityLabel: collection.group.name,
        summary: `Closed submissions. ${created} site(s) recorded as no contribution.`,
      });

      return { noContributionCount: created };
    });

    await this.notifier.collectionClosed(collection.id).catch((e) => this.logger.warn(e));
    return result;
  }

  /**
   * Reopens submissions for a while longer.
   *
   * Only until handover ends — food that arrives after that cannot physically
   * make the pickup, so allowing it would be a promise we cannot keep.
   */
  async reopenSubmissions(
    caller: Jwtpayload, collectionId: number, dto: ReopenSubmissionsDto, req?: RequestContext,
  ) {
    const collection = await this.load(caller, collectionId);
    await this.access.assertManager(caller, collection.groupId);

    if (collection.status !== ConsolidatedCollectionStatus.SUBMISSIONS_CLOSED) {
      if (collection.publishedAt) {
        throw new ConflictException({
          error: CONSOLIDATED_ERROR.SUBMISSIONS_CLOSED,
          message: 'Already published — sites must use a change request or a late contribution.',
        });
      }
      throw new ConflictException(`Submissions are not closed (status ${collection.status}).`);
    }

    const until = new Date(dto.until);
    if (Number.isNaN(until.getTime())) throw new BadRequestException('Invalid date.');
    if (until <= new Date()) {
      throw new BadRequestException('Choose a time in the future.');
    }
    if (until > collection.handoverEndAt) {
      throw new BadRequestException('Submissions cannot stay open past the end of handover.');
    }

    const actor = await this.audit.actorFrom(caller, req);

    return this.prisma.$transaction(async (tx) => {
      // These are recreated at the next close, and leaving them would make a
      // site look like it declined while it is still able to contribute.
      await tx.consolidatedContribution.deleteMany({
        where: { collectionId, status: ConsolidatedContributionStatus.NO_CONTRIBUTION },
      });

      const updated = await tx.consolidatedCollection.update({
        where: { id: collectionId },
        data: {
          status: ConsolidatedCollectionStatus.OPEN,
          reopenedUntil: until,
          closedAt: null,
          closingReminderAt: null,
        },
      });

      await this.audit.log(tx, actor, {
        organisationId: collection.organisationId,
        action: CONSOLIDATED_ACTION.COLLECTION_REOPENED,
        entityType: 'ConsolidatedCollection',
        entityId: collectionId,
        entityLabel: collection.group.name,
        newValue: { reopenedUntil: until },
        summary: `Reopened submissions until ${until.toISOString()}.`,
      });

      return updated;
    });
  }

  /**
   * Cancels everything in one transaction.
   *
   * Contribution records survive as history and count as not redistributed —
   * they are never turned back into ordinary direct listings (R9).
   */
  async cancel(
    caller: Jwtpayload, collectionId: number, dto: CancelCollectionDto, req?: RequestContext,
  ) {
    const collection = await this.load(caller, collectionId);
    await this.access.assertManager(caller, collection.groupId);

    if (FINAL_STATUSES.includes(collection.status)) {
      throw new ConflictException(`This collection is already ${collection.status.toLowerCase()}.`);
    }

    const actor = await this.audit.actorFrom(caller, req);
    const now = new Date();
    const wasClaimed = collection.status === ConsolidatedCollectionStatus.CLAIMED;

    const result = await this.prisma.$transaction(async (tx) => {
      const contributions = await tx.consolidatedContribution.findMany({
        where: { collectionId, status: { in: NON_FINAL_CONTRIBUTIONS } },
        select: { id: true, listingId: true },
      });
      const listingIds = contributions
        .map((c) => c.listingId)
        .filter((id): id is number => id !== null);

      await tx.consolidatedContribution.updateMany({
        where: { id: { in: contributions.map((c) => c.id) } },
        data: { status: ConsolidatedContributionStatus.CANCELLED },
      });

      if (listingIds.length) {
        await tx.foodListing.updateMany({
          where: { id: { in: listingIds } },
          data: { status: ListingStatus.CANCELLED },
        });
      }

      await tx.consolidatedItem.updateMany({
        where: { collectionId, outcome: ConsolidatedItemOutcome.PENDING },
        data: { outcome: ConsolidatedItemOutcome.CANCELLED },
      });

      if (collection.masterListingId) {
        await tx.foodListing.update({
          where: { id: collection.masterListingId },
          data: { status: ListingStatus.CANCELLED },
        });

        const claims = await tx.foodClaim.findMany({
          where: {
            listingId: collection.masterListingId,
            status: { in: [ClaimStatus.PENDING, ClaimStatus.CONFIRMED] },
          },
          select: { id: true },
        });

        if (claims.length) {
          const claimIds = claims.map((c) => c.id);
          await tx.foodClaim.updateMany({
            where: { id: { in: claimIds } },
            data: { status: ClaimStatus.CANCELLED },
          });
          // A driver already on the way must be stood down with the claim.
          await tx.driverPickup.updateMany({
            where: {
              claimId: { in: claimIds },
              status: { notIn: [DriverPickupStatus.COLLECTED, DriverPickupStatus.CANCELLED] },
            },
            data: { status: DriverPickupStatus.CANCELLED },
          });
        }
      }

      await tx.consolidatedCollection.update({
        where: { id: collectionId },
        data: {
          status: ConsolidatedCollectionStatus.CANCELLED,
          cancelledAt: now,
          cancelledByUserId: caller.sub,
          cancelReason: dto.reason.trim(),
        },
      });

      await this.audit.log(tx, actor, {
        organisationId: collection.organisationId,
        action: CONSOLIDATED_ACTION.COLLECTION_CANCELLED,
        entityType: 'ConsolidatedCollection',
        entityId: collectionId,
        entityLabel: collection.group.name,
        previousValue: { status: collection.status },
        newValue: { status: ConsolidatedCollectionStatus.CANCELLED, reason: dto.reason },
        summary: `Cancelled the collection: ${dto.reason.trim()}`,
      });

      return { cancelledContributions: contributions.length };
    });

    await this.notifier.collectionCancelled(collection.id, wasClaimed).catch((e) => this.logger.warn(e));
    return result;
  }

  /** Nudges sites that have not contributed yet. */
  async remind(caller: Jwtpayload, collectionId: number, siteIds?: number[], req?: RequestContext) {
    const collection = await this.load(caller, collectionId);
    await this.access.assertManager(caller, collection.groupId);

    const contributed = await this.prisma.consolidatedContribution.findMany({
      where: { collectionId, status: { not: ConsolidatedContributionStatus.WITHDRAWN } },
      select: { siteId: true },
    });
    const done = new Set(contributed.map((c) => c.siteId));
    const targets = (siteIds ?? collection.participatingSiteIds).filter((id) => !done.has(id));

    if (targets.length) {
      await this.notifier.remindSites(collection.id, targets).catch((e) => this.logger.warn(e));
      const actor = await this.audit.actorFrom(caller, req);
      await this.audit.log(this.prisma, actor, {
        organisationId: collection.organisationId,
        action: CONSOLIDATED_ACTION.REMINDER_SENT,
        entityType: 'ConsolidatedCollection',
        entityId: collectionId,
        entityLabel: collection.group.name,
        summary: `Reminded ${targets.length} site(s) to list food.`,
      });
    }

    return { reminded: targets.length };
  }

  /**
   * Edits one occurrence only.
   *
   * It is marked detached, so a later edit to the series does not quietly undo
   * what the manager did here.
   */
  async updateOccurrence(
    caller: Jwtpayload, collectionId: number, dto: UpdateCollectionDto, req?: RequestContext,
  ) {
    const collection = await this.load(caller, collectionId);
    await this.access.assertManager(caller, collection.groupId);

    if (FINAL_STATUSES.includes(collection.status)) {
      throw new ConflictException(`This collection is ${collection.status.toLowerCase()}.`);
    }

    const at = (time: string | undefined, fallback: Date) =>
      time
        ? instantForLocalTime(collection.timezone, collection.scheduledDate, parseLocalTime(time))
        : fallback;

    const submissionsCloseAt = at(dto.submissionsCloseTime, collection.submissionsCloseAt);
    const handoverStartAt = at(dto.handoverStartTime, collection.handoverStartAt);
    const handoverEndAt = at(dto.handoverEndTime, collection.handoverEndAt);
    const pickupStartAt = at(dto.pickupStartTime, collection.pickupStartAt);
    const pickupEndAt = at(dto.pickupEndTime, collection.pickupEndAt);

    // Same ordering rule as a schedule — an occurrence is not exempt from it.
    if (handoverStartAt >= handoverEndAt) {
      throw new BadRequestException('Handover must start before it ends.');
    }
    if (submissionsCloseAt > handoverEndAt) {
      throw new BadRequestException('Submissions must close by the end of handover.');
    }
    if (handoverEndAt > pickupStartAt) {
      throw new BadRequestException('Handover must end before charity pickup starts.');
    }
    if (pickupStartAt >= pickupEndAt) {
      throw new BadRequestException('Charity pickup must start before it ends.');
    }

    let point: Awaited<ReturnType<typeof this.prisma.consolidatedCollectionPoint.findFirst>> = null;
    if (dto.collectionPointId && dto.collectionPointId !== collection.collectionPointId) {
      point = await this.prisma.consolidatedCollectionPoint.findFirst({
        where: { id: dto.collectionPointId, groupId: collection.groupId, isActive: true },
      });
      if (!point) throw new NotFoundException('Collection point not found in this group.');
    }

    const actor = await this.audit.actorFrom(caller, req);

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.consolidatedCollection.update({
        where: { id: collectionId },
        data: {
          isDetached: true,
          submissionsCloseAt,
          handoverStartAt,
          handoverEndAt,
          pickupStartAt,
          pickupEndAt,
          contactName: dto.contactName ?? collection.contactName,
          contactPhone: dto.contactPhone ?? collection.contactPhone,
          instructions: dto.instructions ?? collection.instructions,
          suitabilityNotes: dto.suitabilityNotes ?? collection.suitabilityNotes,
          participatingSiteIds: dto.participatingSiteIds ?? collection.participatingSiteIds,
          ...(point
            ? {
                collectionPointId: point.id,
                pointName: point.name,
                pointAddress: point.address,
                pointPostcode: point.postcode,
                pointLat: point.lat,
                pointLng: point.lng,
                pointDirections: point.directions,
              }
            : {}),
        },
      });

      await this.audit.log(tx, actor, {
        organisationId: collection.organisationId,
        action: CONSOLIDATED_ACTION.COLLECTION_UPDATED,
        entityType: 'ConsolidatedCollection',
        entityId: collectionId,
        entityLabel: collection.group.name,
        previousValue: {
          pickupStartAt: collection.pickupStartAt,
          pickupEndAt: collection.pickupEndAt,
          pointName: collection.pointName,
        },
        newValue: {
          pickupStartAt: row.pickupStartAt,
          pickupEndAt: row.pickupEndAt,
          pointName: row.pointName,
        },
        summary: 'Updated this collection only.',
      });

      return row;
    });

    // A published collection has a charity depending on these details; the
    // publish service decides whether the change needs acknowledging.
    return updated;
  }

  // ─── Shared with the sweep ─────────────────────────────────────────────────

  /** Records "this site gave nothing" explicitly. Returns how many it added. */
  async createMissingContributions(
    db: Db, collectionId: number, participatingSiteIds: number[],
  ): Promise<number> {
    const existing = await db.consolidatedContribution.findMany({
      where: { collectionId },
      select: { siteId: true },
    });
    const have = new Set(existing.map((c) => c.siteId));
    const missing = participatingSiteIds.filter((id) => !have.has(id));
    if (missing.length === 0) return 0;

    const result = await db.consolidatedContribution.createMany({
      data: missing.map((siteId) => ({
        collectionId,
        siteId,
        status: ConsolidatedContributionStatus.NO_CONTRIBUTION,
        receiptStatus: ConsolidatedReceiptStatus.PENDING,
      })),
      skipDuplicates: true,
    });
    return result.count;
  }
}
