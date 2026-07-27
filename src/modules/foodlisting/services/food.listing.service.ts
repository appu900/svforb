import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ClaimStatus,
  FoodListingType,
  ListingStatus,
  OrgType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import { S3Service } from '../../../uploads/s3/s3.service';
import { ListingQueueService, resolveListingExpiryAt } from '../queues/listing.queue.service';
import { FoodListingCacheManager } from '../cache/food.listing.cache';
import { CreateFoodListingDto } from '../dto/food.listing.dto';

const PHOTO_FOLDER = 'food-listing-photos';
const DEFAULT_LIMIT = 20;
const DEFAULT_NEARBY_RADIUS_KM = 50;
const MAX_NEARBY_RADIUS_KM = 100;

const ELIGIBLE_LISTING_TYPES: Partial<Record<OrgType, FoodListingType[]>> = {
  [OrgType.CHARITY]: [FoodListingType.HUMAN, FoodListingType.BOTH],
  [OrgType.CHARITY_SINGLE]: [FoodListingType.HUMAN, FoodListingType.BOTH],
  [OrgType.CHARITY_MULTI]: [FoodListingType.HUMAN, FoodListingType.BOTH],
  [OrgType.FARMER_CONSUMER]: [FoodListingType.ANIMAL, FoodListingType.BOTH],
};

type NearbyDistanceRow = {
  listingId: number;
  distanceKm: number;
};


@Injectable()
export class FoodListingService {
  private readonly logger = new Logger(FoodListingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: FoodListingCacheManager,
    private readonly s3: S3Service,
    private readonly listingQueue: ListingQueueService,
  ) {}

  async createListing(
    caller: Jwtpayload,
    dto: CreateFoodListingDto,
    photos?: Express.Multer.File[],
  ) {
    if (!dto.foodItems?.length) {
      throw new BadRequestException('At least one food item is required');
    }

    const site = await this.prisma.site.findFirst({
      where: { id: dto.siteId, organisationId: caller.orgId, isActive: true },
    });
    if (!site)
      throw new NotFoundException('Site not found in your organisation');

    const uploadedUrls =
      photos?.length
        ? await Promise.all(photos.map((f) => this.s3.uploadFile(f, PHOTO_FOLDER)))
        : (dto.photoUrls ?? []);

    const totalQtyKg = dto.foodItems.reduce((sum, i) => sum + i.totalQtyKg, 0);

    const listing = await this.prisma.$transaction(async (tx) => {
      const created = await tx.foodListing.create({
        data: {
          siteId: dto.siteId,
          organisationId: caller.orgId!,
          listingType: dto.listingType,
          totalQtyKg,
          remainingQtyKg: totalQtyKg,
          pickupAddress: dto.pickupAddress,
          pickupPostcode: dto.pickupPostcode,
          pickupLat: dto.pickupLat,
          pickupLng: dto.pickupLng,
          bestBefore: new Date(dto.bestBefore),
          pickupFromTime: dto.pickupFromTime
            ? new Date(dto.pickupFromTime)
            : null,
          pickupByTime: dto.pickupByTime ? new Date(dto.pickupByTime) : null,
          needsRefrigeration: dto.needsRefrigeration ?? false,
          needsAmbient: dto.needsAmbient ?? false,
          needsFreezer: dto.needsFreezer ?? false,
          needsHot: dto.needsHot ?? false,
          needsReheating: dto.needsReheating ?? false,
          isSafeForDonation: dto.isSafeForDonation ?? true,
          allergens: dto.allergens ?? [],
          photoUrls: uploadedUrls,
        },
      });

      await tx.foodItem.createMany({
        data: dto.foodItems.map((item) => ({
          listingId: created.id,
          name: item.name,
          totalQtyKg: item.totalQtyKg,
          remainingQtyKg: item.totalQtyKg,
          unit: item.unit,
          category: item.category,
        })),
      });

      return tx.foodListing.findUnique({
        where: { id: created.id },
        include: { foodItems: true },
      });
    });
    const listingActivity = await this.prisma.listingActivity.create({
      data:{
        actorOrgId:site.organisationId,
        listingId:listing!.id,
        eventType:'listing created',
        message:'Food listing created looking for charities',
      }
    })

    await Promise.all([
      this.cache.invalidateOrgPage1(caller.orgId!),
      this.cache.invalidateRecentPage1(),
      this.cache.invalidateAllNearby(),
    ]);

    await Promise.all([
      this.listingQueue.enqueueNewListing({
        listingId: listing!.id,
        siteId: dto.siteId,
        listingType: dto.listingType,
        pickupAddress: dto.pickupAddress,
        businessName: site.organisationName,
        totalQtyKg,
        bestBefore: dto.bestBefore,
      }),
      this.listingQueue.enqueueListingExpiry(
        listing!.id,
        resolveListingExpiryAt(listing!.pickupByTime, listing!.bestBefore),
      ),
    ]);

    this.logger.log(
      `Listing created: id=${listing!.id} org=${caller.orgId} totalKg=${totalQtyKg}`,
    );

    return listing;
  }

