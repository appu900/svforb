import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  ClaimMode,
  ClaimStatus,
  DriverPickupStatus,
  FoodListingType,
  ListingStatus,
  OrgType,
} from '@prisma/client';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import { NotificationService } from '../../notifications/services/notification.service';
import { ListingGateway } from '../../../gateway/listing.gateway';
import { DriverLocationService } from '../../drivers/service/driver.location.service';
import { ClaimsCacheManager } from '../cache/claims.cachemanager';
import { CreateClaimDto, MarkCollectedDto, RateClaimDto } from '../dto/claims.dto';
import { resolveCallerSiteId } from '../../foodlisting/utils/resolve-caller-site';

const DEFAULT_LIMIT = 20;

const CLAIMANT_TYPES: Record<FoodListingType, OrgType[]> = {
  [FoodListingType.HUMAN]:  [OrgType.CHARITY, OrgType.CHARITY_SINGLE, OrgType.CHARITY_MULTI],
  [FoodListingType.ANIMAL]: [OrgType.FARMER_CONSUMER],
  [FoodListingType.BOTH]:   [OrgType.CHARITY, OrgType.CHARITY_SINGLE, OrgType.CHARITY_MULTI, OrgType.FARMER_CONSUMER],
};

@Injectable()
export class ClaimsService {
  private readonly logger = new Logger(ClaimsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: ClaimsCacheManager,
    private readonly notificationService: NotificationService,
    private readonly gateway: ListingGateway,
    private readonly driverService: DriverLocationService,
  ) {}

