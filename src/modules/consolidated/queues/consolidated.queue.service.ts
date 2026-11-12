import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import { QUEUE_NAMES } from '../../../infra/queues/queus.constants';
import { CONSOLIDATED_SWEEP_EVERY_MS, consolidatedEnabled } from '../consolidated.constants';

export const CONSOLIDATED_QUEUE = QUEUE_NAMES.CONSOLIDATED;

export const CONSOLIDATED_JOBS = {
  /** Opens, closes, reminds, expires — see ConsolidatedWorker. */
  SWEEP: 'consolidated.sweep',
} as const;

const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 50 },
};

@Injectable()
export class ConsolidatedQueueService implements OnModuleInit {
  private readonly logger = new Logger(ConsolidatedQueueService.name);

  constructor(@InjectQueue(CONSOLIDATED_QUEUE) private readonly queue: Queue) {}

  async onModuleInit() {
    if (!consolidatedEnabled()) {
      this.logger.log('CONSOLIDATED_ENABLED=false — sweep not scheduled.');
      return;
    }

    try {
      await this.removeStaleSweeps();
      await this.queue.add(
        CONSOLIDATED_JOBS.SWEEP,
        {},
        {
          ...DEFAULT_JOB_OPTIONS,
          jobId: 'consolidated-sweep',
          repeat: { every: CONSOLIDATED_SWEEP_EVERY_MS },
        },
      );
      this.logger.log(
        `Scheduled consolidated sweep every ${CONSOLIDATED_SWEEP_EVERY_MS / 60000}m`,
      );
    } catch (err) {
      // A queue that cannot be scheduled must not stop the app booting.
      this.logger.error(`Could not schedule the consolidated sweep: ${(err as Error).message}`);
    }
  }

  /**
   * A repeatable is keyed by its interval, so changing the interval adds a
   * second schedule rather than replacing the first — and both keep firing.
   */
  private async removeStaleSweeps() {
    for (const job of await this.queue.getRepeatableJobs()) {
      if (job.name !== CONSOLIDATED_JOBS.SWEEP) continue;
      if (Number(job.every) === CONSOLIDATED_SWEEP_EVERY_MS) continue;
      await this.queue.removeRepeatableByKey(job.key);
      this.logger.log(`Removed old consolidated sweep schedule (every ${job.every}ms)`);
    }
  }

  /** Manual trigger, for testing and the queue dashboard. */
  async triggerSweep() {
    await this.queue.add(CONSOLIDATED_JOBS.SWEEP, {}, DEFAULT_JOB_OPTIONS);
  }
}
