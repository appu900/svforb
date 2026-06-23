import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DEFAULT_JOB_OPTIONS } from 'src/infra/queues/queus.constants';
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

@Injectable()
export class PushQueueService {
  constructor(@InjectQueue(PUSH_QUEUE) private readonly queue: Queue) {}

  async notifyNearbyCharities(payload: NewListingNearbyPayload): Promise<void> {
    await this.queue.add(PushJobName.NEW_LISTING_NEARBY, payload, DEFAULT_JOB_OPTIONS);
  }

  async notifyClaimMade(payload: ClaimMadePayload): Promise<void> {
    await this.queue.add(PushJobName.CLAIM_MADE, payload, DEFAULT_JOB_OPTIONS);
  }

  async notifyPartialClaimUpdate(payload: PartialClaimUpdatePayload): Promise<void> {
    await this.queue.add(PushJobName.PARTIAL_CLAIM_UPDATE, payload, DEFAULT_JOB_OPTIONS);
  }

  async notifyClaimConfirmed(payload: ClaimConfirmedPayload): Promise<void> {
    await this.queue.add(PushJobName.CLAIM_CONFIRMED, payload, DEFAULT_JOB_OPTIONS);
  }

  async notifyClaimCancelled(payload: ClaimCancelledPayload): Promise<void> {
    await this.queue.add(PushJobName.CLAIM_CANCELLED, payload, DEFAULT_JOB_OPTIONS);
  }

  async notifyPickupAvailable(payload: PickupAvailablePayload): Promise<void> {
    await this.queue.add(PushJobName.PICKUP_AVAILABLE, payload, DEFAULT_JOB_OPTIONS);
  }
}