  async claimListing(caller: Jwtpayload, dto: CreateClaimDto) {
    if (!caller.orgId || !caller.orgType) {
      throw new ForbiddenException('Not part of an organisation');
    }

    const claimantOrg = await this.prisma.organisation.findUnique({
      where: { id: caller.orgId },
      select: { name: true },
    });
    const claimantSiteId = await resolveCallerSiteId(this.prisma, caller);

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM food_listings WHERE id = ${dto.listingId} FOR UPDATE`;

      const listing = await tx.foodListing.findUnique({
        where: { id: dto.listingId },
        include: {
          foodItems: true,
          organisation: { select: { name: true } },
        },
      });

      if (!listing) throw new NotFoundException('Listing not found');

      if (listing.status !== ListingStatus.ACTIVE && listing.status !== ListingStatus.PARTIAL) {
        throw new BadRequestException(`Listing is ${listing.status.toLowerCase()}, cannot claim`);
      }

      const now = new Date();
      if (listing.bestBefore && listing.bestBefore <= now) {
        throw new BadRequestException('This listing has expired');
      }
      if (listing.pickupByTime && listing.pickupByTime <= now) {
        throw new BadRequestException('The pickup window for this listing has ended');
      }

      if (listing.organisationId === caller.orgId) {
        throw new ForbiddenException('Cannot claim your own listing');
      }

      const eligible = CLAIMANT_TYPES[listing.listingType];
      if (!eligible.includes(caller.orgType!)) {
        throw new ForbiddenException(
          `Your organisation type cannot claim ${listing.listingType} listings`,
        );
      }

      let claimItemsData: { foodItemId: number; qtyKg: number }[];

      if (dto.claimMode === ClaimMode.FULL) {
        const available = listing.foodItems.filter((i) => i.remainingQtyKg > 0);
        if (!available.length) throw new BadRequestException('No remaining quantity on this listing');
        claimItemsData = available.map((i) => ({ foodItemId: i.id, qtyKg: i.remainingQtyKg }));
      } else {
        if (!dto.claimItems?.length) {
          throw new BadRequestException('claimItems are required for a partial claim');
        }

        const itemMap = new Map(listing.foodItems.map((i) => [i.id, i]));

        for (const ci of dto.claimItems) {
          const item = itemMap.get(ci.foodItemId);
          if (!item) {
            throw new BadRequestException(
              `Food item ${ci.foodItemId} does not belong to this listing`,
            );
          }
          if (ci.qtyKg > item.remainingQtyKg) {
            throw new BadRequestException(
              `Only ${item.remainingQtyKg}kg remaining for "${item.name}"`,
            );
          }
        }

        claimItemsData = dto.claimItems;
      }

      const totalClaimedKg = claimItemsData.reduce((sum, ci) => sum + ci.qtyKg, 0);
      const newRemainingQtyKg = listing.remainingQtyKg - totalClaimedKg;
      const newStatus = newRemainingQtyKg <= 0 ? ListingStatus.CLAIMED : ListingStatus.PARTIAL;

      // One active claim per site (not whole org) so Site B can claim PARTIAL leftovers.
      // Legacy claims with null claimantSiteId still block the whole org.
      const existingActiveClaim = await tx.foodClaim.findFirst({
        where: {
          listingId: dto.listingId,
          claimantOrgId: caller.orgId,
          status: { not: ClaimStatus.CANCELLED },
          OR: [
            ...(claimantSiteId != null ? [{ claimantSiteId }] : []),
            { claimantSiteId: null },
          ],
        },
      });

      if (existingActiveClaim) {
        throw new BadRequestException('You already have an active claim on this listing');
      }

      const claim = await tx.foodClaim.create({
        data: {
          listingId: dto.listingId,
          claimantOrgId: caller.orgId!,
          claimantSiteId,
          claimMode: dto.claimMode,
          status: ClaimStatus.PENDING,
          claimItems: { create: claimItemsData },
        },
        include: { claimItems: true },
      });

      await Promise.all(
        claimItemsData.map((ci) =>
          tx.foodItem.update({
            where: { id: ci.foodItemId },
            data: { remainingQtyKg: { decrement: ci.qtyKg } },
          }),
        ),
      );

      await tx.foodListing.update({
        where: { id: dto.listingId },
        data: {
          remainingQtyKg: newRemainingQtyKg,
          status: newStatus,
          uniqueClaimantCount: { increment: 1 },
        },
      });

      await tx.restaurantCharitySupport.upsert({
        where: {
          restaurantOrgId_charityOrgId: {
            restaurantOrgId: listing.organisationId,
            charityOrgId: caller.orgId!,
          },
        },
        create: {
          restaurantOrgId: listing.organisationId,
          charityOrgId: caller.orgId!,
          totalClaimsCount: 1,
        },
        update: {
          lastClaimedAt: new Date(),
          totalClaimsCount: { increment: 1 },
        },
      });

      await tx.listingActivity.create({
        data: {
          listingId: dto.listingId,
          actorOrgId: caller.orgId!,
          eventType: dto.claimMode === ClaimMode.FULL ? 'CLAIMED_FULL' : 'CLAIMED_PARTIAL',
          message:
            dto.claimMode === ClaimMode.FULL
              ? `Full claim of ${totalClaimedKg}kg`
              : `Partial claim of ${totalClaimedKg}kg — ${newRemainingQtyKg}kg remaining`,
          qtyKg: totalClaimedKg,
        },
      });

      return { claim, listing, totalClaimedKg, newRemainingQtyKg, newStatus };
    });

    await Promise.all([
      this.cache.delListingClaims(dto.listingId),
      this.cache.invalidateMyClaims(caller.orgId!),
      this.cache.invalidateListing(dto.listingId),
      this.cache.invalidateRecentPage1(),
      this.cache.invalidateAllNearby(),
    ]);

    this.gateway.pushListingEvents(dto.listingId, {
      listingId: dto.listingId,
      eventType: dto.claimMode === ClaimMode.FULL ? 'CLAIMED_FULL' : 'CLAIMED_PARTIAL',
      message:
        dto.claimMode === ClaimMode.FULL
          ? `${claimantOrg?.name} claimed the full listing (${result.totalClaimedKg}kg)`
          : `${claimantOrg?.name} partially claimed ${result.totalClaimedKg}kg — ${result.newRemainingQtyKg}kg remaining`,
      claimId: result.claim.id,
      timestamp: new Date().toISOString(),
    });

    // Notify the restaurant that a claim has been made (fan-out pipeline)
    const restaurantUserIds = await this.getOrgUserIds(result.listing.organisationId);
    if (restaurantUserIds.length) {
      await this.notificationService.send({
        title: 'New claim on your listing!',
        body: `${claimantOrg?.name ?? 'An organisation'} claimed ${result.totalClaimedKg}kg of food`,
        data: {
          claimId: String(result.claim.id),
          listingId: String(dto.listingId),
          type: 'claim_made',
        },
        targetUserIds: restaurantUserIds.map(String),
        priority: 'high',
      }).catch((err) =>
        this.logger.warn(`notifyClaimMade non-critical error: ${err.message}`),
      );
    }

    // When food is still partially available, re-notify all OTHER eligible orgs
    if (result.newStatus === ListingStatus.PARTIAL) {
      const eligibleUserIds = await this.getEligibleUserIds(
        result.listing.listingType,
        caller.orgId!,
      );
      if (eligibleUserIds.length) {
        await this.notificationService.send({
          title: 'Food still available nearby!',
          body: `${result.newRemainingQtyKg}kg still available from ${result.listing.organisation.name}`,
          data: {
            listingId: String(dto.listingId),
            type: 'partial_claim_update',
            remainingQtyKg: String(result.newRemainingQtyKg),
          },
          targetUserIds: eligibleUserIds.map(String),
          priority: 'normal',
        }).catch((err) =>
          this.logger.warn(`notifyPartialClaimUpdate non-critical error: ${err.message}`),
        );
      }
    }

    // Driver notify is deferred until the claimant taps Continue (requestDriverPickup).
    // Self-pickup should not ping drivers.

    this.logger.log(
      `Claim created: id=${result.claim.id} listing=${dto.listingId} org=${caller.orgId} mode=${dto.claimMode} qty=${result.totalClaimedKg}kg`,
    );

    return result.claim;
  }

  /**
   * Claimant chose driver collection (Continue) — notify online (live) drivers
   * on the claimant site only. Self-pickup must not call this.
   */
  async requestDriverPickup(caller: Jwtpayload, claimId: number) {
    if (!caller.orgId) throw new ForbiddenException('Not part of an organisation');

    const claim = await this.prisma.foodClaim.findUnique({
      where: { id: claimId },
      include: {
        claimItems: { select: { qtyKg: true } },
        listing: {
          select: {
            id: true,
            organisation: { select: { name: true } },
          },
        },
      },
    });

    if (!claim) throw new NotFoundException('Claim not found');
    if (claim.claimantOrgId !== caller.orgId) {
      throw new ForbiddenException('Only the claimant can request a driver for this claim');
    }
    if (
      claim.status === ClaimStatus.COLLECTED ||
      claim.status === ClaimStatus.CANCELLED
    ) {
      throw new BadRequestException(
        `Cannot request a driver for a ${claim.status.toLowerCase()} claim`,
      );
    }

    const activePickup = await this.prisma.driverPickup.findFirst({
      where: {
        claimId,
        status: {
          in: [
            DriverPickupStatus.ASSIGNED,
            DriverPickupStatus.ACCEPTED,
            DriverPickupStatus.EN_ROUTE,
            DriverPickupStatus.ARRIVED,
          ],
        },
      },
      select: { id: true },
    });
    if (activePickup) {
      return {
        message: 'A driver is already assigned to this claim',
        claimId,
        notifiedDrivers: 0,
        onlineDrivers: 0,
        alreadyAssigned: true,
      };
    }

    const siteId =
      claim.claimantSiteId ??
      (await resolveCallerSiteId(this.prisma, caller)) ??
      null;

    if (!siteId) {
      throw new BadRequestException(
        'No site context for this claim. Assign a site before requesting a driver.',
      );
    }

    const liveDrivers = (await this.driverService.getLiveDriversForSite(siteId)).filter(
      (driver) => driver.orgId === caller.orgId && driver.siteId === siteId,
    );
    const liveUserIds = [...new Set(liveDrivers.map((d) => d.userId))];

    const totalClaimedKg = claim.claimItems.reduce((sum, item) => sum + item.qtyKg, 0);

    if (liveUserIds.length) {
      await this.notificationService
        .send({
          title: 'Pickup available!',
          body: `${totalClaimedKg}kg ready for collection from ${claim.listing.organisation.name}`,
          data: {
            claimId: String(claim.id),
            listingId: String(claim.listing.id),
            type: 'pickup_available',
            claimMode: claim.claimMode,
          },
          targetUserIds: liveUserIds.map(String),
          targetApp: 'driver',
          allowEmptyTargets: true,
          priority: 'high',
        })
        .catch((err) =>
          this.logger.warn(`requestDriverPickup notify non-critical error: ${err.message}`),
        );
      this.logger.log(
        `requestDriverPickup: notified ${liveUserIds.length} online driver(s) claim=${claimId} site=${siteId}`,
      );
    } else {
      this.logger.warn(
        `requestDriverPickup: no online drivers on site=${siteId} for claim=${claimId}`,
      );
    }

    return {
      message:
        liveUserIds.length > 0
          ? `Notified ${liveUserIds.length} online driver(s)`
          : 'No online drivers right now. They’ll see the pickup when they go live, or assign one from Home → Drivers.',
      claimId,
      siteId,
      notifiedDrivers: liveUserIds.length,
      onlineDrivers: liveUserIds.length,
      alreadyAssigned: false,
    };
  }

  async confirmClaim(caller: Jwtpayload, claimId: number) {
    if (!caller.orgId) throw new ForbiddenException('Not part of an organisation');

    const claim = await this.prisma.foodClaim.findUnique({
      where: { id: claimId },
      include: {
        listing: {
          include: { organisation: { select: { name: true } } },
        },
      },
    });

    if (!claim) throw new NotFoundException('Claim not found');
    if (claim.listing.organisationId !== caller.orgId) {
      throw new ForbiddenException('Only the listing organisation can confirm a claim');
    }
    if (claim.status !== ClaimStatus.PENDING) {
      throw new BadRequestException(`Claim is already ${claim.status.toLowerCase()}`);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.foodClaim.update({
        where: { id: claimId },
        data: { status: ClaimStatus.CONFIRMED, confirmedAt: new Date() },
      });

      await tx.listingActivity.create({
        data: {
          listingId: claim.listingId,
          actorOrgId: caller.orgId!,
          eventType: 'CLAIM_CONFIRMED',
          message: `Claim #${claimId} confirmed by ${claim.listing.organisation.name}`,
          qtyKg: null,
        },
      });
    });

    await this.cache.delListingClaims(claim.listingId);

    this.gateway.pushListingEvents(claim.listingId, {
      listingId: claim.listingId,
      eventType: 'CLAIM_CONFIRMED',
      message: `Claim #${claimId} confirmed by ${claim.listing.organisation.name}`,
      claimId,
      timestamp: new Date().toISOString(),
    });

    const claimantUserIds = await this.getOrgUserIds(claim.claimantOrgId);

    // Notify the claimant their claim is confirmed
    if (claimantUserIds.length) {
      await this.notificationService.send({
        title: 'Your claim is confirmed!',
        body: `Collect from ${claim.listing.organisation.name} at ${claim.listing.pickupAddress}`,
        data: {
          claimId: String(claimId),
          listingId: String(claim.listingId),
          type: 'claim_confirmed',
        },
        targetUserIds: claimantUserIds.map(String),
        priority: 'high',
      }).catch((err) =>
        this.logger.warn(`notifyClaimConfirmed non-critical error: ${err.message}`),
      );
    }

    return { message: 'Claim confirmed' };
  }

  async cancelClaim(caller: Jwtpayload, claimId: number) {
    if (!caller.orgId) throw new ForbiddenException('Not part of an organisation');

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT fc.id FROM food_claims fc
        JOIN food_listings fl ON fl.id = fc.listing_id
        WHERE fc.id = ${claimId} FOR UPDATE
      `;

      const claim = await tx.foodClaim.findUnique({
        where: { id: claimId },
        include: {
          claimItems: true,
          listing: {
            include: { organisation: { select: { name: true } } },
          },
        },
      });

      if (!claim) throw new NotFoundException('Claim not found');

      const isClaimant   = claim.claimantOrgId === caller.orgId;
      const isListingOrg = claim.listing.organisationId === caller.orgId;

      if (!isClaimant && !isListingOrg) {
        throw new ForbiddenException('Not authorised to cancel this claim');
      }
      if (claim.status === ClaimStatus.COLLECTED) {
        throw new BadRequestException('Cannot cancel a collected claim');
      }
      if (claim.status === ClaimStatus.CANCELLED) {
        throw new BadRequestException('Claim is already cancelled');
      }

      await Promise.all(
        claim.claimItems.map((ci) =>
          tx.foodItem.update({
            where: { id: ci.foodItemId },
            data: { remainingQtyKg: { increment: ci.qtyKg } },
          }),
        ),
      );

      const restoredQty = claim.claimItems.reduce((sum, ci) => sum + ci.qtyKg, 0);

      const updatedListing = await tx.foodListing.update({
        where: { id: claim.listingId },
        data: { remainingQtyKg: { increment: restoredQty } },
        select: { remainingQtyKg: true, totalQtyKg: true, status: true },
      });

      if (
        updatedListing.status !== ListingStatus.CANCELLED &&
        updatedListing.status !== ListingStatus.EXPIRED
      ) {
        const newStatus =
          updatedListing.remainingQtyKg >= updatedListing.totalQtyKg
            ? ListingStatus.ACTIVE
            : ListingStatus.PARTIAL;

        await tx.foodListing.update({
          where: { id: claim.listingId },
          data: { status: newStatus },
        });
      }

      await tx.foodClaim.update({
        where: { id: claimId },
        data: { status: ClaimStatus.CANCELLED },
      });

      const cancellerName = isListingOrg
        ? claim.listing.organisation.name
        : 'claimant organisation';

      await tx.listingActivity.create({
        data: {
          listingId: claim.listingId,
          actorOrgId: caller.orgId!,
          eventType: 'CLAIM_CANCELLED',
          message: `Claim #${claimId} cancelled by ${cancellerName} — ${restoredQty}kg restored`,
          qtyKg: restoredQty,
        },
      });

      return { claim, isClaimant, cancellerName, restoredQty };
    });

    await Promise.all([
      this.cache.delListingClaims(result.claim.listingId),
      this.cache.invalidateMyClaims(result.claim.claimantOrgId),
      this.cache.invalidateListing(result.claim.listingId),
      this.cache.invalidateRecentPage1(),
      this.cache.invalidateAllNearby(),
    ]);

    this.gateway.pushListingEvents(result.claim.listingId, {
      listingId: result.claim.listingId,
      eventType: 'CLAIM_CANCELLED',
      message: `Claim #${claimId} cancelled by ${result.cancellerName} — ${result.restoredQty}kg restored`,
      claimId,
      timestamp: new Date().toISOString(),
    });

    const notifyOrgId = result.isClaimant
      ? result.claim.listing.organisationId
      : result.claim.claimantOrgId;

    const userIds = await this.getOrgUserIds(notifyOrgId);
    if (userIds.length) {
      await this.notificationService.send({
        title: 'Claim cancelled',
        body: `${result.cancellerName} cancelled a claim — ${result.restoredQty}kg restored`,
        data: {
          claimId: String(claimId),
          listingId: String(result.claim.listingId),
          type: 'claim_cancelled',
        },
        targetUserIds: userIds.map(String),
        priority: 'normal',
      }).catch((err) =>
        this.logger.warn(`notifyClaimCancelled non-critical error: ${err.message}`),
      );
    }

    return { message: 'Claim cancelled', restoredQtyKg: result.restoredQty };
  }

  async markCollected(caller: Jwtpayload, claimId: number, dto: MarkCollectedDto) {
    if (!caller.orgId) throw new ForbiddenException('Not part of an organisation');

    const claim = await this.prisma.foodClaim.findUnique({
      where: { id: claimId },
      include: { claimItems: true, listing: true },
    });

    if (!claim) throw new NotFoundException('Claim not found');
    if (claim.claimantOrgId !== caller.orgId) {
      throw new ForbiddenException('Only the claimant can mark as collected');
    }
    if (claim.status === ClaimStatus.COLLECTED) {
      return { message: 'Already marked as collected' };
    }
    if (claim.status !== ClaimStatus.CONFIRMED && claim.status !== ClaimStatus.PENDING) {
      throw new BadRequestException('Claim cannot be marked collected in its current status');
    }

    // Self-pickup: PENDING (or CONFIRMED) with no live driver assignment.
    // Once a driver pickup is active, collection must go through the driver path.
    const activeDriverPickup = await this.prisma.driverPickup.findFirst({
      where: {
        claimId,
        status: {
          in: [
            DriverPickupStatus.ASSIGNED,
            DriverPickupStatus.ACCEPTED,
            DriverPickupStatus.EN_ROUTE,
            DriverPickupStatus.ARRIVED,
          ],
        },
      },
      select: { id: true },
    });
    if (activeDriverPickup) {
      throw new BadRequestException(
        'This claim has an assigned driver. Complete collection via the driver pickup flow.',
      );
    }

    const totalQtyKg = claim.claimItems.reduce((sum, ci) => sum + ci.qtyKg, 0);

    const updated = await this.prisma.$transaction(async (tx) => {
      const claimUpdate = await tx.foodClaim.updateMany({
        where: {
          id: claimId,
          status: { in: [ClaimStatus.CONFIRMED, ClaimStatus.PENDING] },
        },
        data: {
          status: ClaimStatus.COLLECTED,
          collectedAt: new Date(),
          ...(dto.rating !== undefined
            ? { rating: dto.rating, ratingNote: dto.ratingNote ?? null }
            : {}),
        },
      });

      if (claimUpdate.count === 0) {
        return false;
      }

      if (dto.rating !== undefined) {
        const org = await tx.organisation.findUnique({
          where: { id: claim.listing.organisationId },
          select: { ratingAvg: true, ratingCount: true },
        });
        const newAvg = org
          ? (org.ratingAvg * org.ratingCount + dto.rating) / (org.ratingCount + 1)
          : dto.rating;

        await tx.organisation.update({
          where: { id: claim.listing.organisationId },
          data: { ratingAvg: newAvg, ratingCount: { increment: 1 } },
        });
      }

      await tx.listingActivity.create({
        data: {
          listingId: claim.listingId,
          actorOrgId: caller.orgId!,
          eventType: 'CLAIM_COLLECTED',
          message: `${totalQtyKg}kg collected${dto.rating !== undefined ? ` — rated ${dto.rating}/5` : ''}`,
          qtyKg: totalQtyKg,
        },
      });

      return true;
    });

    if (!updated) {
      return { message: 'Already marked as collected' };
    }

    await Promise.all([
      this.cache.delListingClaims(claim.listingId),
      this.cache.invalidateMyClaims(caller.orgId!),
      this.cache.invalidateListing(claim.listingId),
      this.cache.invalidateAllNearby(),
    ]);

    this.gateway.pushListingEvents(claim.listingId, {
      listingId: claim.listingId,
      eventType: 'CLAIM_COLLECTED',
      message: `${totalQtyKg}kg collected${dto.rating !== undefined ? ` — rated ${dto.rating}/5` : ''}`,
      claimId,
      timestamp: new Date().toISOString(),
    });

    return { message: 'Marked as collected' };
  }

  /**
   * Lets the claimant rate a collection after the fact. markCollected already
   * accepts a rating at collection time; this covers the Updates feedback card
   * which appears once the claim is already COLLECTED.
   */
  async rateClaim(caller: Jwtpayload, claimId: number, dto: RateClaimDto) {
    if (!caller.orgId) throw new ForbiddenException('Not part of an organisation');

    const claim = await this.prisma.foodClaim.findUnique({
      where: { id: claimId },
      include: { listing: { select: { organisationId: true, id: true } } },
    });

    if (!claim) throw new NotFoundException('Claim not found');
    if (claim.claimantOrgId !== caller.orgId) {
      throw new ForbiddenException('Only the claimant can rate this collection');
    }
    if (claim.status !== ClaimStatus.COLLECTED) {
      throw new BadRequestException('You can only rate a completed collection');
    }
    if (claim.rating != null) {
      throw new ConflictException('This collection has already been rated');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.foodClaim.update({
        where: { id: claimId },
        data: {
          rating: dto.rating,
          ratingNote: dto.ratingNote ?? null,
        },
      });

      const org = await tx.organisation.findUnique({
        where: { id: claim.listing.organisationId },
        select: { ratingAvg: true, ratingCount: true },
      });
      const newAvg = org
        ? (org.ratingAvg * org.ratingCount + dto.rating) / (org.ratingCount + 1)
        : dto.rating;

      await tx.organisation.update({
        where: { id: claim.listing.organisationId },
        data: { ratingAvg: newAvg, ratingCount: { increment: 1 } },
      });

      await tx.listingActivity.create({
        data: {
          listingId: claim.listingId,
          actorOrgId: caller.orgId!,
          eventType: 'CLAIM_RATED',
          message: `Collection rated ${dto.rating}/5`,
        },
      });
    });

    await Promise.all([
      this.cache.delListingClaims(claim.listingId),
      this.cache.invalidateMyClaims(caller.orgId!),
      this.cache.invalidateListing(claim.listingId),
    ]);

    return { message: 'Thanks for your feedback', rating: dto.rating };
  }

  async getMyClaims(caller: Jwtpayload, page = 1, limit = DEFAULT_LIMIT, status?: ClaimStatus) {
    if (!caller.orgId) throw new ForbiddenException('Not part of an organisation');

    const cached = status ? null : await this.cache.getMyClaims(caller.orgId, page);
    if (cached) return cached;

    const skip = (page - 1) * limit;
    const where = {
      claimantOrgId: caller.orgId,
      ...(status ? { status } : {}),
    };

    const [claims, total] = await Promise.all([
      this.prisma.foodClaim.findMany({
        where,
        include: {
          claimItems: {
            include: { foodItem: { select: { id: true, name: true, unit: true, totalQtyKg: true } } },
          },
          claimantSite: {
            select: {
              id: true,
              organisationName: true,
              address: true,
              postcode: true,
              contactMobile: true,
              contactName: true,
            },
          },
          driverPickups: {
            orderBy: [{ collectedAt: 'desc' }, { createdAt: 'desc' }],
            take: 3,
            select: {
              id: true,
              status: true,
              collectedAt: true,
              driver: {
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                  phoneNumber: true,
                },
              },
            },
          },
          listing: {
            select: {
              id: true,
              listingType: true,
              pickupAddress: true,
              pickupPostcode: true,
              pickupLat: true,
              pickupLng: true,
              pickupFromTime: true,
              pickupByTime: true,
              bestBefore: true,
              status: true,
              totalQtyKg: true,
              remainingQtyKg: true,
              needsRefrigeration: true,
              needsHot: true,
              needsReheating: true,
              foodItems: {
                select: {
                  id: true,
                  name: true,
                  totalQtyKg: true,
                  remainingQtyKg: true,
                  unit: true,
                },
              },
              site: {
                select: {
                  id: true,
                  organisationName: true,
                  address: true,
                  postcode: true,
                  contactMobile: true,
                  contactName: true,
                },
              },
              organisation: { select: { id: true, name: true, logoUrl: true, address: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.foodClaim.count({ where }),
    ]);

    const result = { claims, total, page, limit, totalPages: Math.ceil(total / limit) };

    if (!status) await this.cache.setMyClaims(caller.orgId, page, result);

    return result;
  }

  async getListingClaims(caller: Jwtpayload, listingId: number) {
    if (!caller.orgId) throw new ForbiddenException('Not part of an organisation');

    const listing = await this.prisma.foodListing.findFirst({
      where: { id: listingId, organisationId: caller.orgId },
    });
    if (!listing) throw new NotFoundException('Listing not found in your organisation');

    const cached = await this.cache.getListingClaims(listingId);
    if (cached) return cached;

    const claims = await this.prisma.foodClaim.findMany({
      where: { listingId, status: { not: ClaimStatus.CANCELLED } },
      include: {
        claimItems: {
          include: { foodItem: { select: { name: true, unit: true } } },
        },
        claimantOrg: { select: { id: true, name: true, logoUrl: true, organizationType: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    await this.cache.setListingClaims(listingId, claims);

    return claims;
  }

  async getClaimActivity(caller: Jwtpayload, listingId: number) {
    if (!caller.orgId) throw new ForbiddenException('Not part of an organisation');

    const listing = await this.prisma.foodListing.findFirst({
      where: {
        id: listingId,
        OR: [
          { organisationId: caller.orgId },
          { foodClaims: { some: { claimantOrgId: caller.orgId } } },
        ],
      },
    });
    if (!listing) throw new NotFoundException('Listing not found or not accessible');

    return this.prisma.listingActivity.findMany({
      where: { listingId },
      orderBy: { createdAt: 'asc' },
      include: { actorOrg: { select: { id: true, name: true, logoUrl: true } } },
    });
  }

  private async getOrgUserIds(orgId: number): Promise<number[]> {
    const users = await this.prisma.user.findMany({
      where: {
        isActive: true,
        orgMemeberShips: { some: { organisationId: orgId } },
      },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }

  private async getEligibleUserIds(
    listingType: FoodListingType,
    excludeOrgId: number,
  ): Promise<number[]> {
    const eligibleTypes = CLAIMANT_TYPES[listingType];
    const users = await this.prisma.user.findMany({
      where: {
        isActive: true,
        orgMemeberShips: {
          some: {
            organisation: {
              organizationType: { in: eligibleTypes },
              id: { not: excludeOrgId },
            },
          },
        },
      },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }
}
