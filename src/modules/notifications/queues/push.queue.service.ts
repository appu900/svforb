import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DEFAULT_JOB_OPTIONS } from 'src/infra/queues/queus.constants';
import {
  PUSH_QUEUE,
  PushJobName,
  NewListingNearbyPayload,
} from '../types/push.types';

@Injectable()
export class PushQueueService {
  constructor(@InjectQueue(PUSH_QUEUE) private readonly queue: Queue) {}

  async notifyNearbyCharities(payload: NewListingNearbyPayload): Promise<void> {
    await this.queue.add(PushJobName.NEW_LISTING_NEARBY, payload, DEFAULT_JOB_OPTIONS);
  }
}
