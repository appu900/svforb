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

const CURRENT_STATUSES = [
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

    if (status === DriverPickupStatus.COLLECTED) {
      throw new BadRequestException('Use the complete endpoint to mark as collected');
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
    });

    if (!pickup) throw new NotFoundException('Pickup not found');
    if (pickup.status !== DriverPickupStatus.ARRIVED) {
      throw new BadRequestException('Mark as ARRIVED before completing the pickup');
    }

    let photoUrl: string | undefined;
    if (photo) {
      photoUrl = await this.s3.uploadFile(photo, PHOTO_FOLDER);
    }

    return this.prisma.driverPickup.update({
      where: { id: pickupId },
      data: {
        status: DriverPickupStatus.COLLECTED,
        collectedAt: new Date(),
        ...(notes !== undefined && { completionNotes: notes }),
        ...(rating !== undefined && { restaurantRating: rating }),
        ...(photoUrl && { photoUrl }),
      },
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
    if (claim.status !== ClaimStatus.CONFIRMED) {
      throw new BadRequestException(
        'Driver can only be assigned to a confirmed claim',
      );
    }

    const driverAccess = await this.prisma.siteAccess.findFirst({
      where: { userId: driverId, siteRole: SiteRole.DRIVER, organisationId: assignerOrgId },
    });
    if (!driverAccess) {
      throw new ForbiddenException('The specified user is not a driver in your organisation');
    }

    const activePickup = await this.prisma.driverPickup.findFirst({
      where: { claimId, status: { in: CURRENT_STATUSES } },
    });
    if (activePickup) {
      throw new ConflictException('This claim already has an active driver assigned');
    }

    const driver = await this.prisma.user.findUnique({
      where: { id: driverId },
      select: { firstName: true, lastName: true },
    });
    if (!driver) throw new NotFoundException('Driver not found');

    const pickup = await this.prisma.driverPickup.create({
      data: { driverId, claimId, listingId, status: DriverPickupStatus.ACCEPTED },
    });

    const listing = claim.listing;

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
        priority: 'high',
      })
      .catch((err) =>
        this.logger.warn(`notifyDriverAssigned non-critical error: ${err.message}`),
      );

    this.logger.log(
      `Driver ${driverId} assigned to claim=${claimId} listing=${listingId} by org=${assignerOrgId}`,
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

    if (
      pickup.status === DriverPickupStatus.COLLECTED ||
      pickup.status === DriverPickupStatus.CANCELLED
    ) {
      throw new BadRequestException('Cannot respond to a completed or cancelled pickup');
    }

    const driver = await this.prisma.user.findUnique({
      where: { id: driverId },
      select: { firstName: true, lastName: true },
    });
    const driverName = driver ? `${driver.firstName} ${driver.lastName}` : 'Driver';

    if (accept) {
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
      return { message: 'Pickup accepted', pickup };
    } else {
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
