import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import { BILLING_JOBS, DEFAULT_JOB_OPTIONS } from '../../../infra/queues/queus.constants';

export const BILLING_QUEUE = 'billing';

/** Trials are 30 days; an hourly sweep is granular enough to expire them. */
const TRIAL_SWEEP_EVERY_MS = 60 * 60 * 1000;

@Injectable()
export class BillingQueueService implements OnModuleInit {
  private readonly logger = new Logger(BillingQueueService.name);

  constructor(@InjectQueue(BILLING_QUEUE) private readonly queue: Queue) {}

  async onModuleInit() {
    try {
      await this.queue.add(
        BILLING_JOBS.CHECK_TRIAL_EXPIRY,
        {},
        {
          ...DEFAULT_JOB_OPTIONS,
          jobId: 'sweep-trial-expiry',
          repeat: { every: TRIAL_SWEEP_EVERY_MS },
        },
      );
      this.logger.log(
        `Scheduled ${BILLING_JOBS.CHECK_TRIAL_EXPIRY} every ${TRIAL_SWEEP_EVERY_MS}ms`,
      );
    } catch (error) {
      this.logger.warn(
        `Could not schedule trial-expiry sweep: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
