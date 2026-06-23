import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { FirebaseService } from '../services/firebase.service';
import {
  PUSH_QUEUE,
  PushJobName,
  NewListingNearbyPayload,
  ClaimMadePayload,
  PartialClaimUpdatePayload,
  ClaimConfirmedPayload,
  ClaimCancelledPayload,
  PickupAvailablePayload,
} from '../types/push.types';

@Processor(PUSH_QUEUE)
export class PushWorker extends WorkerHost {
  private readonly logger = new Logger(PushWorker.name);

  constructor(private readonly firebase: FirebaseService) {
    super();
  }

  async process(job: Job): Promise<void> {
    this.logger.log(`Processing push job [${job.id}] name=${job.name}`);

    switch (job.name) {
      case PushJobName.NEW_LISTING_NEARBY: {
        const { listingId, businessName, pickupAddress, totalQtyKg, deviceTokens } =
          job.data as NewListingNearbyPayload;

        await this.firebase.sendMulticast(
          deviceTokens,
          {
            title: 'New food available nearby!',
            body: `${businessName} listed ${totalQtyKg}kg at ${pickupAddress}`,
          },
          { listingId: String(listingId), type: job.name },
        );
        break;
      }

      case PushJobName.CLAIM_MADE: {
        const { claimId, listingId, claimantName, totalClaimedKg, deviceTokens } =
          job.data as ClaimMadePayload;

        await this.firebase.sendMulticast(
          deviceTokens,
          {
            title: 'Someone claimed your listing!',
            body: `${claimantName} claimed ${totalClaimedKg}kg. Confirm or reject the claim.`,
          },
          { claimId: String(claimId), listingId: String(listingId), type: job.name },
        );
        break;
      }

      case PushJobName.PARTIAL_CLAIM_UPDATE: {
        const { listingId, businessName, pickupAddress, remainingQtyKg, deviceTokens } =
          job.data as PartialClaimUpdatePayload;

        await this.firebase.sendMulticast(
          deviceTokens,
          {
            title: 'Food still available!',
            body: `${remainingQtyKg}kg still available from ${businessName} at ${pickupAddress}`,
          },
          { listingId: String(listingId), type: job.name },
        );
        break;
      }

      case PushJobName.CLAIM_CONFIRMED: {
        const { claimId, listingId, businessName, pickupAddress, pickupByTime, deviceTokens } =
          job.data as ClaimConfirmedPayload;

        await this.firebase.sendMulticast(
          deviceTokens,
          {
            title: 'Your claim is confirmed!',
            body: pickupByTime
              ? `Collect from ${businessName} at ${pickupAddress} by ${pickupByTime}`
              : `Collect from ${businessName} at ${pickupAddress}`,
          },
          { claimId: String(claimId), listingId: String(listingId), type: job.name },
        );
        break;
      }

      case PushJobName.CLAIM_CANCELLED: {
        const { claimId, listingId, cancelledByName, deviceTokens } =
          job.data as ClaimCancelledPayload;

        await this.firebase.sendMulticast(
          deviceTokens,
          {
            title: 'Claim cancelled',
            body: `${cancelledByName} cancelled a claim on this listing.`,
          },
          { claimId: String(claimId), listingId: String(listingId), type: job.name },
        );
        break;
      }

      case PushJobName.PICKUP_AVAILABLE: {
        const { claimId, listingId, businessName, pickupAddress, totalQtyKg, deviceTokens } =
          job.data as PickupAvailablePayload;

        await this.firebase.sendMulticast(
          deviceTokens,
          {
            title: 'Pickup available!',
            body: `${totalQtyKg}kg ready for collection from ${businessName} at ${pickupAddress}`,
          },
          { claimId: String(claimId), listingId: String(listingId), type: job.name },
        );
        break;
      }

      default:
        this.logger.warn(`Unhandled push job: ${job.name}`);
    }
  }
}
