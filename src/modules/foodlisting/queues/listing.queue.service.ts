import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { FoodListingType } from '@prisma/client';
import { DEFAULT_JOB_OPTIONS, LISTINGS_JOBS } from '../../../infra/queues/queus.constants';

export const LISTINGS_QUEUE = 'listings';

/** Fallback when a listing has neither pickupByTime nor bestBefore. */
const LISTING_EXPIRY_FALLBACK_MS = 2 * 60 * 60 * 1000;
const NOTIFICATION_EXPIRY_DELAY_MS = 60 * 60 * 1000;
const SWEEP_EVERY_MS = 5 * 60 * 1000;

export interface NewListingJobPayload {
  listingId: number;
  siteId: number;
  listingType: FoodListingType;
  pickupAddress: string;
  businessName: string;
  totalQtyKg: number;
  bestBefore: string;
}

/** Earliest of pickupByTime / bestBefore — matches browse availability window. */
export function resolveListingExpiryAt(
  pickupByTime?: Date | string | null,
  bestBefore?: Date | string | null,
): Date {
  const candidates: number[] = [];
  if (pickupByTime) {
    const t = new Date(pickupByTime).getTime();
    if (Number.isFinite(t)) candidates.push(t);
  }
  if (bestBefore) {
    const t = new Date(bestBefore).getTime();
    if (Number.isFinite(t)) candidates.push(t);
  }
  if (!candidates.length) {
    return new Date(Date.now() + LISTING_EXPIRY_FALLBACK_MS);
  }
  return new Date(Math.min(...candidates));
}

@Injectable()
export class ListingQueueService implements OnModuleInit {
  private readonly logger = new Logger(ListingQueueService.name);

  constructor(@InjectQueue(LISTINGS_QUEUE) private readonly queue: Queue) {}

  async onModuleInit() {
    try {
      await this.queue.add(
        LISTINGS_JOBS.SWEEP_EXPIRED_LISTINGS,
        {},
        {
          ...DEFAULT_JOB_OPTIONS,
          jobId: 'sweep-expired-listings',
          repeat: { every: SWEEP_EVERY_MS },
        },
      );
      this.logger.log(`Scheduled ${LISTINGS_JOBS.SWEEP_EXPIRED_LISTINGS} every ${SWEEP_EVERY_MS}ms`);
    } catch (error) {
      this.logger.warn(
        `Could not schedule expired-listings sweep: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async enqueueNewListing(payload: NewListingJobPayload): Promise<void> {
    await this.queue.add(LISTINGS_JOBS.NEW_LISTING, payload, DEFAULT_JOB_OPTIONS);
  }

  /**
   * Schedule listing expiry at pickup/best-before (or a 2h fallback).
   * jobId is stable so re-enqueue replaces a pending delayed job for the same listing.
   */
  async enqueueListingExpiry(
    listingId: number,
    expiresAt?: Date | string | null,
  ): Promise<void> {
    const target = expiresAt
      ? new Date(expiresAt)
      : new Date(Date.now() + LISTING_EXPIRY_FALLBACK_MS);
    const delay = Math.max(0, target.getTime() - Date.now());
    const jobId = `expire-listing-${listingId}`;

    try {
      const existing = await this.queue.getJob(jobId);
      if (existing) {
        const state = await existing.getState();
        if (state === 'delayed' || state === 'waiting') {
          await existing.remove();
        }
      }
    } catch {
      // Non-fatal — add below may still succeed.
    }

    await this.queue.add(
      LISTINGS_JOBS.EXPIRE_LISTING,
      { listingId },
      { ...DEFAULT_JOB_OPTIONS, delay, jobId },
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