  async getAllListingOfSiteID(siteId:number,callerUserId:number){
    const callerUserDetails = await this.prisma.user.findUnique({where:{id:callerUserId}})
    if(!callerUserDetails) throw new UnauthorizedException("user has not access for the data")
    const hasSiteAccess = await this.prisma.siteAccess.findFirst({ where: { siteId: siteId, userId: callerUserDetails.id } })
    if (!hasSiteAccess) throw new UnauthorizedException("access denied")
    const allFoodListings = await this.prisma.foodListing.findMany({
      where: {
        siteId:siteId
      },
      include:{
        foodItems:true
      }
    })
    return allFoodListings;
  }
  async getOrgListings(
    orgId: number,
    page = 1,
    limit = DEFAULT_LIMIT,
    status?: ListingStatus,
  ) {
    const cacheKey = status ? null : await this.cache.getOrgPage(orgId, page);
    if (cacheKey) return cacheKey;

    const skip = (page - 1) * limit;

    const [listings, total] = await Promise.all([
      this.prisma.foodListing.findMany({
        where: { organisationId: orgId, ...(status ? { status } : {}) },
        include: {
          foodItems: true,
          _count: { select: { foodClaims: true } },
          foodClaims: {
            where: { status: { not: ClaimStatus.CANCELLED } },
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              status: true,
              claimMode: true,
              createdAt: true,
              collectedAt: true,
              claimItems: { select: { qtyKg: true } },
              claimantOrg: {
                select: { id: true, name: true, organizationType: true, logoUrl: true },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.foodListing.count({
        where: { organisationId: orgId, ...(status ? { status } : {}) },
      }),
    ]);

    const result = {
      listings,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };

    if (!status) await this.cache.setOrgPage(orgId, page, result);

    return result;
  }

  async getListingById(id: number) {
    const cached = await this.cache.getListing(id);
    if (cached) return cached;

    const listing = await this.prisma.foodListing.findUnique({
      where: { id },
      include: {
        foodItems: true,
        site: {
          select: {
            organisationName: true,
            address: true,
            contactEmail: true,
            contactMobile: true,
          },
        },
        organisation: {
          select: { id: true, name: true, logoUrl: true, ratingAvg: true },
        },
        foodClaims: {
          where: { status: { not: 'CANCELLED' } },
          select: {
            id: true,
            status: true,
            claimMode: true,
            createdAt: true,
            collectedAt: true,
            claimantOrg: {
              select: { id: true, name: true, organizationType: true, logoUrl: true },
            },
          },
        },
      },
    });

    if (!listing) throw new NotFoundException('Listing not found');

    await this.cache.setListing(id, listing);
    return listing;
  }

  async getRecentListings(siteId: number, page = 1, limit = DEFAULT_LIMIT) {
    console.log("this is siteID",siteId)
    const skip = (page - 1) * limit;

    const [listings, total] = await Promise.all([
      this.prisma.foodListing.findMany({
        where: { siteId },
        include: {
          foodItems: {
            select: { id: true, name: true, remainingQtyKg: true, unit: true },
          },
          organisation: {
            select: { id: true, name: true, logoUrl: true, ratingAvg: true },
          },
          site: { select: { id: true, address: true, postcode: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.foodListing.count({ where: { siteId } }),
    ]);

    return { listings, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  /**
   * Pull-based Available Food feed for charities / farmer-consumers.
   * Push notifications remain mandatory alerts; inbox is kept but unused for discovery.
   */
  async getNearbyListings(
    caller: Jwtpayload,
    page = 1,
    limit = DEFAULT_LIMIT,
    radiusKm?: number,
  ) {
    if (!caller.siteId || !caller.orgId || !caller.orgType) {
      throw new ForbiddenException('Site and organisation context required');
    }

    const listingTypes = ELIGIBLE_LISTING_TYPES[caller.orgType];
    if (!listingTypes?.length) {
      throw new ForbiddenException(
        'Only charity and farmer-consumer organisations can browse nearby listings',
      );
    }

    const site = await this.prisma.site.findUnique({
      where: { id: caller.siteId },
      select: {
        id: true,
        latitude: true,
        longitude: true,
        pickupRadiusKm: true,
        organisationId: true,
      },
    });

    if (!site || site.organisationId !== caller.orgId) {
      throw new ForbiddenException('You do not have access to this site');
    }
    if (site.latitude == null || site.longitude == null) {
      throw new BadRequestException(
        'Site location is not set. Update your location before browsing nearby listings.',
      );
    }

    const organisation = await this.prisma.organisation.findUnique({
      where: { id: caller.orgId },
      select: { region: true },
    });
    if (!organisation?.region) {
      throw new BadRequestException('Organisation region is required for nearby search');
    }

    // Match notification coverage: donor/site radius ?? 50 (not charity prefs default 5)
    const resolvedRadius = this.resolveNearbyRadiusKm(radiusKm, site.pickupRadiusKm);

    const cached = await this.cache.getNearbyPage<unknown>(
      caller.siteId,
      resolvedRadius,
      page,
      limit,
    );
    if (cached) return cached;

    const lat = site.latitude;
    const lng = site.longitude;
    const region = organisation.region;
    const radiusM = resolvedRadius * 1000;
    const skip = (page - 1) * limit;
    const claimantOrgId = caller.orgId;

    const typeFilter = Prisma.join(
      listingTypes.map((t) => Prisma.sql`${t}::"FoodListingType"`),
    );

    const [rows, countRows] = await Promise.all([
      this.prisma.$queryRaw<NearbyDistanceRow[]>`
        SELECT
          fl.id AS "listingId",
          ROUND(
            CAST(
              ST_Distance(
                ST_SetSRID(ST_MakePoint(fl."pickupLng", fl."pickupLat"), 4326)::geography,
                ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography
              ) / 1000
            AS NUMERIC),
            1
          ) AS "distanceKm"
        FROM food_listings fl
        JOIN organisations o ON o.id = fl."organisationId"
        WHERE
          fl.status IN ('ACTIVE', 'PARTIAL')
          AND o.region = ${region}::"Region"
          AND fl."organisationId" <> ${claimantOrgId}
          AND fl."listingType" IN (${typeFilter})
          AND fl."bestBefore" > NOW()
          AND (fl."pickupByTime" IS NULL OR fl."pickupByTime" > NOW())
          AND fl."pickupLat" IS NOT NULL
          AND fl."pickupLng" IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM food_claims fc
            WHERE fc."listingId" = fl.id
              AND fc."claimantOrgId" = ${claimantOrgId}
              AND fc.status <> 'CANCELLED'
          )
          AND ST_DWithin(
            ST_SetSRID(ST_MakePoint(fl."pickupLng", fl."pickupLat"), 4326)::geography,
            ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography,
            ${radiusM}
          )
        ORDER BY "distanceKm" ASC, fl."pickupByTime" ASC NULLS LAST
        LIMIT ${limit} OFFSET ${skip}
      `,
      this.prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS count
        FROM food_listings fl
        JOIN organisations o ON o.id = fl."organisationId"
        WHERE
          fl.status IN ('ACTIVE', 'PARTIAL')
          AND o.region = ${region}::"Region"
          AND fl."organisationId" <> ${claimantOrgId}
          AND fl."listingType" IN (${typeFilter})
          AND fl."bestBefore" > NOW()
          AND (fl."pickupByTime" IS NULL OR fl."pickupByTime" > NOW())
          AND fl."pickupLat" IS NOT NULL
          AND fl."pickupLng" IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM food_claims fc
            WHERE fc."listingId" = fl.id
              AND fc."claimantOrgId" = ${claimantOrgId}
              AND fc.status <> 'CANCELLED'
          )
          AND ST_DWithin(
            ST_SetSRID(ST_MakePoint(fl."pickupLng", fl."pickupLat"), 4326)::geography,
            ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography,
            ${radiusM}
          )
      `,
    ]);

    const total = Number(countRows[0]?.count ?? 0);
    const distanceById = new Map(rows.map((r) => [r.listingId, Number(r.distanceKm)]));
    const listingIds = rows.map((r) => r.listingId);

    const listings =
      listingIds.length === 0
        ? []
        : await this.prisma.foodListing.findMany({
            where: { id: { in: listingIds } },
            include: {
              foodItems: {
                select: {
                  id: true,
                  name: true,
                  totalQtyKg: true,
                  remainingQtyKg: true,
                  unit: true,
                  category: true,
                },
              },
              organisation: {
                select: {
                  id: true,
                  name: true,
                  logoUrl: true,
                  ratingAvg: true,
                  ratingCount: true,
                },
              },
              site: {
                select: { id: true, address: true, postcode: true, organisationName: true },
              },
            },
          });

    const byId = new Map(listings.map((l) => [l.id, l]));
    const ordered = listingIds
      .map((id) => byId.get(id))
      .filter((l): l is NonNullable<typeof l> => !!l)
      .map((listing) => ({
        ...listing,
        distanceKm: distanceById.get(listing.id) ?? null,
      }));

    const result = {
      listings: ordered,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 0,
      radiusKm: resolvedRadius,
      searchCoordinates: { lat, lng },
      region,
    };

    await this.cache.setNearbyPage(caller.siteId, resolvedRadius, page, limit, result);
    this.logger.log(
      `Nearby listings site=${caller.siteId} radius=${resolvedRadius}km page=${page} total=${total}`,
    );
    return result;
  }

  /**
   * Align with listing.worker notify radius: requested ?? site.pickupRadiusKm ?? 50.
   * Do not prefer CharityPickupPrefs (often defaults to 5) — that hides push-notified listings.
   */
  private resolveNearbyRadiusKm(
    requested?: number,
    siteRadius?: number | null,
  ): number {
    const raw = requested ?? siteRadius ?? DEFAULT_NEARBY_RADIUS_KM;

    if (!Number.isFinite(raw) || raw <= 0) {
      throw new BadRequestException('radiusKm must be a positive number');
    }

    return Math.min(Math.round(raw), MAX_NEARBY_RADIUS_KM);
  }

  async cancelListing(caller: Jwtpayload, id: number) {
    const listing = await this.prisma.foodListing.findFirst({
      where: { id, organisationId: caller.orgId },
    });
    if (!listing) throw new NotFoundException('Listing not found');
    if (listing.status === ListingStatus.CLAIMED) {
      throw new ForbiddenException('Cannot cancel a fully claimed listing');
    }

    await this.prisma.foodListing.update({
      where: { id },
      data: { status: ListingStatus.CANCELLED },
    });

    await Promise.all([
      this.cache.delListing(id),
      this.cache.invalidateOrgPage1(caller.orgId!),
      this.cache.invalidateRecentPage1(),
      this.cache.invalidateAllNearby(),
    ]);

    return { message: 'Listing cancelled' };
  }
}
