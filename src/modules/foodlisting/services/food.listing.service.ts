import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ClaimStatus,
  ConnectionDayOutcome,
  ConsolidatedListingRole,
  RecoveryPathway,
  EnterpriseRole,
  FoodListingType,
  ListingStatus,
  OrgRole,
  OrgType,
  PlatformRole,
  Prisma,
  DriverPickupStatus,
} from '@prisma/client';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import { S3Service } from '../../../uploads/s3/s3.service';
import { EnterpriseScopeService } from '../../enterprise/services/enterprise-scope.service';
import { canMarkConnectionDayCollected } from '../../connections/connection.rules';
import { ListingQueueService, resolveListingExpiryAt } from '../queues/listing.queue.service';
import { FoodListingCacheManager } from '../cache/food.listing.cache';
import { CreateFoodListingDto } from '../dto/food.listing.dto';
import { resolveCallerSiteId } from '../utils/resolve-caller-site';
import {
  BUSINESS_LIST_LISTING,
  SQL_DISCOVERABLE,
} from '../../consolidated/consolidated.filters';
import { canAccessListing, ExclusivityView } from '../../connections/connection.rules';
import { assertNotViewOnly, isUnrestricted } from '../../enterprise/enterprise.permissions';
import { viewOnlySiteIds } from '../../enterprise/enterprise-reach';

/** Everything `createListingRecord` needs, already validated and resolved. */
export interface CreateListingRecordInput
  extends Omit<CreateFoodListingDto, 'bestBefore' | 'pickupByTime' | 'photoUrls' | 'foodItems'> {
  bestBefore: Date;
  pickupByTime: Date | null;
  photoUrls: string[];
  totalQtyKg: number;
  /** Enterprise classification captured at creation. */
  snapshot: Record<string, number | null>;
  recoveryPathway?: RecoveryPathway | null;
  foodItems: {
    name: string;
    totalQtyKg: number;
    unit?: string;
    category?: string;
    quantityDescription?: string | null;
  }[];
}

export interface CreateListingRecordOptions {
  consolidatedRole?: ConsolidatedListingRole;
}

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


/**
 * A reserved Preferred Charity collection reads as not found to everyone but
 * the charity it was offered to — an outsider should not be able to confirm
 * that a listing exists by its id alone.
 */
function assertCanAccessListing(
  listing: ExclusivityView,
  viewerOrgId?: number | null,
): void {
  if (!canAccessListing(listing, viewerOrgId)) {
    throw new NotFoundException('Listing not found');
  }
}

@Injectable()
export class FoodListingService {
  private readonly logger = new Logger(FoodListingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: FoodListingCacheManager,
    private readonly s3: S3Service,
    private readonly listingQueue: ListingQueueService,
    private readonly enterpriseScope: EnterpriseScopeService,
  ) {}

