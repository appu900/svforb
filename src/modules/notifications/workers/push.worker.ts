import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { FirebaseService } from '../services/firebase.service';
import {
  PUSH_QUEUE,
  PushJobName,
  NewListingNearbyPayload,
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
          {
            listingId: String(listingId),
            type: PushJobName.NEW_LISTING_NEARBY,
          },
        );
        break;
      }

      default:
        this.logger.warn(`Unhandled push job: ${job.name}`);
    }
  }
}
