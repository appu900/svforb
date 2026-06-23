import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DriverPickupStatus, SiteRole } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { RedisService } from 'src/infra/redis/redis.service';
import { S3Service } from 'src/uploads/s3/s3.service';

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
}
