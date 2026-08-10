import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ClaimStatus, DriverPickupStatus, SiteRole } from '@prisma/client';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { RedisService } from '../../../infra/redis/redis.service';
import { S3Service } from '../../../uploads/s3/s3.service';
import { NotificationService } from '../../../modules/notifications/services/notification.service';

const DRIVER_TTL_SECONDS = 8 * 60 * 60;
const PHOTO_FOLDER = 'driver-pickups';

/** Active trip or pending assignment — blocks another assign / self-accept. */
const CURRENT_STATUSES = [
  DriverPickupStatus.ASSIGNED,
  DriverPickupStatus.ACCEPTED,
  DriverPickupStatus.EN_ROUTE,
  DriverPickupStatus.ARRIVED,
];

const PAST_STATUSES = [DriverPickupStatus.COLLECTED, DriverPickupStatus.CANCELLED];

export interface LiveDriverInfo {
  userId: number;
  siteId: number;
  orgId: number;
  name: string;
  phone: string;
  vehicleType: string | null;
  lat: number;
  lng: number;
  deviceToken: string | null;
}

@Injectable()
export class DriverLocationService {
  private readonly logger = new Logger(DriverLocationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly s3: S3Service,
    private readonly notificationService: NotificationService,
  ) {}

  private liveKey(userId: number) {
    return `driver:live:${userId}`;
  }

  private siteLiveSetKey(siteId: number) {
    return `drivers:live:site:${siteId}`;
  }

  // ─── Go Live / Offline ───────────────────────────────────────────────────────

