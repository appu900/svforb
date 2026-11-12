import {
  BadRequestException, ConflictException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import {
  ClaimKind, ClaimMode, ClaimStatus, ConsolidatedCollectionStatus,
  ConsolidatedContributionStatus, ConsolidatedDeclarationType, ConsolidatedItemOutcome,
  ConsolidatedRejectionReason, ListingStatus, Prisma, RecoveryPathway,
} from '@prisma/client';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import { FoodListingCacheManager } from '../../foodlisting/cache/food.listing.cache';
import { DECLARATIONS } from '../consolidated.constants';
import { CONSOLIDATED_ERROR } from '../consolidated.errors';
import { SubmitItemCheckDto } from '../dto/item-check.dto';
import { ConsolidatedAccessService } from './consolidated-access.service';
import { CONSOLIDATED_ACTION, ConsolidatedAuditService, RequestContext } from './consolidated-audit.service';
import {
  outcomeFor, totalsReconcile, validateItemCheck,
} from './consolidated-item-check';
import { ConsolidatedNotifierService } from './consolidated-notifier.service';

/** Floating-point kilograms never land exactly; this is the tolerance. */
const EPSILON = 0.001;

/**
 * What the charity actually took, and turning that into each site's impact.
 *
 * This is the only place redistributed food is created. Publishing an offer
 * proves nothing was collected, and the master claim is a presentation layer —
 * the per-site allocation claims written here are what every report counts
 * (R19).
 */
@Injectable()
export class ConsolidatedCompletionService {
  private readonly logger = new Logger(ConsolidatedCompletionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ConsolidatedAccessService,
    private readonly audit: ConsolidatedAuditService,
    private readonly notifier: ConsolidatedNotifierService,
    private readonly cache: FoodListingCacheManager,
  ) {}

  // ─── B10.1 What the charity is asked to confirm ────────────────────────────

  async itemCheck(caller: Jwtpayload, claimId: number) {
    const claim = await this.access.assertCharityOwnsClaim(caller, claimId);

    const collection = await this.prisma.consolidatedCollection.findFirst({
      where: { masterListingId: claim.listingId },
      include: { items: true },
    });
    if (!collection) throw new NotFoundException('Collection not found.');

    const masterItems = await this.prisma.foodItem.findMany({
      where: { listingId: claim.listingId },
      orderBy: { id: 'asc' },
    });
    const listing = await this.prisma.foodListing.findUniqueOrThrow({
      where: { id: claim.listingId },
      select: {
        needsRefrigeration: true, needsAmbient: true, needsFreezer: true,
        needsHot: true, needsReheating: true, allergens: true,
      },
    });

    const byMasterItem = new Map(
      collection.items.filter((i) => i.masterFoodItemId).map((i) => [i.masterFoodItemId!, i]),
    );

    const pendingChange = await this.prisma.consolidatedChange.findFirst({
      where: { collectionId: collection.id, isMaterial: true, acknowledgedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true, summary: true },
    });

    return {
      claimId,
      pickup: {
        pointName: collection.pointName,
        address: collection.pointAddress,
        start: collection.pickupStartAt,
        end: collection.pickupEndAt,
      },
      // Deliberately no site information: the charity confirms food, not outlets.
      items: masterItems.map((item) => ({
        masterFoodItemId: item.id,
        name: item.name,
        category: item.category,
        quantityDescription: item.quantityDescription,
        qtyKg: byMasterItem.get(item.id)?.verifiedQtyKg ?? item.totalQtyKg,
      })),
      storage: listing,
      allergens: listing.allergens,
      declaration: DECLARATIONS.CHARITY,
      rejectionReasons: Object.values(ConsolidatedRejectionReason),
      pendingChange: pendingChange ?? null,
      alreadyCompleted: collection.status === ConsolidatedCollectionStatus.COMPLETED,
    };
  }

  // ─── B10.2 Recording it ────────────────────────────────────────────────────

  async submitItemCheck(
    caller: Jwtpayload, claimId: number, dto: SubmitItemCheckDto, req?: RequestContext,
  ) {
    const claim = await this.access.assertCharityOwnsClaim(caller, claimId);

    const collection = await this.prisma.consolidatedCollection.findFirst({
      where: { masterListingId: claim.listingId },
      include: {
        items: true,
        contributions: {
          include: { site: { select: { id: true, name: true, organisationName: true } } },
        },
        group: { select: { name: true } },
      },
    });
    if (!collection) throw new NotFoundException('Collection not found.');

    if (collection.status === ConsolidatedCollectionStatus.COMPLETED) {
      throw new ConflictException('This collection has already been confirmed.');
    }
    const open = [
      ConsolidatedCollectionStatus.CLAIMED,
      ConsolidatedCollectionStatus.AWAITING_ITEM_CHECK,
    ] as ConsolidatedCollectionStatus[];
    if (!open.includes(collection.status)) {
      throw new ConflictException(`This collection is ${collection.status.toLowerCase()}.`);
    }

    // A change the charity has not seen must not be quietly signed off by
    // confirming the food they expected rather than the food that is there.
    const unacknowledged = await this.prisma.consolidatedChange.findFirst({
      where: { collectionId: collection.id, isMaterial: true, acknowledgedAt: null },
      select: { id: true },
    });
    if (unacknowledged) {
      throw new ConflictException({
        error: CONSOLIDATED_ERROR.CHANGE_NEEDS_ACKNOWLEDGEMENT,
        message: 'Please review the pickup change first.',
        changeId: unacknowledged.id,
      });
    }

    if (!dto.declaration?.accepted || dto.declaration.version !== DECLARATIONS.CHARITY.version) {
      throw new BadRequestException('You must accept the collection declaration to continue.');
    }

    const ledgerByMasterItem = new Map(
      collection.items.filter((i) => i.masterFoodItemId).map((i) => [i.masterFoodItemId!, i]),
    );
    validateItemCheck(
      dto.items,
      [...ledgerByMasterItem.entries()].map(([masterFoodItemId, l]) => ({
        masterFoodItemId,
        verifiedQtyKg: l.verifiedQtyKg ?? 0,
      })),
    );

    const actor = await this.audit.actorFrom(caller, req);
    const now = new Date();

    const result = await this.prisma.$transaction(async (tx) => {
      // Same lock the claim path takes, so two devices cannot both complete.
      await tx.$executeRaw`SELECT id FROM food_listings WHERE id = ${claim.listingId} FOR UPDATE`;

      const accepted = new Map<number, number>();

      for (const line of dto.items) {
        const ledger = ledgerByMasterItem.get(line.masterFoodItemId)!;
        await tx.consolidatedItem.update({
          where: { id: ledger.id },
          data: {
            acceptedQtyKg: line.acceptedQtyKg,
            rejectedQtyKg: line.rejectedQtyKg,
            unavailableQtyKg: line.unavailableQtyKg,
            rejectionReason: line.rejectionReason ?? null,
            rejectionNote: line.rejectionNote ?? null,
            outcome: outcomeFor(line, ledger.verifiedQtyKg ?? 0),
          },
        });
        accepted.set(
          ledger.contributionId,
          (accepted.get(ledger.contributionId) ?? 0) + line.acceptedQtyKg,
        );
        // The charity's own history should show what they took, not what was offered.
        await tx.claimItem.updateMany({
          where: { claimId, foodItemId: line.masterFoodItemId },
          data: { qtyKg: line.acceptedQtyKg },
        });
      }

      if (claim.status !== ClaimStatus.COLLECTED) {
        await tx.foodClaim.update({
          where: { id: claimId },
          data: { status: ClaimStatus.COLLECTED, collectedAt: now },
        });
      }
      if (dto.rating !== undefined) {
        await tx.foodClaim.update({
          where: { id: claimId },
          data: { rating: dto.rating, ratingNote: dto.ratingNote ?? null },
        });
      }

      await tx.consolidatedDeclaration.create({
        data: {
          collectionId: collection.id,
          claimId,
          type: ConsolidatedDeclarationType.CHARITY,
          version: DECLARATIONS.CHARITY.version,
          textSnapshot: DECLARATIONS.CHARITY.text,
          userId: caller.sub,
          organisationId: caller.orgId!,
          ipAddress: req?.ip ?? null,
          userAgent: (req?.headers?.['user-agent'] as string) ?? null,
        },
      });

      const allocations = await this.writeAllocations(
        tx, collection, claim, accepted, now,
      );

      // If these three ever disagree, impact is wrong somewhere. Throwing
      // rolls the whole thing back rather than persisting a bad total.
      await this.assertInvariant(tx, claimId, collection.id, allocations.totalAccepted);

      await tx.consolidatedCollection.update({
        where: { id: collection.id },
        data: { status: ConsolidatedCollectionStatus.COMPLETED, completedAt: now },
      });

      await this.audit.log(tx, actor, {
        organisationId: collection.organisationId,
        action: CONSOLIDATED_ACTION.ITEM_CHECK_SUBMITTED,
        entityType: 'ConsolidatedCollection',
        entityId: collection.id,
        entityLabel: collection.group.name,
        newValue: {
          acceptedKg: allocations.totalAccepted,
          rejectedKg: dto.items.reduce((s, i) => s + i.rejectedQtyKg, 0),
          unavailableKg: dto.items.reduce((s, i) => s + i.unavailableQtyKg, 0),
          allocations: allocations.created,
        },
        summary:
          `Charity confirmed ${allocations.totalAccepted} kg accepted across ` +
          `${allocations.created} site(s).`,
      });

      return allocations;
    });

    await Promise.all([
      this.cache.invalidateAllNearby(),
      this.cache.invalidateRecentPage1(),
      this.cache.invalidateOrgPage1(collection.organisationId),
    ]).catch((e) => this.logger.warn(`Cache invalidation failed: ${e}`));

    await this.notifier.completed(collection.id).catch((e) => this.logger.warn(e));

    return {
      completed: true,
      acceptedKg: result.totalAccepted,
      allocationsCreated: result.created,
    };
  }

  // ─── B10.3 Acknowledging a change ──────────────────────────────────────────

  async acknowledgeChange(
    caller: Jwtpayload, changeId: number, req?: RequestContext,
  ) {
    const change = await this.prisma.consolidatedChange.findUnique({
      where: { id: changeId },
      include: { collection: { select: { id: true, masterListingId: true, organisationId: true, groupId: true } } },
    });
    if (!change) throw new NotFoundException('Change not found.');
    if (!change.collection.masterListingId) throw new NotFoundException('Change not found.');

    const claim = await this.prisma.foodClaim.findFirst({
      where: {
        listingId: change.collection.masterListingId,
        claimantOrgId: caller.orgId,
        claimKind: ClaimKind.CONSOLIDATED_MASTER,
        status: { not: ClaimStatus.CANCELLED },
      },
      select: { id: true },
    });
    if (!claim) throw new NotFoundException('Change not found.');

    if (change.acknowledgedAt) return { acknowledged: true, alreadyDone: true };

    const actor = await this.audit.actorFrom(caller, req);

    await this.prisma.$transaction(async (tx) => {
      await tx.consolidatedChange.update({
        where: { id: changeId },
        data: { acknowledgedAt: new Date(), acknowledgedByUserId: caller.sub },
      });
      await this.audit.log(tx, actor, {
        organisationId: change.collection.organisationId,
        action: CONSOLIDATED_ACTION.CHANGE_ACKNOWLEDGED,
        entityType: 'ConsolidatedChange',
        entityId: changeId,
        summary: 'The charity acknowledged the change.',
      });
    });

    return { acknowledged: true, alreadyDone: false };
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /**
   * One claim per contributing site, for exactly what that site's food came to.
   *
   * These carry the contribution listing's own enterprise snapshot, so each
   * site's impact lands in the group and territory it belonged to at the time.
   */
  private async writeAllocations(
    tx: Prisma.TransactionClient,
    collection: {
      id: number;
      contributions: {
        id: number;
        siteId: number;
        listingId: number | null;
        status: ConsolidatedContributionStatus;
      }[];
    },
    claim: { id: number; claimantOrgId: number; claimantSiteId: number | null },
    accepted: Map<number, number>,
    now: Date,
  ) {
    let created = 0;
    let totalAccepted = 0;

    for (const contribution of collection.contributions) {
      const acceptedKg = accepted.get(contribution.id) ?? 0;

      if (acceptedKg <= 0 || !contribution.listingId) {
        if (contribution.status !== ConsolidatedContributionStatus.CANCELLED) {
          await tx.consolidatedContribution.update({
            where: { id: contribution.id },
            data: { status: ConsolidatedContributionStatus.COMPLETED },
          });
        }
        if (contribution.listingId) {
          await tx.foodListing.update({
            where: { id: contribution.listingId },
            data: { status: ListingStatus.EXPIRED },
          });
        }
        continue;
      }

      const source = await tx.foodListing.findUniqueOrThrow({
        where: { id: contribution.listingId },
        select: {
          snapshotGroupId: true, snapshotClusterId: true, snapshotTerritoryId: true,
        },
      });

      const lines = await tx.consolidatedItem.findMany({
        where: { contributionId: contribution.id, acceptedQtyKg: { gt: 0 } },
        select: { sourceFoodItemId: true, acceptedQtyKg: true },
      });

      const allocation = await tx.foodClaim.create({
        data: {
          listingId: contribution.listingId,
          claimantOrgId: claim.claimantOrgId,
          claimantSiteId: claim.claimantSiteId,
          claimMode: ClaimMode.PARTIAL,
          status: ClaimStatus.COLLECTED,
          claimKind: ClaimKind.CONSOLIDATED_ALLOCATION,
          parentClaimId: claim.id,
          recoveryPathway: RecoveryPathway.FOOD_FOR_PEOPLE,
          confirmedAt: now,
          collectedAt: now,
          ...source,
          claimItems: {
            create: lines.map((l) => ({
              foodItemId: l.sourceFoodItemId,
              qtyKg: l.acceptedQtyKg ?? 0,
            })),
          },
        },
      });

      for (const line of lines) {
        await tx.foodItem.update({
          where: { id: line.sourceFoodItemId },
          data: { remainingQtyKg: { decrement: line.acceptedQtyKg ?? 0 } },
        });
      }
      await tx.foodListing.update({
        where: { id: contribution.listingId },
        data: {
          remainingQtyKg: { decrement: acceptedKg },
          status: ListingStatus.CLAIMED,
        },
      });

      await tx.consolidatedContribution.update({
        where: { id: contribution.id },
        data: {
          allocationClaimId: allocation.id,
          status: ConsolidatedContributionStatus.COMPLETED,
        },
      });

      await tx.listingActivity.create({
        data: {
          actorOrgId: claim.claimantOrgId,
          listingId: contribution.listingId,
          eventType: 'collected',
          message: `Collected: ${acceptedKg} kg accepted`,
        },
      });

      created += 1;
      totalAccepted += acceptedKg;
    }

    return { created, totalAccepted };
  }

  /**
   * Three totals that must agree: what the allocations say each site gave,
   * what the charity's claim says it took, and what the ledger recorded.
   */
  private async assertInvariant(
    tx: Prisma.TransactionClient,
    masterClaimId: number,
    collectionId: number,
    totalAccepted: number,
  ) {
    const [allocations, masterItems, ledger] = await Promise.all([
      tx.claimItem.aggregate({
        where: { claim: { parentClaimId: masterClaimId, claimKind: ClaimKind.CONSOLIDATED_ALLOCATION } },
        _sum: { qtyKg: true },
      }),
      tx.claimItem.aggregate({ where: { claimId: masterClaimId }, _sum: { qtyKg: true } }),
      tx.consolidatedItem.aggregate({
        where: { collectionId },
        _sum: { acceptedQtyKg: true },
      }),
    ]);

    const a = allocations._sum.qtyKg ?? 0;
    const m = masterItems._sum.qtyKg ?? 0;
    const l = ledger._sum.acceptedQtyKg ?? 0;

    if (!totalsReconcile(a, m, l) || Math.abs(a - totalAccepted) > EPSILON) {
      throw new ConflictException(
        `Collection totals do not reconcile (allocations ${a}, claim ${m}, ledger ${l}). ` +
          'Nothing was saved.',
      );
    }
  }
}
