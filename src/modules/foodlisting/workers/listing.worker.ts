import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { FoodListingType, ListingStatus } from '@prisma/client';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { RedisGeoSearchService } from '../../redis-geo-search/redis.geosearch.service';
import { NotificationService } from '../../notifications/services/notification.service';
import { LISTINGS_JOBS } from '../../../infra/queues/queus.constants';
import { LISTINGS_QUEUE, ListingQueueService, NewListingJobPayload, resolveListingExpiryAt } from '../queues/listing.queue.service';
import { FoodListingCacheManager } from '../cache/food.listing.cache';

const DEFAULT_RADIUS_KM = 50;
const ONE_HOUR_MS = 60 * 60 * 1000;

@Processor(LISTINGS_QUEUE)
export class ListingWorker extends WorkerHost {
  private readonly logger = new Logger(ListingWorker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly geoSearch: RedisGeoSearchService,
    private readonly notificationService: NotificationService,
    private readonly cache: FoodListingCacheManager,
    private readonly listingQueue: ListingQueueService,
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
      case LISTINGS_JOBS.SWEEP_EXPIRED_LISTINGS:
        await this.handleSweepExpiredListings();
        break;
      case LISTINGS_JOBS.EXPIRE_SITE_NOTIFICATIONS:
        await this.handleExpireSiteNotifications(job.data as { siteId: number });
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
      select: { latitude: true, longitude: true, pickupRadiusKm: true, organisationId: true },
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

    const siteAccessUsers = await this.prisma.user.findMany({
      where: {
        isActive: true,
        siteAccesses: { some: { siteId: { in: [...nearbySiteIds] } } },
      },
      select: { id: true },
    });

    if (!siteAccessUsers.length) {
      this.logger.log(`No users found for listing ${listingId} proximity`);
      return;
    }

    const userIds = siteAccessUsers.map((u) => u.id);
    const title = 'New food available nearby!';
    const body = `${businessName} listed ${totalQtyKg}kg at ${pickupAddress}`;
    const expiresAt = new Date(Date.now() + ONE_HOUR_MS);

    // Send push + save inbox notifications + schedule deletion — all in parallel
    await Promise.all([
      this.notificationService
        .send({
          title,
          body,
          data: {
            listingId: String(listingId),
            type: 'new_listing_nearby',
            bestBefore: typeof bestBefore === 'string' ? bestBefore : new Date(bestBefore).toISOString(),
          },
          targetUserIds: userIds.map(String),
          priority: 'normal',
        })
        .catch((err) => this.logger.warn(`push non-critical error: ${err.message}`)),

      // One row per nearby site — charities see their inbox by siteId
      this.prisma.siteNotification.createMany({
        data: [...nearbySiteIds].map((nearSiteId) => ({
          siteId: nearSiteId,
          listingId,
          title,
          body,
          type: 'new_listing_nearby',
          expiresAt,
        })),
        skipDuplicates: true,
      }),

      // Schedule cleanup for each site after 1 hour
      ...[...nearbySiteIds].map((nearSiteId) =>
        this.listingQueue.enqueueExpireSiteNotifications(nearSiteId),
      ),
    ]);

    this.logger.log(
      `[listing ${listingId}] SiteNotifications created for ${nearbySiteIds.size} sites, expiry jobs queued`,
    );
  }

  private async handleListingExpiry(payload: { listingId: number }): Promise<void> {
    const { listingId } = payload;
    await this.expireListingIfDue(listingId);
  }

  private async handleSweepExpiredListings(): Promise<void> {
    const now = new Date();

    // Same availability rules as nearby browse: expire once pickup or best-before has passed.
    const overdue = await this.prisma.foodListing.findMany({
      where: {
        status: { in: [ListingStatus.ACTIVE, ListingStatus.PARTIAL] },
        OR: [{ pickupByTime: { lte: now } }, { bestBefore: { lte: now } }],
      },
      select: { id: true },
      take: 200,
      orderBy: { id: 'asc' },
    });

    if (!overdue.length) {
      this.logger.debug('Sweep expired listings: none overdue');
      return;
    }

    let expiredCount = 0;
    for (const row of overdue) {
      const didExpire = await this.expireListingIfDue(row.id, { forceIfPastDeadline: true });
      if (didExpire) expiredCount += 1;
    }

    this.logger.log(
      `Sweep expired listings: checked=${overdue.length} expired=${expiredCount}`,
    );
  }

  /**
   * Expire ACTIVE / PARTIAL listings once their pickup/best-before window ends.
   * Returns true when the listing was marked EXPIRED.
   */
  private async expireListingIfDue(
    listingId: number,
    opts: { forceIfPastDeadline?: boolean } = {},
  ): Promise<boolean> {
    const listing = await this.prisma.foodListing.findUnique({
      where: { id: listingId },
      select: {
        status: true,
        organisationId: true,
        remainingQtyKg: true,
        pickupByTime: true,
        bestBefore: true,
      },
    });

    if (!listing) {
      this.logger.warn(`Expiry job: listing ${listingId} not found`);
      return false;
    }

    const isExpirable =
      listing.status === ListingStatus.ACTIVE || listing.status === ListingStatus.PARTIAL;

    if (!isExpirable) {
      this.logger.log(`Expiry job: listing ${listingId} is ${listing.status} — no action needed`);
      return false;
    }

    const deadline = resolveListingExpiryAt(listing.pickupByTime, listing.bestBefore);
    const now = new Date();

    if (!opts.forceIfPastDeadline && deadline.getTime() > now.getTime()) {
      // Job fired early (or times were updated) — reschedule to the real deadline.
      await this.listingQueue.enqueueListingExpiry(listingId, deadline);
      this.logger.log(
        `Expiry job: listing ${listingId} not due until ${deadline.toISOString()} — rescheduled`,
      );
      return false;
    }

    if (deadline.getTime() > now.getTime()) {
      return false;
    }

    const remainingNote =
      listing.status === ListingStatus.PARTIAL
        ? ` with ${listing.remainingQtyKg}kg remaining`
        : '';

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
          message: `Listing expired after pickup/best-before window${remainingNote}`,
        },
      });
    });

    await Promise.all([
      this.cache.delListing(listingId),
      this.cache.invalidateRecentPage1(),
      this.cache.invalidateOrgPage1(listing.organisationId),
      this.cache.invalidateAllNearby(),
    ]);

    this.logger.log(`Listing ${listingId} expired${remainingNote}`);
    return true;
  }

  private async handleExpireSiteNotifications(payload: { siteId: number }): Promise<void> {
    const { siteId } = payload;

    const { count } = await this.prisma.siteNotification.deleteMany({
      where: { siteId, expiresAt: { lte: new Date() } },
    });

    this.logger.log(`Deleted ${count} expired site notifications for siteId=${siteId}`);
  }
}