  async goLive(
    userId: number,
    siteId: number,
    lat: number,
    lng: number,
    vehicleType?: string,
  ): Promise<LiveDriverInfo | null> {
    const [user, siteAccess] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { firstName: true, lastName: true, phoneNumber: true, deviceToken: true },
      }),
      this.prisma.siteAccess.findFirst({
        where: { userId, siteId, siteRole: SiteRole.DRIVER },
        select: { organisationId: true },
      }),
    ]);

    if (!user || !siteAccess) {
      this.logger.warn(`goLive failed: userId=${userId} not a DRIVER on site=${siteId}`);
      return null;
    }

    const info: LiveDriverInfo = {
      userId,
      siteId,
      orgId: siteAccess.organisationId,
      name: `${user.firstName} ${user.lastName}`,
      phone: user.phoneNumber,
      vehicleType: vehicleType ?? null,
      lat,
      lng,
      deviceToken: user.deviceToken,
    };

    const client = this.redis.getClient();
    await Promise.all([
      client.setex(this.liveKey(userId), DRIVER_TTL_SECONDS, JSON.stringify(info)),
      client.sadd(this.siteLiveSetKey(siteId), String(userId)),
    ]);

    this.logger.log(`Driver ${userId} (${info.name}) went live on site ${siteId}`);
    return info;
  }

  async goOffline(userId: number, siteId: number): Promise<void> {
    const client = this.redis.getClient();
    await Promise.all([
      client.del(this.liveKey(userId)),
      client.srem(this.siteLiveSetKey(siteId), String(userId)),
    ]);
    this.logger.log(`Driver ${userId} went offline from site ${siteId}`);
  }

  async getDriverInfo(userId: number): Promise<LiveDriverInfo | null> {
    const raw = await this.redis.getClient().get(this.liveKey(userId));
    return raw ? (JSON.parse(raw) as LiveDriverInfo) : null;
  }

  async getLiveDriversForSite(siteId: number): Promise<LiveDriverInfo[]> {
    const client = this.redis.getClient();
    const memberIds = await client.smembers(this.siteLiveSetKey(siteId));
    if (!memberIds.length) return [];

    const values = await client.mget(...memberIds.map((id) => this.liveKey(Number(id))));

    const live: LiveDriverInfo[] = [];
    const staleIds: string[] = [];

    for (let i = 0; i < memberIds.length; i++) {
      if (!values[i]) {
        staleIds.push(memberIds[i]);
      } else {
        live.push(JSON.parse(values[i]!));
      }
    }

    if (staleIds.length) {
      await client.srem(this.siteLiveSetKey(siteId), ...staleIds);
    }

    return live;
  }

  async updateLocation(userId: number, lat: number, lng: number): Promise<LiveDriverInfo | null> {
    const client = this.redis.getClient();
    const raw = await client.get(this.liveKey(userId));
    if (!raw) return null;

    const info: LiveDriverInfo = JSON.parse(raw);
    info.lat = lat;
    info.lng = lng;

    const remainingTtl = await client.ttl(this.liveKey(userId));
    await client.setex(
      this.liveKey(userId),
      remainingTtl > 0 ? remainingTtl : DRIVER_TTL_SECONDS,
      JSON.stringify(info),
    );

    return info;
  }

  // ─── Pickup Acceptance ───────────────────────────────────────────────────────

  async acceptPickup(driverId: number, claimId: number, listingId: number) {
    const driverInfo = await this.getDriverInfo(driverId);
    if (!driverInfo) {
      throw new ForbiddenException('You must be live to accept pickups');
    }

    const existing = await this.prisma.driverPickup.findFirst({
      where: { claimId, status: { in: CURRENT_STATUSES } },
    });
    if (existing) {
      throw new ConflictException('This claim is already being handled by another driver');
    }

    const [pickup, listing] = await Promise.all([
      this.prisma.driverPickup.create({
        data: { driverId, claimId, listingId, status: DriverPickupStatus.ACCEPTED },
      }),
      this.prisma.foodListing.findUnique({
        where: { id: listingId },
        select: {
          pickupLat: true,
          pickupLng: true,
          pickupAddress: true,
          pickupFromTime: true,
          pickupByTime: true,
          organisation: { select: { name: true, logoUrl: true } },
        },
      }),
    ]);

    const claim = await this.prisma.foodClaim.findUnique({
      where: { id: claimId },
      select: { claimantOrgId: true },
    });
    if (claim?.claimantOrgId) {
      await this.redis
        .del(`claims:org:v3:${claim.claimantOrgId}:p1`)
        .catch(() => undefined);
    }

    this.logger.log(`Driver ${driverId} accepted claim=${claimId} listing=${listingId}`);

    return {
      pickup,
      restaurant: {
        name: listing?.organisation.name,
        logoUrl: listing?.organisation.logoUrl,
        address: listing?.pickupAddress,
        lat: listing?.pickupLat,
        lng: listing?.pickupLng,
        pickupFromTime: listing?.pickupFromTime,
        pickupByTime: listing?.pickupByTime,
      },
    };
  }

  // ─── Driver Pickup List ───────────────────────────────────────────────────────

  async getMyPickups(driverId: number, filter: 'current' | 'past') {
    const statuses = filter === 'current' ? CURRENT_STATUSES : PAST_STATUSES;

    return this.prisma.driverPickup.findMany({
      where: { driverId, status: { in: statuses } },
      include: {
        claim: {
          select: {
            id: true,
            claimMode: true,
            status: true,
            claimItems: {
              include: { foodItem: { select: { name: true, unit: true } } },
            },
            claimantOrg: { select: { name: true, logoUrl: true } },
          },
        },
        listing: {
          select: {
            pickupAddress: true,
            pickupLat: true,
            pickupLng: true,
            pickupFromTime: true,
            pickupByTime: true,
            bestBefore: true,
            totalQtyKg: true,
            organisation: { select: { name: true, logoUrl: true } },
          },
        },
      },
      orderBy: { acceptedAt: 'desc' },
    });
  }

  // ─── Pickup Details ───────────────────────────────────────────────────────────

  async getPickupDetails(pickupId: number, driverId: number) {
    const pickup = await this.prisma.driverPickup.findFirst({
      where: { id: pickupId, driverId },
      include: {
        claim: {
          include: {
            claimItems: {
              include: {
                foodItem: { select: { name: true, unit: true, category: true } },
              },
            },
            claimantOrg: { select: { name: true, logoUrl: true, address: true } },
          },
        },
        listing: {
          select: {
            pickupAddress: true,
            pickupLat: true,
            pickupLng: true,
            pickupFromTime: true,
            pickupByTime: true,
            bestBefore: true,
            totalQtyKg: true,
            allergens: true,
            needsRefrigeration: true,
            needsAmbient: true,
            needsFreezer: true,
            needsReheating: true,
            organisation: { select: { name: true, logoUrl: true, address: true } },
          },
        },
      },
    });

    if (!pickup) throw new NotFoundException('Pickup not found');
    return pickup;
  }

  // ─── Status Update ────────────────────────────────────────────────────────────

  async updatePickupStatus(pickupId: number, driverId: number, status: DriverPickupStatus) {
    const pickup = await this.prisma.driverPickup.findFirst({
      where: { id: pickupId, driverId },
    });

    if (!pickup) throw new NotFoundException('Pickup not found');

    if (
      pickup.status === DriverPickupStatus.COLLECTED ||
      pickup.status === DriverPickupStatus.CANCELLED
    ) {
      throw new BadRequestException('Cannot update a completed or cancelled pickup');
    }

    if (pickup.status === DriverPickupStatus.ASSIGNED) {
      throw new BadRequestException(
        'Respond to the assignment (accept/decline) before updating trip status',
      );
    }

    if (status === DriverPickupStatus.COLLECTED) {
      throw new BadRequestException('Use the complete endpoint to mark as collected');
    }

    if (status === DriverPickupStatus.ASSIGNED) {
      throw new BadRequestException('Invalid status transition');
    }

    const timestamps: Record<string, Date> = {};
    if (status === DriverPickupStatus.ARRIVED) timestamps.arrivedAt = new Date();
    if (status === DriverPickupStatus.CANCELLED) timestamps.cancelledAt = new Date();

    return this.prisma.driverPickup.update({
      where: { id: pickupId },
      data: { status, ...timestamps },
    });
  }

  // ─── Complete Pickup ──────────────────────────────────────────────────────────

  async completePickup(
    pickupId: number,
    driverId: number,
    notes?: string,
    rating?: number,
    photo?: Express.Multer.File,
  ) {
    const pickup = await this.prisma.driverPickup.findFirst({
      where: { id: pickupId, driverId },
      include: {
        claim: {
          include: {
            claimItems: true,
            listing: { select: { organisationId: true } },
          },
        },
      },
    });

    if (!pickup) throw new NotFoundException('Pickup not found');
    if (pickup.status === DriverPickupStatus.COLLECTED) {
      return pickup;
    }
    if (pickup.status !== DriverPickupStatus.ARRIVED) {
      throw new BadRequestException('Mark as ARRIVED before completing the pickup');
    }

    const claimAlreadyCollected = pickup.claim.status === ClaimStatus.COLLECTED;

    let photoUrl: string | undefined;
    if (photo) {
      photoUrl = await this.s3.uploadFile(photo, PHOTO_FOLDER);
    }

    const totalQtyKg = pickup.claim.claimItems.reduce((sum, ci) => sum + ci.qtyKg, 0);
    const collectedAt = pickup.claim.collectedAt ?? new Date();

    return this.prisma.$transaction(async (tx) => {
      const updatedPickup = await tx.driverPickup.update({
        where: { id: pickupId },
        data: {
          status: DriverPickupStatus.COLLECTED,
          collectedAt,
          ...(notes !== undefined && { completionNotes: notes }),
          ...(rating !== undefined && { restaurantRating: rating }),
          ...(photoUrl && { photoUrl }),
        },
      });

      if (claimAlreadyCollected) {
        return updatedPickup;
      }

      const claimUpdate = await tx.foodClaim.updateMany({
        where: {
          id: pickup.claimId,
          status: { in: [ClaimStatus.PENDING, ClaimStatus.CONFIRMED] },
        },
        data: {
          status: ClaimStatus.COLLECTED,
          collectedAt,
          ...(rating !== undefined && { rating }),
        },
      });

      if (claimUpdate.count === 0) {
        return updatedPickup;
      }

      if (rating !== undefined) {
        const org = await tx.organisation.findUnique({
          where: { id: pickup.claim.listing.organisationId },
          select: { ratingAvg: true, ratingCount: true },
        });
        const newAvg = org
          ? (org.ratingAvg * org.ratingCount + rating) / (org.ratingCount + 1)
          : rating;

        await tx.organisation.update({
          where: { id: pickup.claim.listing.organisationId },
          data: { ratingAvg: newAvg, ratingCount: { increment: 1 } },
        });
      }

      await tx.listingActivity.create({
        data: {
          listingId: pickup.listingId,
          actorOrgId: pickup.claim.claimantOrgId,
          eventType: 'CLAIM_COLLECTED',
          message: `${totalQtyKg}kg collected by driver${rating !== undefined ? ` — rated ${rating}/5` : ''}`,
          qtyKg: totalQtyKg,
        },
      });

      return updatedPickup;
    });
  }

  // ─── Charity-initiated Driver Assignment ──────────────────────────────────────

  async assignDriverToPickup(
    assignerOrgId: number,
    claimId: number,
    listingId: number,
    driverId: number,
  ) {
    const claim = await this.prisma.foodClaim.findUnique({
      where: { id: claimId },
      include: {
        listing: {
          select: {
            id: true,
            pickupAddress: true,
            pickupFromTime: true,
            pickupByTime: true,
            totalQtyKg: true,
            organisation: { select: { id: true, name: true } },
          },
        },
        claimantOrg: { select: { id: true, name: true } },
      },
    });

    if (!claim) throw new NotFoundException('Claim not found');
    if (claim.listingId !== listingId) throw new BadRequestException('Listing does not match claim');
    if (claim.claimantOrgId !== assignerOrgId) {
      throw new ForbiddenException('You can only assign drivers for your own claims');
    }
    if (claim.status === ClaimStatus.COLLECTED || claim.status === ClaimStatus.CANCELLED) {
      throw new BadRequestException(
        `Cannot assign a driver to a ${claim.status.toLowerCase()} claim`,
      );
    }

    const driverAccess = await this.prisma.siteAccess.findFirst({
      where: { userId: driverId, siteRole: SiteRole.DRIVER, organisationId: assignerOrgId },
    });
    if (!driverAccess) {
      throw new ForbiddenException('The specified user is not a driver in your organisation');
    }

    // Prefer live drivers, but still allow assign + push when offline so
    // Continue → assign works without requiring the driver app to be open.
    const driverInfo = await this.getDriverInfo(driverId);
    if (driverInfo && driverInfo.orgId !== assignerOrgId) {
      throw new BadRequestException('Driver does not belong to your organisation');
    }

    const activePickup = await this.prisma.driverPickup.findFirst({
      where: { claimId, status: { in: CURRENT_STATUSES } },
    });
    if (activePickup) {
      throw new ConflictException('This claim already has an active driver assigned');
    }

    const driver = await this.prisma.user.findUnique({
      where: { id: driverId },
      select: { firstName: true, lastName: true, isActive: true },
    });
    if (!driver || !driver.isActive) throw new NotFoundException('Driver not found');

    const pickup = await this.prisma.driverPickup.create({
      data: { driverId, claimId, listingId, status: DriverPickupStatus.ASSIGNED },
    });

    const listing = claim.listing;

    // Bust my-claims cache so Available self-pickup drops this claim immediately.
    await this.redis.del(`claims:org:v3:${assignerOrgId}:p1`).catch(() => undefined);

    await this.notificationService
      .send({
        title: 'New pickup assigned to you!',
        body: `Collect ${listing.totalQtyKg}kg from ${listing.organisation.name} at ${listing.pickupAddress}`,
        data: {
          pickupId: String(pickup.id),
          claimId: String(claimId),
          listingId: String(listingId),
          type: 'driver_assigned',
          claimantOrgName: claim.claimantOrg.name,
        },
        targetUserIds: [String(driverId)],
        targetApp: 'driver',
        allowEmptyTargets: true,
        priority: 'high',
      })
      .catch((err) =>
        this.logger.warn(`notifyDriverAssigned non-critical error: ${err.message}`),
      );

    this.logger.log(
      `Driver ${driverId} assigned (pending accept) to claim=${claimId} listing=${listingId} by org=${assignerOrgId}${driverInfo ? '' : ' (offline)'}`,
    );

    return {
      pickup,
      driver: { name: `${driver.firstName} ${driver.lastName}` },
      restaurant: {
        name: listing.organisation.name,
        address: listing.pickupAddress,
        pickupFromTime: listing.pickupFromTime,
        pickupByTime: listing.pickupByTime,
      },
    };
  }

  async respondToPickupAssignment(pickupId: number, driverId: number, accept: boolean) {
    const pickup = await this.prisma.driverPickup.findFirst({
      where: { id: pickupId, driverId },
      include: {
        claim: {
          select: {
            id: true,
            claimantOrgId: true,
          },
        },
        listing: {
          select: {
            organisationId: true,
          },
        },
      },
    });

    if (!pickup) throw new NotFoundException('Pickup not found');

    if (pickup.status !== DriverPickupStatus.ASSIGNED) {
      throw new BadRequestException(
        pickup.status === DriverPickupStatus.CANCELLED ||
          pickup.status === DriverPickupStatus.COLLECTED
          ? 'Cannot respond to a completed or cancelled pickup'
          : 'This pickup is not awaiting a response',
      );
    }

    const driver = await this.prisma.user.findUnique({
      where: { id: driverId },
      select: { firstName: true, lastName: true },
    });
    const driverName = driver ? `${driver.firstName} ${driver.lastName}` : 'Driver';

    if (accept) {
      const updatedPickup = await this.prisma.driverPickup.update({
        where: { id: pickupId },
        data: { status: DriverPickupStatus.ACCEPTED },
      });

      const [charityUserIds, restaurantUserIds] = await Promise.all([
        this.getOrgUserIds(pickup.claim.claimantOrgId),
        this.getOrgUserIds(pickup.listing.organisationId),
      ]);

      const notifyUserIds = [...new Set([...charityUserIds, ...restaurantUserIds])];
      if (notifyUserIds.length > 0) {
        await this.notificationService
          .send({
            title: 'Driver accepted your pickup!',
            body: `${driverName} is on the way to collect the food`,
            data: {
              pickupId: String(pickupId),
              claimId: String(pickup.claimId),
              type: 'driver_accepted',
              driverName,
            },
            targetUserIds: notifyUserIds.map(String),
            priority: 'high',
          })
          .catch((err) =>
            this.logger.warn(`notifyDriverAccepted non-critical error: ${err.message}`),
          );
      }

      this.logger.log(`Driver ${driverId} accepted pickup ${pickupId}`);
      return { message: 'Pickup accepted', pickup: updatedPickup };
    }

    await this.prisma.driverPickup.update({
      where: { id: pickupId },
      data: { status: DriverPickupStatus.CANCELLED, cancelledAt: new Date() },
    });

    const charityUserIds = await this.getOrgUserIds(pickup.claim.claimantOrgId);
    if (charityUserIds.length > 0) {
      await this.notificationService
        .send({
          title: 'Driver declined the pickup',
          body: `${driverName} has declined the pickup. Please re-assign a driver.`,
          data: {
            pickupId: String(pickupId),
            claimId: String(pickup.claimId),
            type: 'driver_rejected',
            driverName,
          },
          targetUserIds: charityUserIds.map(String),
          priority: 'high',
        })
        .catch((err) =>
          this.logger.warn(`notifyDriverRejected non-critical error: ${err.message}`),
        );
    }

    this.logger.log(`Driver ${driverId} rejected pickup ${pickupId}`);
    return { message: 'Pickup declined. The charity has been notified.' };
  }

  /**
   * All drivers for a site with online/offline status (for charity/farmer home UI).
   */
  async getDriversForSite(callerOrgId: number, siteId: number) {
    const site = await this.prisma.site.findFirst({
      where: { id: siteId, organisationId: callerOrgId },
      select: { id: true },
    });
    if (!site) {
      throw new ForbiddenException('You do not have access to this site');
    }

    const accesses = await this.prisma.siteAccess.findMany({
      where: { siteId, siteRole: SiteRole.DRIVER, organisationId: callerOrgId },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            phoneNumber: true,
            isActive: true,
          },
        },
      },
    });

    const liveDrivers = await this.getLiveDriversForSite(siteId);
    const liveByUserId = new Map(liveDrivers.map((d) => [d.userId, d]));

    return {
      drivers: accesses
        .filter((a) => a.user.isActive)
        .map((a) => {
          const live = liveByUserId.get(a.user.id);
          return {
            id: a.user.id,
            name: `${a.user.firstName} ${a.user.lastName}`,
            phone: a.user.phoneNumber,
            online: !!live,
            vehicleType: live?.vehicleType ?? null,
            lat: live?.lat ?? null,
            lng: live?.lng ?? null,
          };
        }),
    };
  }

  /**
   * Claims owned by the org that still need a driver (no ASSIGNED/active trip).
   */
  async getUnclaimedClaims(callerOrgId: number) {
    const claims = await this.prisma.foodClaim.findMany({
      where: {
        claimantOrgId: callerOrgId,
        status: { notIn: [ClaimStatus.COLLECTED, ClaimStatus.CANCELLED] },
        driverPickups: {
          none: {
            status: { in: CURRENT_STATUSES },
          },
        },
      },
      include: {
        claimItems: { select: { qtyKg: true } },
        listing: {
          select: {
            id: true,
            pickupAddress: true,
            pickupByTime: true,
            pickupFromTime: true,
            totalQtyKg: true,
            remainingQtyKg: true,
            organisation: { select: { id: true, name: true, logoUrl: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      claims: claims.map((c) => ({
        claimId: c.id,
        listingId: c.listingId,
        status: c.status,
        claimMode: c.claimMode,
        qtyKg: c.claimItems.reduce((sum, i) => sum + i.qtyKg, 0),
        createdAt: c.createdAt,
        listing: {
          id: c.listing.id,
          pickupAddress: c.listing.pickupAddress,
          pickupFromTime: c.listing.pickupFromTime,
          pickupByTime: c.listing.pickupByTime,
          totalQtyKg: c.listing.totalQtyKg,
          remainingQtyKg: c.listing.remainingQtyKg,
          organisation: c.listing.organisation,
        },
      })),
    };
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
}