  async presignListingPhoto(contentType: string) {
    const mime = String(contentType || '').trim().toLowerCase();
    const allowed: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'image/heic': 'heic',
      'image/heif': 'heif',
      'image/gif': 'gif',
    };
    const ext = allowed[mime];
    if (!ext) {
      throw new BadRequestException('Only image uploads are allowed');
    }
    const type = mime === 'image/jpg' ? 'image/jpeg' : mime;
    return this.s3.createPresignedPut(PHOTO_FOLDER, type, ext);
  }

  /**
   * Writes the listing row and its food items, and nothing else.
   *
   * Split out so Consolidated Collections can create a listing that must stay
   * invisible: a site's contribution is not an offer in its own right, so it
   * gets no discovery fan-out, no expiry job and no cache invalidation. Those
   * side effects stay in `createListing`, which is the only path that should
   * ever trigger them.
   */
  async createListingRecord(
    tx: Prisma.TransactionClient,
    caller: Jwtpayload,
    input: CreateListingRecordInput,
    opts: CreateListingRecordOptions = {},
  ) {
    const created = await tx.foodListing.create({
      data: {
        siteId: input.siteId,
        organisationId: caller.orgId!,
        ...input.snapshot,
        listingType: input.listingType,
        recoveryPathway: input.recoveryPathway ?? undefined,
        consolidatedRole: opts.consolidatedRole ?? ConsolidatedListingRole.STANDARD,
        totalQtyKg: input.totalQtyKg,
        remainingQtyKg: input.totalQtyKg,
        pickupAddress: input.pickupAddress,
        pickupPostcode: input.pickupPostcode,
        pickupLat: input.pickupLat,
        pickupLng: input.pickupLng,
        bestBefore: input.bestBefore,
        pickupFromTime: input.pickupFromTime ? new Date(input.pickupFromTime) : null,
        pickupByTime: input.pickupByTime,
        needsRefrigeration: input.needsRefrigeration ?? false,
        needsAmbient: input.needsAmbient ?? false,
        needsFreezer: input.needsFreezer ?? false,
        needsHot: input.needsHot ?? false,
        needsReheating: input.needsReheating ?? false,
        isSafeForDonation: input.isSafeForDonation ?? true,
        allergens: input.allergens ?? [],
        collectionNotes: input.collectionNotes?.trim() || null,
        photoUrls: input.photoUrls,
      },
    });

    await tx.foodItem.createMany({
      data: input.foodItems.map((item) => ({
        listingId: created.id,
        name: item.name,
        totalQtyKg: item.totalQtyKg,
        remainingQtyKg: item.totalQtyKg,
        unit: item.unit,
        category: item.category,
        quantityDescription: item.quantityDescription ?? null,
      })),
    });

    return tx.foodListing.findUnique({
      where: { id: created.id },
      include: { foodItems: true },
    });
  }

  async createListing(
    caller: Jwtpayload,
    dto: CreateFoodListingDto,
    photos?: Express.Multer.File[],
  ) {
    assertNotViewOnly(caller);
    if (!dto.foodItems?.length) {
      throw new BadRequestException('At least one food item is required');
    }

    const site = await this.prisma.site.findFirst({
      where: { id: dto.siteId, organisationId: caller.orgId, isActive: true },
    });
    if (!site)
      throw new NotFoundException('Site not found in your organisation');

    const uploadedFromFiles = photos?.length
      ? await Promise.all(photos.map((f) => this.s3.uploadFile(f, PHOTO_FOLDER)))
      : [];
    const uploadedUrls = [
      ...uploadedFromFiles,
      ...(Array.isArray(dto.photoUrls) ? dto.photoUrls : []),
    ].filter((url): url is string => typeof url === 'string' && url.trim().length > 0);

    const totalQtyKg = dto.foodItems.reduce((sum, i) => sum + i.totalQtyKg, 0);

    // Expiry is the earlier of best-before and pickup end, so a best-before inside
    // the window would expire the listing before it can be collected.
    const pickupByTime = dto.pickupByTime ? new Date(dto.pickupByTime) : null;
    let bestBefore = new Date(dto.bestBefore);
    if (pickupByTime && bestBefore.getTime() < pickupByTime.getTime()) {
      bestBefore = pickupByTime;
    }

    // Classification is captured now so reassigning the site later cannot
    // rewrite what this listing reported at the time.
    const snapshot = await this.enterpriseScope.snapshotForSite(dto.siteId);

    const listing = await this.prisma.$transaction((tx) =>
      this.createListingRecord(tx, caller, {
        ...dto,
        bestBefore,
        pickupByTime,
        photoUrls: uploadedUrls,
        totalQtyKg,
        snapshot,
      }),
    );
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
        bestBefore: bestBefore.toISOString(),
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
        siteId:siteId,
        ...BUSINESS_LIST_LISTING,
      },
      include:{
        foodItems:true,
        foodClaims: {
          where: { status: { not: ClaimStatus.CANCELLED } },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            status: true,
            claimMode: true,
            createdAt: true,
            collectedAt: true,
            confirmedAt: true,
            claimItems: {
              select: {
                qtyKg: true,
                foodItem: { select: { id: true, name: true, unit: true, category: true } },
              },
            },
          },
        },
      }
    })
    return this.withContributionMeta(allFoodListings);
  }
  /**
   * Members only. Head office sees every site; site staff in a multi-site
   * organisation see only their own sites. Returns null for the whole organisation.
   */
  private async orgListingSiteScope(caller: Jwtpayload, orgId: number): Promise<number[] | null> {
    if (caller.platformRole === PlatformRole.PLATFORM_ADMIN) return null;

    const [membership, accesses, siteCount] = await Promise.all([
      this.prisma.orgMemeberShip.findFirst({
        where: { userId: caller.sub, organisationId: orgId },
        select: { orgRole: true, enterpriseRole: true },
      }),
      this.prisma.siteAccess.findMany({
        where: { userId: caller.sub, site: { organisationId: orgId } },
        select: { siteId: true },
      }),
      this.prisma.site.count({ where: { organisationId: orgId } }),
    ]);

    const sameOrg = caller.orgId === orgId;
    if (!membership && !sameOrg && accesses.length === 0) {
      throw new ForbiddenException('You do not have access to this organisation');
    }

    const orgRole = membership?.orgRole ?? (sameOrg ? caller.orgRole : undefined);
    const enterpriseRole = membership ? membership.enterpriseRole : sameOrg ? caller.enterpriseRole : null;
    if (orgRole === OrgRole.SUPER_ADMIN || orgRole === OrgRole.ORG_ADMIN) return null;
    if (enterpriseRole === EnterpriseRole.ENTERPRISE_ADMIN) {
      const limited = await viewOnlySiteIds(this.prisma, caller.sub, orgId);
      // Site id 0 never exists, so an empty reach matches nothing instead of everything.
      return limited ? (limited.length ? limited : [0]) : null;
    }
    if (isUnrestricted(enterpriseRole)) return null;

    const siteIds = [...new Set(accesses.map((access) => access.siteId))];
    if (siteIds.length === 0 || siteIds.length >= siteCount) return null;
    return siteIds;
  }

  async getOrgListings(
    caller: Jwtpayload,
    orgId: number,
    page = 1,
    limit = DEFAULT_LIMIT,
    status?: ListingStatus,
    fresh = false,
  ) {
    const siteIds = await this.orgListingSiteScope(caller, orgId);
    // The org page cache holds whole-organisation results only.
    const useCache = !siteIds && !status && !fresh;

    const cacheKey = useCache
      ? await this.cache.getOrgPage<{ listings: { id: number; consolidatedRole: ConsolidatedListingRole }[] }>(orgId, page)
      : null;
    if (cacheKey) {
      return { ...cacheKey, listings: await this.withContributionMeta(cacheKey.listings) };
    }

    const skip = (page - 1) * limit;
    const where: Prisma.FoodListingWhereInput = {
      organisationId: orgId,
      ...(siteIds ? { siteId: { in: siteIds } } : {}),
      ...(status ? { status } : {}),
      // A collection is one event, not N listings — the master would otherwise
      // be counted alongside the contributions that make it up.
      ...BUSINESS_LIST_LISTING,
    };

    const [listings, total] = await Promise.all([
      this.prisma.foodListing.findMany({
        where,
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
              confirmedAt: true,
              rating: true,
              providerConfirmedAt: true,
              providerRating: true,
              providerDidCollect: true,
              claimItems: {
                select: {
                  qtyKg: true,
                  foodItem: { select: { id: true, name: true, unit: true, category: true } },
                },
              },
              claimantOrg: {
                select: {
                  id: true,
                  name: true,
                  organizationType: true,
                  logoUrl: true,
                  address: true,
                },
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
                where: { status: { not: 'CANCELLED' } },
                orderBy: { createdAt: 'desc' },
                take: 1,
                select: {
                  id: true,
                  status: true,
                  collectedAt: true,
                  charityDriverRating: true,
                  charityDriverRatingNote: true,
                  restaurantDriverRating: true,
                  restaurantDriverRatingNote: true,
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
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.foodListing.count({ where }),
    ]);

    // Heal: driver already COLLECTED but claim row never flipped (legacy completePickup bug).
    let healed = false;
    for (const listing of listings) {
      for (const claim of listing.foodClaims) {
        if (claim.status === ClaimStatus.COLLECTED || claim.status === ClaimStatus.CANCELLED) {
          continue;
        }
        const collectedPickup = claim.driverPickups?.find(
          (p) => p.status === DriverPickupStatus.COLLECTED,
        );
        if (!collectedPickup) continue;

        const collectedAt = collectedPickup.collectedAt ?? new Date();
        const collectedKg = claim.claimItems.reduce((sum, item) => sum + item.qtyKg, 0);
        await this.prisma.foodClaim.update({
          where: { id: claim.id },
          data: {
            status: ClaimStatus.COLLECTED,
            collectedAt,
          },
        });
        if (canMarkConnectionDayCollected(listing.status)) {
          await this.prisma.connectionDay.updateMany({
            where: {
              listingId: listing.id,
              outcome: ConnectionDayOutcome.PUBLISHED,
            },
            data: {
              outcome: ConnectionDayOutcome.COLLECTED,
              collectedKg,
              respondedAt: collectedAt,
            },
          });
        }
        (claim as { status: ClaimStatus }).status = ClaimStatus.COLLECTED;
        (claim as { collectedAt: Date | null }).collectedAt =
          collectedPickup.collectedAt ?? new Date();
        healed = true;
      }
    }

    if (healed) {
      await this.cache.invalidateOrgPage1(orgId).catch(() => undefined);
    }

    const result = {
      listings,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };

    if (useCache) await this.cache.setOrgPage(orgId, page, result);

    return { ...result, listings: await this.withContributionMeta(result.listings) };
  }

  /**
   * A site's contribution to a shared collection is an ordinary listing, but
   * the site's Listings screen needs to know which collection it belongs to and
   * where its handover stands. Computed live — never cached — because the
   * handover and receipt change minute to minute on collection day.
   */
  async withContributionMeta<T extends { id: number; consolidatedRole: ConsolidatedListingRole }>(
    listings: T[],
  ): Promise<(T & { consolidated?: Record<string, unknown> })[]> {
    const ids = listings
      .filter((l) => l.consolidatedRole === ConsolidatedListingRole.CONTRIBUTION)
      .map((l) => l.id);
    if (!ids.length) return listings;

    const rows = await this.prisma.consolidatedContribution.findMany({
      where: { listingId: { in: ids } },
      select: {
        id: true,
        listingId: true,
        status: true,
        receiptStatus: true,
        handoverAt: true,
        collection: {
          select: {
            id: true,
            status: true,
            method: true,
            timezone: true,
            pointName: true,
            pointAddress: true,
            handoverStartAt: true,
            handoverEndAt: true,
            pickupStartAt: true,
            pickupEndAt: true,
            publishedAt: true,
          },
        },
      },
    });
    const byListing = new Map(rows.map((r) => [r.listingId, r]));

    return listings.map((listing) => {
      const row = byListing.get(listing.id);
      if (!row) return listing;
      const c = row.collection;
      return {
        ...listing,
        consolidated: {
          contributionId: row.id,
          collectionId: c.id,
          status: row.status,
          receiptStatus: row.receiptStatus,
          handoverAt: row.handoverAt,
          collectionStatus: c.status,
          method: c.method,
          timezone: c.timezone,
          pointName: c.pointName,
          pointAddress: c.pointAddress,
          handoverStartAt: c.handoverStartAt,
          handoverEndAt: c.handoverEndAt,
          pickupStartAt: c.pickupStartAt,
          pickupEndAt: c.pickupEndAt,
          published: Boolean(c.publishedAt),
        },
      };
    });
  }

  /**
   * `viewerOrgId` gates Preferred Charity collections: a reserved listing is
   * readable only by the charity it was offered to, until it is released.
   * Passing nothing means an anonymous viewer, who sees public listings only.
   */
  async getListingById(id: number, viewerOrgId?: number | null) {
    const cached = await this.cache.getListing(id);
    if (cached) {
      assertCanAccessListing(cached as ExclusivityView, viewerOrgId);
      return cached;
    }

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
    assertCanAccessListing(listing, viewerOrgId);

    // A neutral flag: the app shows an item check without being told why, so
    // the charity never learns the food came from several outlets.
    const payload = {
      ...listing,
      requiresItemCheck: listing.consolidatedRole === ConsolidatedListingRole.MASTER,
    };

    await this.cache.setListing(id, payload);
    return payload;
  }

  async getRecentListings(siteId: number, page = 1, limit = DEFAULT_LIMIT) {
    console.log("this is siteID",siteId)
    const skip = (page - 1) * limit;

    const [listings, total] = await Promise.all([
      this.prisma.foodListing.findMany({
        where: { siteId, ...BUSINESS_LIST_LISTING },
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
    if (!caller.orgId || !caller.orgType) {
      throw new ForbiddenException('Site and organisation context required');
    }

    const siteId = await resolveCallerSiteId(this.prisma, caller);
    if (!siteId) {
      throw new ForbiddenException('Site and organisation context required');
    }

    const listingTypes = ELIGIBLE_LISTING_TYPES[caller.orgType];
    if (!listingTypes?.length) {
      throw new ForbiddenException(
        'Only charity and farmer-consumer organisations can browse nearby listings',
      );
    }

    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
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
      site.id,
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
    const claimantSiteId = site.id;

    const typeFilter = Prisma.join(
      listingTypes.map((t) => Prisma.sql`${t}::"FoodListingType"`),
    );

    // Exclude only listings THIS site already claimed. Sibling sites in a
    // multi-charity org must still see PARTIAL leftovers with remaining qty.
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
          -- Preferred Charity: hide collections reserved for someone else.
          AND (
            fl."exclusiveToOrgId" IS NULL
            OR fl."releasedAt" IS NOT NULL
            OR fl."exclusiveToOrgId" = ${claimantOrgId}
          )
          -- Released after this charity said "Can't collect": offered to everyone else.
          AND NOT COALESCE(
            fl."exclusiveToOrgId" = ${claimantOrgId}
              AND fl."releasedAt" IS NOT NULL
              AND fl."releasedReason" = 'CHARITY_DECLINED',
            false
          )
          AND fl."listingType" IN (${typeFilter})
          AND ${SQL_DISCOVERABLE}
          AND fl."bestBefore" > NOW()
          AND (fl."pickupByTime" IS NULL OR fl."pickupByTime" > NOW())
          AND fl."pickupLat" IS NOT NULL
          AND fl."pickupLng" IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM food_claims fc
            WHERE fc."listingId" = fl.id
              AND fc."claimantOrgId" = ${claimantOrgId}
              AND fc."claimantSiteId" = ${claimantSiteId}
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
          -- Preferred Charity: hide collections reserved for someone else.
          AND (
            fl."exclusiveToOrgId" IS NULL
            OR fl."releasedAt" IS NOT NULL
            OR fl."exclusiveToOrgId" = ${claimantOrgId}
          )
          AND NOT COALESCE(
            fl."exclusiveToOrgId" = ${claimantOrgId}
              AND fl."releasedAt" IS NOT NULL
              AND fl."releasedReason" = 'CHARITY_DECLINED',
            false
          )
          AND fl."listingType" IN (${typeFilter})
          AND ${SQL_DISCOVERABLE}
          AND fl."bestBefore" > NOW()
          AND (fl."pickupByTime" IS NULL OR fl."pickupByTime" > NOW())
          AND fl."pickupLat" IS NOT NULL
          AND fl."pickupLng" IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM food_claims fc
            WHERE fc."listingId" = fl.id
              AND fc."claimantOrgId" = ${claimantOrgId}
              AND fc."claimantSiteId" = ${claimantSiteId}
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
        // Neutral: the charity is told to check items, never why (SPEC §2.4).
        requiresItemCheck: listing.consolidatedRole === ConsolidatedListingRole.MASTER,
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

    await this.cache.setNearbyPage(site.id, resolvedRadius, page, limit, result);
    this.logger.log(
      `Nearby listings site=${site.id} radius=${resolvedRadius}km page=${page} total=${total}`,
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
    assertNotViewOnly(caller);
    const listing = await this.prisma.foodListing.findFirst({
      where: { id, organisationId: caller.orgId },
    });
    if (!listing) throw new NotFoundException('Listing not found');
    if (listing.consolidatedRole !== ConsolidatedListingRole.STANDARD) {
      throw new ConflictException(
        'Manage this from the collection it belongs to.',
      );
    }
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
