import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { FoodListingType, ListingStatus } from '@prisma/client';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { RedisGeoSearchService } from '../../redis-geo-search/redis.geosearch.service';
import { PushQueueService } from '../../notifications/queues/push.queue.service';
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
    private readonly pushQueue: PushQueueService,
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

    // Fetch site coordinates + radius + linked org's region
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

    // Run geo searches in parallel based on listing type — both at site level
    const [charityResults, farmerConsumerSiteIds] = await Promise.all([
      listingType === FoodListingType.HUMAN || listingType === FoodListingType.BOTH
        ? this.geoSearch.searchNearbyCharities(lat, lng, radiusKm, region)
        : null,
      listingType === FoodListingType.ANIMAL || listingType === FoodListingType.BOTH
        ? this.geoSearch.searchNearbyFarmerConsumerSites(lat, lng, radiusKm, region)
        : null,
    ]);

    // Collect site IDs — everything goes through siteId → siteAccess → user
    const nearbySiteIds = new Set<number>();

    if (charityResults) {
      for (const c of charityResults.charities) {
        if (c.siteId) nearbySiteIds.add(c.siteId);
      }
    }

    if (farmerConsumerSiteIds) {
      for (const siteId of farmerConsumerSiteIds) nearbySiteIds.add(siteId);
    }

    if (!nearbySiteIds.size) {
      this.logger.log(`No nearby claimant sites found for listing ${listingId}`);
      return;
    }

    this.logger.log(`[listing ${listingId}] Nearby site IDs: ${[...nearbySiteIds].join(', ')}`);

    // Users with siteAccess to any of the nearby sites
    const siteAccessUsers = await this.prisma.user.findMany({
      where: {
        deviceToken: { not: null },
        isActive: true,
        siteAccesses: { some: { siteId: { in: [...nearbySiteIds] } } },
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        deviceToken: true,
        siteAccesses: { where: { siteId: { in: [...nearbySiteIds] } }, select: { siteId: true } },
      },
    });

    this.logger.log(
      `[listing ${listingId}] Users who will be notified:\n` +
        siteAccessUsers
          .map(
            (u) =>
              `  → userId=${u.id} name="${u.firstName} ${u.lastName}" email=${u.email} ` +
              `siteIds=[${u.siteAccesses.map((s) => s.siteId).join(',')}] token=${u.deviceToken}`,
          )
          .join('\n'),
    );

    const deviceTokens = [...new Set(siteAccessUsers.map((u) => u.deviceToken!))];

    if (!deviceTokens.length) {
      this.logger.log(`No device tokens found for listing ${listingId} proximity`);
      return;
    }

    await this.pushQueue.notifyNearbyCharities({
      listingId,
      businessName,
      pickupAddress,
      totalQtyKg,
      bestBefore,
      deviceTokens,
    });

    this.logger.log(
      `Queued push for listing ${listingId} → ${deviceTokens.length} devices (radius=${radiusKm}km)`,
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
