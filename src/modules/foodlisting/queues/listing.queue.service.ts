import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { FoodListingType } from '@prisma/client';
import { DEFAULT_JOB_OPTIONS, LISTINGS_JOBS } from '../../../infra/queues/queus.constants';

export const LISTINGS_QUEUE = 'listings';

const LISTING_EXPIRY_DELAY_MS = 30 * 60 * 1000;
const NOTIFICATION_EXPIRY_DELAY_MS = 60 * 60 * 1000;

export interface NewListingJobPayload {
  listingId: number;
  siteId: number;
  listingType: FoodListingType;
  pickupAddress: string;
  businessName: string;
  totalQtyKg: number;
  bestBefore: string;
}

@Injectable()
export class ListingQueueService {
  constructor(@InjectQueue(LISTINGS_QUEUE) private readonly queue: Queue) {}

  async enqueueNewListing(payload: NewListingJobPayload): Promise<void> {
    await this.queue.add(LISTINGS_JOBS.NEW_LISTING, payload, DEFAULT_JOB_OPTIONS);
  }

  async enqueueListingExpiry(listingId: number): Promise<void> {
    await this.queue.add(
      LISTINGS_JOBS.EXPIRE_LISTING,
      { listingId },
      { ...DEFAULT_JOB_OPTIONS, delay: LISTING_EXPIRY_DELAY_MS },
    );
  }

  async enqueueExpireSiteNotifications(siteId: number): Promise<void> {
    await this.queue.add(
      LISTINGS_JOBS.EXPIRE_SITE_NOTIFICATIONS,
      { siteId },
      { ...DEFAULT_JOB_OPTIONS, delay: NOTIFICATION_EXPIRY_DELAY_MS },
    );
  }
}
