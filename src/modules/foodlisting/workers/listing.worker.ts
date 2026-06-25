import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { FoodListingType, ListingStatus } from '@prisma/client';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { RedisGeoSearchService } from '../../redis-geo-search/redis.geosearch.service';
import { NotificationService } from '../../notifications/services/notification.service';
import { LISTINGS_JOBS } from '../../../infra/queues/queus.constants';
import { LISTINGS_QUEUE, NewListingJobPayload } from '../queues/listing.queue.service';
import { FoodListingCacheManager } from '../cache/food.listing.cache';

const DEFAULT_RADIUS_KM = 20;

@Processor(LISTINGS_QUEUE)
export class ListingWorker extends WorkerHost {
  private readonly logger = new Logger(ListingWorker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly geoSearch: RedisGeoSearchService,
    private readonly notificationService: NotificationService,
    private readonly cache: FoodListingCacheManager,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    this.logger.log(`Processing listing job [${job.id}] name=${job.name}`);

    switch (job.name) {
      case LISTINGS_JOBS.NEW_LISTING:
        await this.handleNewListing(job.data as NewListingJobPayload);
        break;
      case LISTINGS_JOBS.EXPIRE_LISTING:
        await this.handleListingExpiry(job.data as { listingId: number });
        break;
      default:
        this.logger.warn(`Unhandled listing job: ${job.name}`);
    }
  }

  private async handleNewListing(payload: NewListingJobPayload): Promise<void> {
    const { listingId, siteId, listingType, pickupAddress, businessName, totalQtyKg, bestBefore } =
      payload;

    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: {
        latitude: true,
        longitude: true,
        pickupRadiusKm: true,
        organisationId: true,
      },
    });

    if (!site?.latitude || !site?.longitude) {
      this.logger.warn(`Site ${siteId} has no coordinates — skipping proximity notification`);
      return;
    }

    const org = await this.prisma.organisation.findUnique({
      where: { id: site.organisationId },
      select: { region: true },
    });

    if (!org?.region) {
      this.logger.warn(`Org ${site.organisationId} has no region — skipping proximity notification`);
      return;
    }

    const { latitude: lat, longitude: lng } = site;
    const radiusKm = site.pickupRadiusKm ?? DEFAULT_RADIUS_KM;
    const { region } = org;

    const [charityResults, farmerConsumerSiteIds] = await Promise.all([
      listingType === FoodListingType.HUMAN || listingType === FoodListingType.BOTH
        ? this.geoSearch.searchNearbyCharities(lat, lng, radiusKm, region)
        : null,
      listingType === FoodListingType.ANIMAL || listingType === FoodListingType.BOTH
        ? this.geoSearch.searchNearbyFarmerConsumerSites(lat, lng, radiusKm, region)
        : null,
    ]);

    const nearbySiteIds = new Set<number>();

    if (charityResults) {
      for (const c of charityResults.charities) {
        if (c.siteId) nearbySiteIds.add(c.siteId);
      }
    }

    if (farmerConsumerSiteIds) {
      for (const sid of farmerConsumerSiteIds) nearbySiteIds.add(sid);
    }

    if (!nearbySiteIds.size) {
      this.logger.log(`No nearby claimant sites found for listing ${listingId}`);
      return;
    }

    this.logger.log(`[listing ${listingId}] Nearby site IDs: ${[...nearbySiteIds].join(', ')}`);

    // Collect user IDs (not device tokens) — the fan-out worker resolves tokens
    const nearbyUsers = await this.prisma.user.findMany({
      where: {
        isActive: true,
        siteAccesses: { some: { siteId: { in: [...nearbySiteIds] } } },
      },
      select: { id: true },
    });

    if (!nearbyUsers.length) {
      this.logger.log(`No users found for listing ${listingId} proximity`);
      return;
    }

    const userIds = nearbyUsers.map((u) => u.id);

    this.logger.log(
      `[listing ${listingId}] Queuing notification to ${userIds.length} users (radius=${radiusKm}km)`,
    );

    await this.notificationService
      .send({
        title: 'New food available nearby!',
        body: `${businessName} listed ${totalQtyKg}kg at ${pickupAddress}`,
        data: {
          listingId: String(listingId),
          type: 'new_listing_nearby',
          bestBefore: typeof bestBefore === 'string' ? bestBefore : new Date(bestBefore).toISOString(),
        },
        targetUserIds: userIds.map(String),
        priority: 'normal',
      })
      .catch((err) =>
        this.logger.warn(`notifyNewListingNearby non-critical error: ${err.message}`),
      );
  }

  private async handleListingExpiry(payload: { listingId: number }): Promise<void> {
    const { listingId } = payload;

    const listing = await this.prisma.foodListing.findUnique({
      where: { id: listingId },
      select: { status: true, organisationId: true },
    });

    if (!listing) {
      this.logger.warn(`Expiry job: listing ${listingId} not found`);
      return;
    }

    if (listing.status !== ListingStatus.ACTIVE) {
      this.logger.log(
        `Expiry job: listing ${listingId} is ${listing.status} — no action needed`,
      );
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.foodListing.update({
        where: { id: listingId },
        data: { status: ListingStatus.EXPIRED },
      });

      await tx.listingActivity.create({
        data: {
          listingId,
          actorOrgId: listing.organisationId,
          eventType: 'LISTING_EXPIRED',
          message: 'Listing expired — no claims received within 30 minutes',
        },
      });
    });

    await Promise.all([
      this.cache.delListing(listingId),
      this.cache.invalidateRecentPage1(),
      this.cache.invalidateOrgPage1(listing.organisationId),
    ]);

    this.logger.log(`Listing ${listingId} expired after 30 minutes with no claims`);
  }
}
