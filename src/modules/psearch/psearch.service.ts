import { Injectable, Logger, BadRequestException } from '@nestjs/common';

import { NearbyCharity, NearbyListing } from './ptypes';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { OrgType } from '@prisma/client';

@Injectable()
export class ProximityService {
  private readonly logger = new Logger(ProximityService.name);

  // Hard coded
  // Beyond 20km need to do something 
  private readonly MAX_RADIUS_KM = 20;

  
  private readonly CHARITY_CACHE_TTL = 300; // 5 minutes
  private readonly LISTING_CACHE_TTL = 60; // 60 seconds

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}


  // NEARBY CHARITIES
  // Takes restaurant lat/lng
  // Returns charities within 20km
  
  async getNearbyCharities(lat: number, lng: number, region: string) {
    this.validateCoords(lat, lng);

    const rLat = lat.toFixed(3);
    const rLng = lng.toFixed(3);
    const cacheKey = `proximity:charities:${rLat}:${rLng}:${region}`;

    const cached = await this.redis.get(cacheKey);
    if (cached) {
      this.logger.debug(`Cache HIT → ${cacheKey}`);
      return JSON.parse(cached);
    }

    this.logger.debug(`Cache MISS → ${cacheKey}`);

    // Search BOTH organisations (single) AND sites (multi)
    // UNION combines both result sets
    const charities = await this.prisma.$queryRaw<NearbyCharity[]>`

    -- PART 1: CHARITY_SINGLE
    -- Search organisation directly
    -- Single charities store location on org record
    SELECT
      o.id                  AS "orgId",
      o.name                AS "orgName",
      o."organizationType"  AS "orgType",
      o."logoUrl"           AS "logoUrl",
      o.region              AS "region",
      o."ratingAvg"         AS "ratingAvg",
      o."ratingCount"       AS "ratingCount",
      o.latitude            AS "latitude",
      o.longitude           AS "longitude",
      NULL::int             AS "siteId",
      NULL::text            AS "siteName",

      ROUND(
        CAST(
          ST_Distance(
            o.location::geography,
            ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography
          ) / 1000
        AS NUMERIC)
      , 1) AS "distanceKm"

    FROM organisations o

    WHERE
      o."organizationType" = 'CHARITY_SINGLE'
      AND o.region          = ${region}::"Region"
      AND o.location        IS NOT NULL
      AND ST_DWithin(
        o.location::geography,
        ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography,
        ${this.MAX_RADIUS_KM * 1000}
      )

    UNION ALL

    -- PART 2: CHARITY_MULTI sites
    -- Search individual sites for multi-location charities
    -- Each site is a physical branch location
    SELECT
      o.id                  AS "orgId",
      o.name                AS "orgName",
      o."organizationType"  AS "orgType",
      o."logoUrl"           AS "logoUrl",
      o.region              AS "region",
      o."ratingAvg"         AS "ratingAvg",
      o."ratingCount"       AS "ratingCount",
      s.latitude            AS "latitude",   -- site coords not org
      s.longitude           AS "longitude",  -- site coords not org
      s.id                  AS "siteId",
      s."organisationName"  AS "siteName",

      ROUND(
        CAST(
          ST_Distance(
            s.location::geography,
            ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography
          ) / 1000
        AS NUMERIC)
      , 1) AS "distanceKm"

    FROM sites s
    JOIN organisations o ON o.id = s."organisationId"

    WHERE
      o."organizationType" = 'CHARITY_MULTI'
      AND o.region          = ${region}::"Region"
      AND s.location        IS NOT NULL
      AND s."isActive"      = true
      AND ST_DWithin(
        s.location::geography,
        ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography,
        ${this.MAX_RADIUS_KM * 1000}
      )

    ORDER BY "distanceKm" ASC, "ratingAvg" DESC

    LIMIT 50
  `;

    const result = {
      searchCoordinates: { lat, lng },
      radiusKm: this.MAX_RADIUS_KM,
      total: charities.length,
      charities: charities.map((c) => ({
        orgId: c.orgId,
        orgName: c.orgName,
        orgType: c.orgType,
        logoUrl: c.logoUrl,
        region: c.region,
        // siteId present = this is a branch of a multi charity
        // siteId null    = this is a single charity
        siteId: c.siteId ?? null,
        siteName: c.siteName ?? null,
        coordinates: {
          lat: c.latitude,
          lng: c.longitude,
        },
        distanceKm: Number(c.distanceKm),
        rating: {
          avg: c.ratingAvg,
          count: c.ratingCount,
        },
      })),
    };

    await this.redis.setex(cacheKey, this.CHARITY_CACHE_TTL, JSON.stringify(result));

    return result;
  }

  // ───────────────────────────────────────────────────────
  // NEARBY LISTINGS
  // Takes charity/driver lat/lng
  // Returns active food listings within 20km
  // ───────────────────────────────────────────────────────
  async getNearbyListings(lat: number, lng: number, region: string) {
    this.validateCoords(lat, lng);

    const rLat = lat.toFixed(3);
    const rLng = lng.toFixed(3);
    const cacheKey = `proximity:listings:${rLat}:${rLng}:${region}`;

    const cached = await this.redis.get(cacheKey);
    if (cached) {
      this.logger.debug(`Cache HIT → ${cacheKey}`);
      return JSON.parse(cached);
    }

    this.logger.debug(`Cache MISS → ${cacheKey}`);

    // Distance on pickupLat/Lng — food_listings.location was dropped from schema.
    // Prefer authenticated GET /food-listings/nearby for app Available Food feeds.
    const listings = await this.prisma.$queryRaw<NearbyListing[]>`
      SELECT
        fl.id                     AS "listingId",
        fl."organisationId"       AS "orgId",
        o.name                    AS "orgName",
        fl."siteId"               AS "siteId",
        fl."listingType"          AS "listingType",
        COALESCE(
          json_agg(
            json_build_object(
              'id', fi.id,
              'name', fi.name,
              'totalQtyKg', fi."totalQtyKg",
              'remainingQtyKg', fi."remainingQtyKg",
              'unit', fi.unit,
              'category', fi.category
            )
          ) FILTER (WHERE fi.id IS NOT NULL),
          '[]'::json
        )                         AS "foodItems",
        fl."totalQtyKg"           AS "totalQtyKg",
        fl."remainingQtyKg"       AS "remainingQtyKg",
        fl."pickupAddress"        AS "pickupAddress",
        fl."pickupFromTime"       AS "pickupFromTime",
        fl."pickupByTime"         AS "pickupByTime",
        fl."needsRefrigeration"   AS "needsRefrigeration",
        fl."needsReheating"       AS "needsReheating",
        fl.allergens              AS "allergens",
        fl."photoUrls"            AS "photoUrls",
        fl.status                 AS "status",
        fl."bestBefore"           AS "bestBefore",
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
      LEFT JOIN food_items fi ON fi."listingId" = fl.id
      WHERE
        fl.status IN ('ACTIVE', 'PARTIAL')
        AND o.region = ${region}::"Region"
        AND fl."bestBefore" > NOW()
        AND (fl."pickupByTime" IS NULL OR fl."pickupByTime" > NOW())
        AND fl."pickupLat" IS NOT NULL
        AND fl."pickupLng" IS NOT NULL
        AND ST_DWithin(
          ST_SetSRID(ST_MakePoint(fl."pickupLng", fl."pickupLat"), 4326)::geography,
          ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography,
          ${this.MAX_RADIUS_KM * 1000}
        )
      GROUP BY fl.id, o.id
      ORDER BY "distanceKm" ASC, fl."pickupByTime" ASC NULLS LAST
      LIMIT 100
    `;

    const result = {
      deprecated: true,
      useInstead: 'GET /food-listings/nearby',
      message:
        'Deprecated: use authenticated GET /food-listings/nearby for Available Food discovery.',
      searchCoordinates: { lat, lng },
      radiusKm: this.MAX_RADIUS_KM,
      total: listings.length,
      listings: listings.map((l) => ({
        listingId: l.listingId,
        orgId: l.orgId,
        orgName: l.orgName,
        siteId: l.siteId,
        listingType: l.listingType,
        foodItems: l.foodItems,
        quantity: {
          total: l.totalQtyKg,
          remaining: l.remainingQtyKg,
        },
        pickup: {
          address: l.pickupAddress,
          from: l.pickupFromTime,
          by: l.pickupByTime,
        },
        flags: {
          needsRefrigeration: l.needsRefrigeration,
          needsReheating: l.needsReheating,
          allergens: l.allergens ?? [],
        },
        photoUrls: l.photoUrls,
        status: l.status,
        bestBefore: l.bestBefore,
        distanceKm: Number(l.distanceKm),
      })),
    };

    await this.redis.setex(
      cacheKey,
      this.LISTING_CACHE_TTL,
      JSON.stringify(result),
    );

    return result;
  }

  // ───────────────────────────────────────────────────────
  // VALIDATE COORDINATES
  // ───────────────────────────────────────────────────────
  private validateCoords(lat: number, lng: number): void {
    if (
      isNaN(lat) ||
      isNaN(lng) ||
      lat < -90 ||
      lat > 90 ||
      lng < -180 ||
      lng > 180 ||
      // Reject null island (0,0) — almost always wrong
      (lat === 0 && lng === 0)
    ) {
      throw new BadRequestException(
        'Invalid coordinates. ' +
          'Latitude must be between -90 and 90. ' +
          'Longitude must be between -180 and 180.',
      );
    }
  }

  async syncListingLocation(
    listingId: number,
    lat: number,
    lng: number,
  ): Promise<void> {
    if (!lat || !lng) return;

    await this.prisma.$executeRaw`
    UPDATE food_listings
    SET location = ST_SetSRID(
      ST_MakePoint(${lng}, ${lat}), 4326
    )::geography
    WHERE id = ${listingId}
  `;

    this.logger.log(`Location synced for listing=${listingId}`);
  }

  async syncSiteLocation(
  siteId: number,
  lat:    number,
  lng:    number,
): Promise<void> {
  if (!lat || !lng) return;

  await this.prisma.$executeRaw`
    UPDATE sites
    SET location = ST_SetSRID(
      ST_MakePoint(${lng}, ${lat}), 4326
    )::geography
    WHERE id = ${siteId}
  `;

  this.logger.log(`Location synced for site=${siteId}`);
}
  async syncOrganisationLocation() {
    await this.prisma.$executeRaw`
    UPDATE organisations
    SET location = ST_SetSRID(
      ST_MakePoint(longitude, latitude), 4326
    )::geography
    WHERE
      latitude  IS NOT NULL
      AND longitude IS NOT NULL
      AND location  IS NULL
  `;
    return { message: 'done' };
  }
}
