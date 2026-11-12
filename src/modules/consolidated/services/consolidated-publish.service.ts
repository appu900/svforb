import {
  BadRequestException, ConflictException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import {
  ClaimStatus, ConsolidatedCollectionStatus, ConsolidatedContributionStatus,
  ConsolidatedDeclarationType, ConsolidatedItemOutcome, ConsolidatedListingRole,
  ConsolidatedReceiptStatus, FoodListingType, ListingStatus, Prisma, RecoveryPathway,
} from '@prisma/client';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import { EnterpriseScopeService } from '../../enterprise/services/enterprise-scope.service';
import { FoodListingCacheManager } from '../../foodlisting/cache/food.listing.cache';
import { ListingQueueService } from '../../foodlisting/queues/listing.queue.service';
import { FoodListingService } from '../../foodlisting/services/food.listing.service';
import { DECLARATIONS, MAX_MASTER_PHOTOS } from '../consolidated.constants';
import { CONSOLIDATED_ERROR } from '../consolidated.errors';
import { DeclarationAcceptanceDto } from '../dto/contribution.dto';
import { ConsolidatedAccessService } from './consolidated-access.service';
import { ConsolidatedCollectionService } from './consolidated-collection.service';
import { CONSOLIDATED_ACTION, ConsolidatedAuditService, RequestContext } from './consolidated-audit.service';
import {
  ConsolidatedSnapshot, diffMaterial,
} from './consolidated-material-change';
import { ConsolidatedNotifierService } from './consolidated-notifier.service';

/** Collection notes are shown on a phone — longer than this is unreadable. */
const MAX_NOTES = 300;

/** Contributions that must have a receipt decision before anyone can publish. */
const AWAITING_RECEIPT: ConsolidatedContributionStatus[] = [
  ConsolidatedContributionStatus.SUBMITTED,
  ConsolidatedContributionStatus.HANDED_OVER,
  ConsolidatedContributionStatus.LATE_PENDING_APPROVAL,
];

export interface PublishBlocker {
  code: string;
  message: string;
  contributionId?: number;
  itemId?: number;
}

/**
 * Turns many site contributions into the one listing a charity sees.
 *
 * The master listing is an ordinary FoodListing marked MASTER, written through
 * the same `createListingRecord` as any other, so discovery, claiming and
 * collection keep working unchanged. What makes it different is only that its
 * food came from several sites — and the charity never has to know that.
 */
@Injectable()
export class ConsolidatedPublishService {
  private readonly logger = new Logger(ConsolidatedPublishService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ConsolidatedAccessService,
    private readonly audit: ConsolidatedAuditService,
    private readonly notifier: ConsolidatedNotifierService,
    private readonly listings: FoodListingService,
    private readonly listingQueue: ListingQueueService,
    private readonly cache: FoodListingCacheManager,
    private readonly enterpriseScope: EnterpriseScopeService,
    private readonly collections: ConsolidatedCollectionService,
  ) {}

  // ─── Loading ───────────────────────────────────────────────────────────────

  private collectionQuery(collectionId: number) {
    return {
      where: { id: collectionId },
      include: {
        group: { select: { id: true, name: true, hostSiteId: true, organisationId: true } },
        contributions: {
          include: {
            site: { select: { id: true, name: true, organisationName: true } },
            listing: { select: { id: true, bestBefore: true, needsRefrigeration: true,
              needsAmbient: true, needsFreezer: true, needsHot: true, needsReheating: true,
              allergens: true, photoUrls: true } },
          },
        },
        items: true,
      },
    } satisfies Prisma.ConsolidatedCollectionFindUniqueArgs;
  }

  private async load(caller: Jwtpayload, collectionId: number) {
    const collection = await this.prisma.consolidatedCollection.findUnique(
      this.collectionQuery(collectionId),
    );
    if (!collection || collection.organisationId !== caller.orgId) {
      throw new NotFoundException('Collection not found.');
    }
    return collection;
  }


  // ─── Preview ───────────────────────────────────────────────────────────────

  /**
   * What the charity would see, and what stands in the way.
   *
   * Blockers are returned as a list rather than thrown one at a time, so a
   * manager can fix everything in one pass instead of discovering each problem
   * only after solving the last one.
   */
  async publishPreview(caller: Jwtpayload, collectionId: number) {
    const collection = await this.load(caller, collectionId);
    await this.access.assertManager(caller, collection.groupId);
    return this.buildPreview(collection);
  }

  private buildPreview(
    collection: Awaited<ReturnType<ConsolidatedPublishService['load']>>,
  ) {
    const blockers: PublishBlocker[] = [];
    const warnings: string[] = [];
    const now = new Date();

    if (collection.status !== ConsolidatedCollectionStatus.SUBMISSIONS_CLOSED) {
      blockers.push({
        code: 'NOT_CLOSED',
        message: 'Close submissions before publishing.',
      });
    }
    if (collection.pickupEndAt < now) {
      blockers.push({
        code: 'PICKUP_PASSED',
        message: 'The pickup window has already closed.',
      });
    }

    const byContribution = new Map(collection.contributions.map((c) => [c.id, c]));

    for (const contribution of collection.contributions) {
      if (
        AWAITING_RECEIPT.includes(contribution.status) &&
        contribution.receiptStatus === ConsolidatedReceiptStatus.PENDING
      ) {
        const name = contribution.site.name ?? contribution.site.organisationName;
        blockers.push({
          code: 'RECEIPT_PENDING',
          message: `Confirm what arrived from ${name}, or exclude it.`,
          contributionId: contribution.id,
        });
      }
      if (contribution.status === ConsolidatedContributionStatus.NO_CONTRIBUTION) {
        warnings.push(
          `${contribution.site.name ?? contribution.site.organisationName} did not contribute.`,
        );
      }
      if (contribution.status === ConsolidatedContributionStatus.NOT_RECEIVED) {
        warnings.push(
          `Nothing arrived from ${contribution.site.name ?? contribution.site.organisationName}.`,
        );
      }
    }

    const included = collection.items.filter(
      (item) =>
        (item.verifiedQtyKg ?? 0) > 0 &&
        item.outcome !== ConsolidatedItemOutcome.EXCLUDED &&
        byContribution.get(item.contributionId)?.status === ConsolidatedContributionStatus.RECEIVED,
    );

    if (included.length === 0) {
      blockers.push({
        code: 'NOTHING_RECEIVED',
        message: 'No food has been confirmed as received.',
      });
    }

    // Food that goes off before the charity can collect it must never be
    // offered — the manager excludes it or the site adjusts the date.
    for (const item of included) {
      const listing = byContribution.get(item.contributionId)?.listing;
      if (listing && listing.bestBefore < collection.pickupEndAt) {
        const name =
          byContribution.get(item.contributionId)?.site.name ??
          byContribution.get(item.contributionId)?.site.organisationName;
        blockers.push({
          code: 'BEST_BEFORE_TOO_EARLY',
          message: `${item.name} from ${name} is past its best-before by the end of pickup. Exclude or adjust it.`,
          contributionId: item.contributionId,
          itemId: item.id,
        });
      }
    }

    for (const item of included) {
      if (item.verifiedQtyKg !== null && item.verifiedQtyKg < item.submittedQtyKg) {
        warnings.push(
          `${item.name} was reduced from ${item.submittedQtyKg} kg to ${item.verifiedQtyKg} kg.`,
        );
      }
    }

    const contributionsIncluded = [...new Set(included.map((i) => i.contributionId))];
    const listings = contributionsIncluded
      .map((id) => byContribution.get(id)?.listing)
      .filter((l): l is NonNullable<typeof l> => Boolean(l));

    return {
      items: included.map((i) => ({
        id: i.id,
        name: i.name,
        category: i.category,
        qtyKg: i.verifiedQtyKg ?? 0,
        siteId: i.siteId,
      })),
      totals: {
        totalQtyKg: included.reduce((sum, i) => sum + (i.verifiedQtyKg ?? 0), 0),
        itemCount: included.length,
        siteCount: contributionsIncluded.length,
      },
      storage: this.mergeStorage(listings),
      allergens: this.mergeAllergens(listings),
      photoUrls: this.mergePhotos(listings),
      bestBefore: this.earliestBestBefore(listings),
      warnings,
      blockers,
    };
  }

  // ─── Publish ───────────────────────────────────────────────────────────────

  async publish(
    caller: Jwtpayload, collectionId: number,
    declaration: DeclarationAcceptanceDto, req?: RequestContext,
  ) {
    const collection = await this.load(caller, collectionId);
    await this.access.assertManager(caller, collection.groupId);

    if (!declaration?.accepted || declaration.version !== DECLARATIONS.MANAGER.version) {
      throw new BadRequestException(
        'You must accept the current manager declaration to publish.',
      );
    }

    const preview = this.buildPreview(collection);
    if (preview.blockers.length > 0) {
      throw new ConflictException({
        error: CONSOLIDATED_ERROR.NOT_PUBLISHABLE,
        message: 'This collection cannot be published yet.',
        blockers: preview.blockers,
      });
    }

    const snapshot = await this.enterpriseScope.snapshotForSite(collection.group.hostSiteId);
    const actor = await this.audit.actorFrom(caller, req);
    const includedIds = new Set(preview.items.map((i) => i.id));
    const ledger = collection.items.filter((i) => includedIds.has(i.id));

    const result = await this.prisma.$transaction(async (tx) => {
      const master = await this.listings.createListingRecord(
        tx,
        caller,
        {
          // The host site owns the listing; impact is attributed per site from
          // the ledger, never from this (A2).
          siteId: collection.group.hostSiteId,
          listingType: FoodListingType.HUMAN,
          recoveryPathway: RecoveryPathway.FOOD_FOR_PEOPLE,
          pickupAddress: collection.pointAddress,
          pickupPostcode: collection.pointPostcode ?? undefined,
          pickupLat: collection.pointLat,
          pickupLng: collection.pointLng,
          pickupFromTime: collection.pickupStartAt.toISOString(),
          pickupByTime: collection.pickupEndAt,
          bestBefore: preview.bestBefore,
          ...preview.storage,
          isSafeForDonation: true,
          allergens: preview.allergens,
          photoUrls: preview.photoUrls,
          collectionNotes: this.buildNotes(collection),
          totalQtyKg: preview.totals.totalQtyKg,
          foodItems: ledger.map((item) => ({
            name: item.name,
            totalQtyKg: item.verifiedQtyKg ?? 0,
            category: item.category ?? undefined,
          })),
          snapshot,
        },
        { consolidatedRole: ConsolidatedListingRole.MASTER },
      );

      // Tie each master food item back to the ledger row it came from, so a
      // charity rejecting an item lands on the right site's record (R19).
      await this.linkMasterItems(tx, master!.id, ledger);

      await tx.consolidatedDeclaration.create({
        data: {
          collectionId,
          type: ConsolidatedDeclarationType.MANAGER,
          version: DECLARATIONS.MANAGER.version,
          textSnapshot: DECLARATIONS.MANAGER.text,
          userId: caller.sub,
          organisationId: collection.organisationId,
          ipAddress: req?.ip ?? null,
          userAgent: (req?.headers?.['user-agent'] as string) ?? null,
        },
      });

      await tx.consolidatedCollection.update({
        where: { id: collectionId },
        data: {
          status: ConsolidatedCollectionStatus.PUBLISHED,
          publishedAt: new Date(),
          publishedByUserId: caller.sub,
          masterListingId: master!.id,
          version: 1,
        },
      });

      await this.audit.log(tx, actor, {
        organisationId: collection.organisationId,
        action: CONSOLIDATED_ACTION.COLLECTION_PUBLISHED,
        entityType: 'ConsolidatedCollection',
        entityId: collectionId,
        entityLabel: collection.group.name,
        newValue: {
          masterListingId: master!.id,
          totalQtyKg: preview.totals.totalQtyKg,
          siteCount: preview.totals.siteCount,
        },
        summary:
          `Published ${preview.totals.totalQtyKg} kg from ${preview.totals.siteCount} site(s) ` +
          `at ${collection.pointName}.`,
      });

      return { masterListingId: master!.id, totals: preview.totals };
    });

    // Discovery runs outside the transaction: the listing exists either way,
    // and a charity push must not be able to roll back a publish.
    await Promise.all([
      this.cache.invalidateAllNearby(),
      this.cache.invalidateRecentPage1(),
      this.cache.invalidateOrgPage1(collection.organisationId),
    ]).catch((e) => this.logger.warn(`Cache invalidation failed: ${e}`));

    await this.listingQueue
      .enqueueNewListing({
        listingId: result.masterListingId,
        siteId: collection.group.hostSiteId,
        listingType: FoodListingType.HUMAN,
        pickupAddress: collection.pointAddress,
        // The push text uses this. The collection point, never an outlet name.
        businessName: collection.pointName,
        totalQtyKg: result.totals.totalQtyKg,
        bestBefore: preview.bestBefore.toISOString(),
      })
      .catch((e) => this.logger.error(`Could not announce the master listing: ${e}`));

    await this.notifier.published(collectionId).catch((e) => this.logger.warn(e));
    return result;
  }

  // ─── Keeping the master honest after publish ───────────────────────────────

  /**
   * Rebuilds the master listing from the ledger after any change.
   *
   * Before a claim this is a straight rebuild. After one, the charity is
   * relying on what it saw, so the change is diffed and — if material —
   * recorded for them to acknowledge (R11).
   */
  async syncMaster(caller: Jwtpayload, collectionId: number, req?: RequestContext) {
    const collection = await this.load(caller, collectionId);
    if (!collection.masterListingId) return { synced: false, reason: 'not published' };

    const claimable = [
      ConsolidatedCollectionStatus.CLAIMED,
      ConsolidatedCollectionStatus.AWAITING_ITEM_CHECK,
    ] as ConsolidatedCollectionStatus[];
    const isClaimed = claimable.includes(collection.status);

    const before = isClaimed ? await this.snapshotOf(collection) : null;
    const preview = this.buildPreview({
      ...collection,
      // A rebuild is not a fresh publish, so the "must be closed" and "pickup
      // has not passed" gates do not apply here.
      status: ConsolidatedCollectionStatus.SUBMISSIONS_CLOSED,
      pickupEndAt: new Date(collection.pickupEndAt.getTime()),
    });

    // Everything gone is a cancellation, not an empty listing. A charity
    // left holding a claim on nothing is worse than being told it is off.
    if (preview.items.length === 0) {
      await this.collections.cancel(
        caller,
        collectionId,
        { reason: 'No food available' },
        req,
      );
      return { synced: false, empty: true, cancelled: true };
    }

    const includedIds = new Set(preview.items.map((i) => i.id));
    const ledger = collection.items.filter((i) => includedIds.has(i.id));
    const actor = await this.audit.actorFrom(caller, req);

    await this.prisma.$transaction(async (tx) => {
      await tx.foodListing.update({
        where: { id: collection.masterListingId! },
        data: {
          totalQtyKg: preview.totals.totalQtyKg,
          remainingQtyKg: preview.totals.totalQtyKg,
          bestBefore: preview.bestBefore,
          ...preview.storage,
          allergens: preview.allergens,
          photoUrls: preview.photoUrls,
        },
      });

      // Ledger rows that dropped out take their master item with them.
      const keep = ledger.map((i) => i.masterFoodItemId).filter((id): id is number => id !== null);
      await tx.foodItem.deleteMany({
        where: { listingId: collection.masterListingId!, id: { notIn: keep.length ? keep : [-1] } },
      });

      for (const item of ledger) {
        const qty = item.verifiedQtyKg ?? 0;
        if (item.masterFoodItemId) {
          await tx.foodItem.update({
            where: { id: item.masterFoodItemId },
            data: { totalQtyKg: qty, remainingQtyKg: qty, name: item.name, category: item.category },
          });
        } else {
          const created = await tx.foodItem.create({
            data: {
              listingId: collection.masterListingId!,
              name: item.name,
              category: item.category,
              totalQtyKg: qty,
              remainingQtyKg: qty,
            },
          });
          await tx.consolidatedItem.update({
            where: { id: item.id },
            data: { masterFoodItemId: created.id },
          });
        }
      }

      await tx.consolidatedCollection.update({
        where: { id: collectionId },
        data: { version: { increment: 1 } },
      });

      await tx.listingActivity.create({
        data: {
          actorOrgId: collection.organisationId,
          listingId: collection.masterListingId!,
          eventType: 'listing updated',
          message: 'Collection contents updated',
        },
      });

      await this.audit.log(tx, actor, {
        organisationId: collection.organisationId,
        action: CONSOLIDATED_ACTION.COLLECTION_REPUBLISHED,
        entityType: 'ConsolidatedCollection',
        entityId: collectionId,
        entityLabel: collection.group.name,
        newValue: { totalQtyKg: preview.totals.totalQtyKg },
        summary: `Updated the published collection to ${preview.totals.totalQtyKg} kg.`,
      });
    });

    await this.cache.invalidateAllNearby().catch(() => undefined);

    if (!isClaimed || !before) return { synced: true, material: false };

    // The charity has already committed to this food, so what changed matters.
    const after = await this.snapshotOf(
      await this.prisma.consolidatedCollection.findUniqueOrThrow(this.collectionQuery(collectionId)),
    );
    const diff = diffMaterial(before, after, collection.timezone);

    const claim = await this.prisma.foodClaim.findFirst({
      where: { listingId: collection.masterListingId, status: { not: ClaimStatus.CANCELLED } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    const change = await this.prisma.consolidatedChange.create({
      data: {
        collectionId,
        fromVersion: collection.version,
        toVersion: collection.version + 1,
        isMaterial: diff.isMaterial,
        reasons: diff.reasons,
        summary: diff.summary,
        before: before as unknown as Prisma.InputJsonValue,
        after: after as unknown as Prisma.InputJsonValue,
        createdByUserId: caller.sub,
        notifiedAt: diff.isMaterial ? new Date() : null,
      },
    });

    // The charity's claim items must match what they will actually be given.
    if (claim) {
      await this.syncClaimItems(claim.id, ledger);
      if (diff.isMaterial) {
        await this.notifier
          .materialChange(collectionId, claim.id, diff.summary)
          .catch((e) => this.logger.warn(e));
      }
    }

    return { synced: true, material: diff.isMaterial, changeId: change.id };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async linkMasterItems(
    tx: Prisma.TransactionClient,
    masterListingId: number,
    ledger: { id: number; name: string; verifiedQtyKg: number | null }[],
  ) {
    const created = await tx.foodItem.findMany({
      where: { listingId: masterListingId },
      orderBy: { id: 'asc' },
    });
    // createListingRecord writes items in the order given, so index alignment
    // is safe here and avoids matching on a name that may repeat.
    for (let i = 0; i < ledger.length && i < created.length; i += 1) {
      await tx.consolidatedItem.update({
        where: { id: ledger[i].id },
        data: { masterFoodItemId: created[i].id },
      });
    }
  }

  private async syncClaimItems(
    claimId: number,
    ledger: { masterFoodItemId: number | null; verifiedQtyKg: number | null }[],
  ) {
    for (const item of ledger) {
      if (!item.masterFoodItemId) continue;
      await this.prisma.claimItem.updateMany({
        where: { claimId, foodItemId: item.masterFoodItemId },
        data: { qtyKg: item.verifiedQtyKg ?? 0 },
      });
    }
  }

  private async snapshotOf(
    collection: Awaited<ReturnType<ConsolidatedPublishService['load']>>,
  ): Promise<ConsolidatedSnapshot> {
    const preview = this.buildPreview({
      ...collection,
      status: ConsolidatedCollectionStatus.SUBMISSIONS_CLOSED,
    });
    return {
      pointName: collection.pointName,
      pointAddress: collection.pointAddress,
      pickupStartAt: collection.pickupStartAt,
      pickupEndAt: collection.pickupEndAt,
      storage: {
        refrigeration: preview.storage.needsRefrigeration,
        ambient: preview.storage.needsAmbient,
        freezer: preview.storage.needsFreezer,
        hot: preview.storage.needsHot,
        reheating: preview.storage.needsReheating,
      },
      allergens: preview.allergens,
      items: preview.items.map((i) => ({
        key: String(i.id),
        name: i.name,
        category: i.category,
        qtyKg: i.qtyKg,
      })),
    };
  }

  /** Any site needing refrigeration means the whole collection does. */
  private mergeStorage(listings: { needsRefrigeration: boolean; needsAmbient: boolean;
    needsFreezer: boolean; needsHot: boolean; needsReheating: boolean }[]) {
    return {
      needsRefrigeration: listings.some((l) => l.needsRefrigeration),
      needsAmbient: listings.some((l) => l.needsAmbient),
      needsFreezer: listings.some((l) => l.needsFreezer),
      needsHot: listings.some((l) => l.needsHot),
      needsReheating: listings.some((l) => l.needsReheating),
    };
  }

  /** Union, never intersection — a missed allergen is a safety failure. */
  private mergeAllergens(listings: { allergens: string[] }[]): string[] {
    return [...new Set(listings.flatMap((l) => l.allergens))].sort();
  }

  private mergePhotos(listings: { photoUrls: string[] }[]): string[] {
    return [...new Set(listings.flatMap((l) => l.photoUrls))].slice(0, MAX_MASTER_PHOTOS);
  }

  /** The earliest date governs — the collection is only as fresh as its oldest food. */
  private earliestBestBefore(listings: { bestBefore: Date }[]): Date {
    return listings.reduce(
      (earliest, l) => (l.bestBefore < earliest ? l.bestBefore : earliest),
      listings[0]?.bestBefore ?? new Date(),
    );
  }

  /**
   * What the charity reads on arrival. The instructions are trimmed first,
   * because the point, suitability and contact are the parts they cannot do
   * without.
   */
  private buildNotes(collection: {
    pointName: string; pointDirections: string | null; instructions: string | null;
    suitabilityNotes: string; contactName: string; contactPhone: string;
  }): string {
    const tail =
      `Suitability: ${collection.suitabilityNotes}. ` +
      `Contact: ${collection.contactName} ${collection.contactPhone}`;
    const head = [collection.pointName, collection.pointDirections].filter(Boolean).join('. ');

    const room = MAX_NOTES - head.length - tail.length - 2;
    const instructions =
      collection.instructions && room > 8
        ? ` ${collection.instructions.slice(0, room)}`
        : '';

    return `${head}.${instructions} ${tail}`.slice(0, MAX_NOTES).trim();
  }
}
