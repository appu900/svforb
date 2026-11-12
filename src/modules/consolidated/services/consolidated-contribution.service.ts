import {
  BadRequestException, ConflictException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import {
  ConsolidatedChangeRequestStatus, ConsolidatedCollectionStatus,
  ConsolidatedContributionStatus, ConsolidatedDeclarationType, ConsolidatedItemOutcome,
  ConsolidatedListingRole, ConsolidatedReceiptStatus, FoodListingType, ListingStatus,
  Prisma, RecoveryPathway,
} from '@prisma/client';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import { EnterpriseScopeService } from '../../enterprise/services/enterprise-scope.service';
import { FoodListingService } from '../../foodlisting/services/food.listing.service';
import { DECLARATIONS } from '../consolidated.constants';
import { CONSOLIDATED_ERROR } from '../consolidated.errors';
import {
  ChangeRequestDecisionDto, ContributionItemDto, CreateContributionDto,
  DeclarationAcceptanceDto, LateDecisionDto, UpdateContributionDto, WithdrawContributionDto,
} from '../dto/contribution.dto';
import { ConsolidatedAccessService } from './consolidated-access.service';
import { CONSOLIDATED_ACTION, ConsolidatedAuditService, RequestContext } from './consolidated-audit.service';
import { ConsolidatedNotifierService } from './consolidated-notifier.service';

const HOURS_2 = 2 * 3600_000;

/** States a site may still edit directly, before publication. */
const EDITABLE: ConsolidatedContributionStatus[] = [
  ConsolidatedContributionStatus.SUBMITTED,
  ConsolidatedContributionStatus.LATE_PENDING_APPROVAL,
  ConsolidatedContributionStatus.HANDED_OVER,
  ConsolidatedContributionStatus.RECEIVED,
];

/**
 * What a site puts into a collection.
 *
 * A contribution is an ordinary FoodListing marked CONTRIBUTION — it reuses
 * every existing listing field, but it is never offered to a charity on its
 * own. Only the master listing built at publish is.
 */
@Injectable()
export class ConsolidatedContributionService {
  private readonly logger = new Logger(ConsolidatedContributionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ConsolidatedAccessService,
    private readonly audit: ConsolidatedAuditService,
    private readonly notifier: ConsolidatedNotifierService,
    private readonly listings: FoodListingService,
    private readonly enterpriseScope: EnterpriseScopeService,
  ) {}

  // ─── B8.1 What a site can contribute to ────────────────────────────────────

  async openCollectionsForSite(caller: Jwtpayload, siteId: number) {
    await this.access.assertSiteUser(caller, siteId);
    const now = new Date();

    const candidates = await this.prisma.consolidatedCollection.findMany({
      where: {
        organisationId: caller.orgId,
        participatingSiteIds: { has: siteId },
        status: {
          in: [
            ConsolidatedCollectionStatus.OPEN,
            ConsolidatedCollectionStatus.SUBMISSIONS_CLOSED,
            ConsolidatedCollectionStatus.PUBLISHED,
            ConsolidatedCollectionStatus.CLAIMED,
          ],
        },
        // Past the pickup window there is nothing left to join.
        pickupStartAt: { gt: now },
      },
      include: {
        group: { select: { name: true } },
        contributions: { where: { siteId }, select: { id: true, status: true } },
      },
      orderBy: { scheduledDate: 'asc' },
    });

    return candidates
      .filter((c) => {
        const mine = c.contributions[0];
        // A withdrawn row can be replaced; anything else means "already done".
        return !mine || mine.status === ConsolidatedContributionStatus.WITHDRAWN;
      })
      .map((c) => ({
        id: c.id,
        groupName: c.group.name,
        point: { name: c.pointName, address: c.pointAddress },
        method: c.method,
        scheduledDate: c.scheduledDate,
        submissionsCloseAt: c.submissionsCloseAt,
        handoverStartAt: c.handoverStartAt,
        handoverEndAt: c.handoverEndAt,
        pickupStartAt: c.pickupStartAt,
        pickupEndAt: c.pickupEndAt,
        suitabilityNotes: c.suitabilityNotes,
        instructions: c.instructions,
        timezone: c.timezone,
        /** Submissions have closed, but the manager may still accept it. */
        lateAllowed: c.status !== ConsolidatedCollectionStatus.OPEN,
      }));
  }

  // ─── B8.2 Submit ───────────────────────────────────────────────────────────

  async create(
    caller: Jwtpayload, collectionId: number, dto: CreateContributionDto, req?: RequestContext,
  ) {
    await this.access.assertSiteUser(caller, dto.siteId);

    const collection = await this.prisma.consolidatedCollection.findFirst({
      where: { id: collectionId, organisationId: caller.orgId },
      include: { group: { select: { name: true } } },
    });
    if (!collection) throw new NotFoundException('Collection not found.');

    this.access.assertSiteParticipates(collection, dto.siteId);
    this.assertDeclaration(dto.declaration, DECLARATIONS.SITE.version);

    const now = new Date();
    const isLate = this.resolveLateness(collection, now);

    const existing = await this.prisma.consolidatedContribution.findUnique({
      where: { collectionId_siteId: { collectionId, siteId: dto.siteId } },
      select: { id: true, status: true },
    });
    if (existing && existing.status !== ConsolidatedContributionStatus.WITHDRAWN) {
      throw new ConflictException({
        error: CONSOLIDATED_ERROR.ALREADY_CONTRIBUTED,
        message: 'Already contributed — edit your contribution instead.',
      });
    }

    const site = await this.prisma.site.findUniqueOrThrow({
      where: { id: dto.siteId },
      select: { name: true, organisationName: true },
    });
    const siteName = site.name ?? site.organisationName;
    const snapshot = await this.enterpriseScope.snapshotForSite(dto.siteId);
    const totalQtyKg = dto.foodItems.reduce((sum, i) => sum + i.totalQtyKg, 0);
    const actor = await this.audit.actorFrom(caller, req);

    const result = await this.prisma.$transaction(async (tx) => {
      const listing = await this.listings.createListingRecord(
        tx,
        caller,
        {
          siteId: dto.siteId,
          // Consolidated collections are the edible pathway only (A12).
          listingType: FoodListingType.HUMAN,
          recoveryPathway: RecoveryPathway.FOOD_FOR_PEOPLE,
          // Pickup is the collection point, not the kitchen.
          pickupAddress: collection.pointAddress,
          pickupPostcode: collection.pointPostcode ?? undefined,
          pickupLat: collection.pointLat,
          pickupLng: collection.pointLng,
          pickupFromTime: collection.pickupStartAt.toISOString(),
          pickupByTime: collection.pickupEndAt,
          // The food's own date — never derived from the event window.
          bestBefore: new Date(dto.bestBefore),
          needsRefrigeration: dto.needsRefrigeration,
          needsAmbient: dto.needsAmbient,
          needsFreezer: dto.needsFreezer,
          needsHot: dto.needsHot,
          needsReheating: dto.needsReheating,
          allergens: dto.allergens,
          collectionNotes: dto.collectionNotes,
          photoUrls: dto.photoUrls ?? [],
          totalQtyKg,
          foodItems: dto.foodItems,
          snapshot,
        },
        { consolidatedRole: ConsolidatedListingRole.CONTRIBUTION },
      );

      const status = isLate
        ? ConsolidatedContributionStatus.LATE_PENDING_APPROVAL
        : ConsolidatedContributionStatus.SUBMITTED;

      const contribution = existing
        ? await tx.consolidatedContribution.update({
            where: { id: existing.id },
            data: {
              listingId: listing!.id,
              status,
              isLate,
              submittedAt: now,
              submittedByUserId: caller.sub,
              withdrawnAt: null,
              withdrawReason: null,
              receiptStatus: ConsolidatedReceiptStatus.PENDING,
            },
          })
        : await tx.consolidatedContribution.create({
            data: {
              collectionId,
              siteId: dto.siteId,
              listingId: listing!.id,
              status,
              isLate,
              submittedAt: now,
              submittedByUserId: caller.sub,
            },
          });

      await this.writeLedger(tx, collectionId, contribution.id, dto.siteId, listing!.foodItems);

      await tx.consolidatedDeclaration.create({
        data: {
          collectionId,
          contributionId: contribution.id,
          type: ConsolidatedDeclarationType.SITE,
          version: DECLARATIONS.SITE.version,
          textSnapshot: DECLARATIONS.SITE.text,
          userId: caller.sub,
          organisationId: caller.orgId!,
          ipAddress: req?.ip ?? null,
          userAgent: (req?.headers?.['user-agent'] as string) ?? null,
        },
      });

      await tx.listingActivity.create({
        data: {
          actorOrgId: caller.orgId!,
          listingId: listing!.id,
          eventType: 'consolidated contribution',
          message: `Added to collection at ${collection.pointName} on ${collection.scheduledDate.toDateString()}`,
        },
      });

      await this.audit.log(tx, actor, {
        organisationId: collection.organisationId,
        action: isLate
          ? CONSOLIDATED_ACTION.CONTRIBUTION_LATE_SUBMITTED
          : CONSOLIDATED_ACTION.CONTRIBUTION_SUBMITTED,
        entityType: 'ConsolidatedContribution',
        entityId: contribution.id,
        entityLabel: siteName,
        newValue: { totalQtyKg, items: dto.foodItems.length, isLate },
        summary: `${siteName} contributed ${totalQtyKg} kg${isLate ? ' after the deadline' : ''}.`,
      });

      return { contribution, listing };
    });

    if (isLate) {
      await this.notifier.lateContribution(collectionId, siteName).catch((e) => this.logger.warn(e));
    }
    return result;
  }

  // ─── B8.3 Edit ─────────────────────────────────────────────────────────────

  async update(
    caller: Jwtpayload, contributionId: number, dto: UpdateContributionDto, req?: RequestContext,
  ) {
    const contribution = await this.loadForWrite(caller, contributionId);
    const { collection } = contribution;

    if (!EDITABLE.includes(contribution.status)) {
      throw new ConflictException(`This contribution is ${contribution.status.toLowerCase()}.`);
    }

    // Once a charity can see it, a site edit becomes a request rather than a change.
    const isManager = await this.access.canManageFlag(caller);
    if (collection.publishedAt && !isManager) {
      const request = await this.prisma.consolidatedChangeRequest.create({
        data: {
          contributionId,
          collectionId: collection.id,
          requestedByUserId: caller.sub,
          payload: dto as unknown as Prisma.InputJsonValue,
        },
      });
      await this.notifier
        .changeRequested(collection.id, contribution.siteName)
        .catch((e) => this.logger.warn(e));
      return { changeRequestId: request.id, status: 'PENDING_APPROVAL' as const };
    }

    const actor = await this.audit.actorFrom(caller, req);
    return this.applyUpdate(contributionId, dto, actor, caller, 'Updated their contribution');
  }

  // ─── B8.4 Withdraw and handover ────────────────────────────────────────────

  async withdraw(
    caller: Jwtpayload, contributionId: number, dto: WithdrawContributionDto, req?: RequestContext,
  ) {
    const contribution = await this.loadForWrite(caller, contributionId);

    if (contribution.collection.publishedAt) {
      throw new ConflictException({
        error: CONSOLIDATED_ERROR.MANAGED_BY_COLLECTION,
        message: 'Already published — ask your manager to exclude it.',
      });
    }
    if (!EDITABLE.includes(contribution.status)) {
      throw new ConflictException(`This contribution is ${contribution.status.toLowerCase()}.`);
    }

    const actor = await this.audit.actorFrom(caller, req);
    const now = new Date();

    return this.prisma.$transaction(async (tx) => {
      await tx.consolidatedContribution.update({
        where: { id: contributionId },
        data: {
          status: ConsolidatedContributionStatus.WITHDRAWN,
          withdrawnAt: now,
          withdrawReason: dto.reason?.trim() ?? null,
        },
      });

      if (contribution.listingId) {
        await tx.foodListing.update({
          where: { id: contribution.listingId },
          data: { status: ListingStatus.CANCELLED },
        });
      }

      // Nothing was verified, so there is no history worth keeping here.
      await tx.consolidatedItem.deleteMany({ where: { contributionId } });

      await this.audit.log(tx, actor, {
        organisationId: contribution.collection.organisationId,
        action: CONSOLIDATED_ACTION.CONTRIBUTION_WITHDRAWN,
        entityType: 'ConsolidatedContribution',
        entityId: contributionId,
        entityLabel: contribution.siteName,
        summary: `${contribution.siteName} withdrew their contribution.`,
      });

      return { withdrawn: true };
    });
  }

  /**
   * Confirms the food physically moved. Early is allowed — kitchens finish
   * service before the window opens — but not more than two hours early.
   */
  async handover(caller: Jwtpayload, contributionId: number, req?: RequestContext) {
    const contribution = await this.loadForWrite(caller, contributionId);
    const { collection } = contribution;

    if (contribution.status === ConsolidatedContributionStatus.HANDED_OVER) {
      return { handedOver: true, method: collection.method, alreadyDone: true };
    }
    if (contribution.status !== ConsolidatedContributionStatus.SUBMITTED) {
      throw new ConflictException(`This contribution is ${contribution.status.toLowerCase()}.`);
    }

    const now = new Date();
    if (now.getTime() < collection.handoverStartAt.getTime() - HOURS_2) {
      throw new ConflictException('It is too early to confirm handover.');
    }

    const actor = await this.audit.actorFrom(caller, req);

    await this.prisma.$transaction(async (tx) => {
      await tx.consolidatedContribution.update({
        where: { id: contributionId },
        data: {
          status: ConsolidatedContributionStatus.HANDED_OVER,
          handoverAt: now,
          handoverByUserId: caller.sub,
        },
      });

      await this.audit.log(tx, actor, {
        organisationId: collection.organisationId,
        action: CONSOLIDATED_ACTION.CONTRIBUTION_HANDOVER,
        entityType: 'ConsolidatedContribution',
        entityId: contributionId,
        entityLabel: contribution.siteName,
        summary: `${contribution.siteName} confirmed handover.`,
      });
    });

    await this.notifier
      .handoverConfirmed(collection.id, contribution.siteName)
      .catch((e) => this.logger.warn(e));

    return { handedOver: true, method: collection.method, alreadyDone: false };
  }

  // ─── B8.5 Manager decisions ────────────────────────────────────────────────

  async decideLate(
    caller: Jwtpayload, contributionId: number, approve: boolean,
    dto: LateDecisionDto, req?: RequestContext,
  ) {
    const contribution = await this.loadForWrite(caller, contributionId, { managerOnly: true });

    if (contribution.status !== ConsolidatedContributionStatus.LATE_PENDING_APPROVAL) {
      throw new ConflictException('This contribution is not waiting for a late decision.');
    }

    const actor = await this.audit.actorFrom(caller, req);
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.consolidatedContribution.update({
        where: { id: contributionId },
        data: {
          status: approve
            ? ConsolidatedContributionStatus.SUBMITTED
            : ConsolidatedContributionStatus.REJECTED_LATE,
          lateDecidedAt: now,
          lateDecidedByUserId: caller.sub,
          lateDecisionReason: dto.reason?.trim() ?? null,
        },
      });

      if (!approve && contribution.listingId) {
        await tx.foodListing.update({
          where: { id: contribution.listingId },
          data: { status: ListingStatus.CANCELLED },
        });
        await tx.consolidatedItem.updateMany({
          where: { contributionId },
          data: { outcome: ConsolidatedItemOutcome.EXCLUDED },
        });
      }

      await this.audit.log(tx, actor, {
        organisationId: contribution.collection.organisationId,
        action: approve
          ? CONSOLIDATED_ACTION.CONTRIBUTION_LATE_APPROVED
          : CONSOLIDATED_ACTION.CONTRIBUTION_LATE_REJECTED,
        entityType: 'ConsolidatedContribution',
        entityId: contributionId,
        entityLabel: contribution.siteName,
        summary: `${approve ? 'Accepted' : 'Declined'} a late contribution from ${contribution.siteName}.`,
      });
    });

    await this.notifier.lateDecided(contributionId, approve).catch((e) => this.logger.warn(e));
    return { approved: approve };
  }

  async listChangeRequests(caller: Jwtpayload, collectionId: number) {
    const collection = await this.prisma.consolidatedCollection.findFirst({
      where: { id: collectionId, organisationId: caller.orgId },
      select: { groupId: true },
    });
    if (!collection) throw new NotFoundException('Collection not found.');
    await this.access.assertManager(caller, collection.groupId);

    return this.prisma.consolidatedChangeRequest.findMany({
      where: { collectionId, status: ConsolidatedChangeRequestStatus.PENDING },
      include: {
        contribution: {
          include: { site: { select: { id: true, name: true, organisationName: true } } },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Approving applies the payload directly.
   *
   * Quantities going **up**, or new items appearing, resets the receipt: the
   * manager verified food that is no longer what is there. Quantities going
   * down are trimmed against what was already verified instead.
   */
  async decideChangeRequest(
    caller: Jwtpayload, changeRequestId: number, approve: boolean,
    dto: ChangeRequestDecisionDto, req?: RequestContext,
  ) {
    const request = await this.prisma.consolidatedChangeRequest.findUnique({
      where: { id: changeRequestId },
      include: {
        contribution: {
          include: {
            collection: { select: { id: true, groupId: true, organisationId: true } },
            site: { select: { name: true, organisationName: true } },
          },
        },
      },
    });
    if (!request) throw new NotFoundException('Change request not found.');
    if (request.status !== ConsolidatedChangeRequestStatus.PENDING) {
      throw new ConflictException('This request has already been decided.');
    }

    await this.access.assertManager(caller, request.contribution.collection.groupId);
    const actor = await this.audit.actorFrom(caller, req);
    const siteName = request.contribution.site.name ?? request.contribution.site.organisationName;

    if (!approve) {
      await this.prisma.$transaction(async (tx) => {
        await tx.consolidatedChangeRequest.update({
          where: { id: changeRequestId },
          data: {
            status: ConsolidatedChangeRequestStatus.REJECTED,
            decidedByUserId: caller.sub,
            decidedAt: new Date(),
            decisionReason: dto.reason?.trim() ?? null,
          },
        });
        await this.audit.log(tx, actor, {
          organisationId: request.contribution.collection.organisationId,
          action: CONSOLIDATED_ACTION.CHANGE_REQUEST_REJECTED,
          entityType: 'ConsolidatedChangeRequest',
          entityId: changeRequestId,
          entityLabel: siteName,
          summary: `Declined a change from ${siteName}.`,
        });
      });
      return { approved: false };
    }

    const payload = request.payload as unknown as UpdateContributionDto;
    await this.applyUpdate(
      request.contributionId, payload, actor, caller,
      `Applied a change requested by ${siteName}`,
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.consolidatedChangeRequest.update({
        where: { id: changeRequestId },
        data: {
          status: ConsolidatedChangeRequestStatus.APPROVED,
          decidedByUserId: caller.sub,
          decidedAt: new Date(),
        },
      });
      await this.audit.log(tx, actor, {
        organisationId: request.contribution.collection.organisationId,
        action: CONSOLIDATED_ACTION.CHANGE_REQUEST_APPROVED,
        entityType: 'ConsolidatedChangeRequest',
        entityId: changeRequestId,
        entityLabel: siteName,
        summary: `Approved a change from ${siteName}.`,
      });
    });

    // The master listing is resynced by the publish service (B9.2), which also
    // decides whether the charity has to acknowledge the change.
    return { approved: true, contributionId: request.contributionId };
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private assertDeclaration(declaration: DeclarationAcceptanceDto, expected: string) {
    if (!declaration?.accepted || declaration.version !== expected) {
      throw new BadRequestException(
        'You must accept the current food safety declaration to continue.',
      );
    }
  }

  /**
   * Late means submissions are shut but the food can still physically make the
   * pickup. Past that, the collection is simply not open to this site.
   */
  private resolveLateness(
    collection: { status: ConsolidatedCollectionStatus; pickupStartAt: Date },
    now: Date,
  ): boolean {
    if (collection.status === ConsolidatedCollectionStatus.OPEN) return false;

    const stillJoinable = (
      [
        ConsolidatedCollectionStatus.SUBMISSIONS_CLOSED,
        ConsolidatedCollectionStatus.PUBLISHED,
        ConsolidatedCollectionStatus.CLAIMED,
      ] as ConsolidatedCollectionStatus[]
    ).includes(collection.status);

    if (stillJoinable && now < collection.pickupStartAt) return true;

    throw new ConflictException({
      error: CONSOLIDATED_ERROR.SUBMISSIONS_CLOSED,
      message: 'This collection is no longer accepting food.',
    });
  }

  private async loadForWrite(
    caller: Jwtpayload, contributionId: number, opts: { managerOnly?: boolean } = {},
  ) {
    const row = await this.prisma.consolidatedContribution.findUnique({
      where: { id: contributionId },
      include: {
        collection: true,
        site: { select: { name: true, organisationName: true } },
      },
    });
    if (!row || row.collection.organisationId !== caller.orgId) {
      throw new NotFoundException('Contribution not found.');
    }

    if (opts.managerOnly) {
      await this.access.assertManager(caller, row.collection.groupId);
    } else {
      // A manager may act for any of their sites; otherwise it must be the
      // site's own user. Either way, another site's row stays invisible.
      const isManager = await this.access.canManageFlag(caller);
      if (isManager) {
        await this.access.assertManager(caller, row.collection.groupId);
      } else {
        await this.access.assertSiteUser(caller, row.siteId);
      }
    }

    return { ...row, siteName: row.site.name ?? row.site.organisationName };
  }

  /** One ledger row per source food item (R19). */
  private async writeLedger(
    tx: Prisma.TransactionClient,
    collectionId: number,
    contributionId: number,
    siteId: number,
    foodItems: { id: number; name: string; category: string | null; totalQtyKg: number }[],
  ) {
    await tx.consolidatedItem.createMany({
      data: foodItems.map((item) => ({
        collectionId,
        contributionId,
        siteId,
        sourceFoodItemId: item.id,
        name: item.name,
        category: item.category,
        submittedQtyKg: item.totalQtyKg,
      })),
      skipDuplicates: true,
    });
  }

  /** The direct edit path, shared by a site edit and an approved request. */
  private async applyUpdate(
    contributionId: number,
    dto: UpdateContributionDto,
    actor: Awaited<ReturnType<ConsolidatedAuditService['actorFrom']>>,
    caller: Jwtpayload,
    summary: string,
  ) {
    const contribution = await this.prisma.consolidatedContribution.findUniqueOrThrow({
      where: { id: contributionId },
      include: {
        collection: { select: { id: true, organisationId: true } },
        listing: { include: { foodItems: true } },
        site: { select: { name: true, organisationName: true } },
      },
    });
    if (!contribution.listingId || !contribution.listing) {
      throw new ConflictException('This contribution has no listing to update.');
    }

    const siteName = contribution.site.name ?? contribution.site.organisationName;
    const before = {
      totalQtyKg: contribution.listing.totalQtyKg,
      items: contribution.listing.foodItems.length,
    };

    return this.prisma.$transaction(async (tx) => {
      if (dto.foodItems?.length) {
        await this.replaceItems(tx, contribution.id, contribution.listingId!, contribution.collection.id, contribution.siteId, dto.foodItems);
      }

      const totalQtyKg = dto.foodItems?.length
        ? dto.foodItems.reduce((sum, i) => sum + i.totalQtyKg, 0)
        : contribution.listing!.totalQtyKg;

      await tx.foodListing.update({
        where: { id: contribution.listingId! },
        data: {
          totalQtyKg,
          remainingQtyKg: totalQtyKg,
          bestBefore: dto.bestBefore ? new Date(dto.bestBefore) : undefined,
          needsRefrigeration: dto.needsRefrigeration,
          needsAmbient: dto.needsAmbient,
          needsFreezer: dto.needsFreezer,
          needsHot: dto.needsHot,
          needsReheating: dto.needsReheating,
          allergens: dto.allergens,
          photoUrls: dto.photoUrls,
          collectionNotes: dto.collectionNotes?.trim(),
        },
      });

      // Verified food has changed since it was checked, so it must be checked
      // again rather than carrying a stale confirmation forward.
      const resetReceipt = contribution.receiptStatus !== ConsolidatedReceiptStatus.PENDING;
      if (resetReceipt) {
        await tx.consolidatedContribution.update({
          where: { id: contributionId },
          data: {
            receiptStatus: ConsolidatedReceiptStatus.PENDING,
            receiptAt: null,
            receiptByUserId: null,
            status: ConsolidatedContributionStatus.SUBMITTED,
          },
        });
      }

      await this.audit.log(tx, actor, {
        organisationId: contribution.collection.organisationId,
        action: CONSOLIDATED_ACTION.CONTRIBUTION_UPDATED,
        entityType: 'ConsolidatedContribution',
        entityId: contributionId,
        entityLabel: siteName,
        previousValue: before,
        newValue: { totalQtyKg, items: dto.foodItems?.length ?? before.items },
        summary: `${summary}${resetReceipt ? ' — receipt reset for re-check.' : '.'}`,
      });

      return { updated: true, receiptReset: resetReceipt, totalQtyKg };
    });
  }

  /**
   * Replaces the food items and keeps the ledger in step.
   *
   * Ledger rows for removed items are deleted rather than kept: before receipt
   * nothing has been verified, so there is no outcome worth preserving.
   */
  private async replaceItems(
    tx: Prisma.TransactionClient,
    contributionId: number,
    listingId: number,
    collectionId: number,
    siteId: number,
    items: ContributionItemDto[],
  ) {
    await tx.consolidatedItem.deleteMany({ where: { contributionId } });
    await tx.foodItem.deleteMany({ where: { listingId } });

    await tx.foodItem.createMany({
      data: items.map((item) => ({
        listingId,
        name: item.name,
        totalQtyKg: item.totalQtyKg,
        remainingQtyKg: item.totalQtyKg,
        unit: item.unit,
        category: item.category,
        quantityDescription: item.quantityDescription ?? null,
      })),
    });

    const created = await tx.foodItem.findMany({ where: { listingId } });
    await this.writeLedger(tx, collectionId, contributionId, siteId, created);
  }
}
