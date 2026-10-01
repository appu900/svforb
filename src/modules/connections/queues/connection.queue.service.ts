import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';

export const CONNECTION_QUEUE = 'connections';

export const CONNECTION_JOBS = {
  /** Ask each business what is available, ahead of its window. */
  PROMPT_DUE: 'connection.prompt_due',
  /** Chase unconfirmed collections, then release them at the window. */
  SWEEP_UNCONFIRMED: 'connection.sweep_unconfirmed',
  /** Expire invitations nobody answered. */
  EXPIRE_INVITATIONS: 'connection.expire_invitations',
} as const;

/**
 * The 4h prompt and 2.5h list-by push land at most this late. A window can
 * start on any minute (10:31), so anything coarser visibly misses it. A sweep
 * that misses a tick still catches up on the next one.
 */
const SWEEP_EVERY_MS = 60 * 1000;
const DAILY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 50 },
};

@Injectable()
export class ConnectionQueueService implements OnModuleInit {
  private readonly logger = new Logger(ConnectionQueueService.name);

  constructor(@InjectQueue(CONNECTION_QUEUE) private readonly queue: Queue) {}

  async onModuleInit() {
    try {
      await this.removeStaleSweeps();
      await this.queue.add(
        CONNECTION_JOBS.PROMPT_DUE,
        {},
        { ...DEFAULT_JOB_OPTIONS, jobId: 'connection-prompt-sweep', repeat: { every: SWEEP_EVERY_MS } },
      );
      await this.queue.add(
        CONNECTION_JOBS.SWEEP_UNCONFIRMED,
        {},
        { ...DEFAULT_JOB_OPTIONS, jobId: 'connection-cutoff-sweep', repeat: { every: SWEEP_EVERY_MS } },
      );
      await this.queue.add(
        CONNECTION_JOBS.EXPIRE_INVITATIONS,
        {},
        { ...DEFAULT_JOB_OPTIONS, jobId: 'connection-invitation-sweep', repeat: { every: DAILY_MS } },
      );
      this.logger.log(
        `Scheduled connection sweeps every ${SWEEP_EVERY_MS / 60000}m`,
      );
    } catch (err) {
      // A queue that cannot be scheduled must not stop the app booting.
      this.logger.error(`Could not schedule connection sweeps: ${(err as Error).message}`);
    }
  }

  /**
   * A repeatable is keyed by its interval, so changing SWEEP_EVERY_MS adds a
   * new schedule rather than replacing the old one — both would keep firing.
   */
  private async removeStaleSweeps() {
    const swept: string[] = [CONNECTION_JOBS.PROMPT_DUE, CONNECTION_JOBS.SWEEP_UNCONFIRMED];
    for (const job of await this.queue.getRepeatableJobs()) {
      if (!swept.includes(job.name) || Number(job.every) === SWEEP_EVERY_MS) continue;
      await this.queue.removeRepeatableByKey(job.key);
      this.logger.log(`Removed old ${job.name} schedule (every ${job.every}ms)`);
    }
  }

  /** Manual trigger, for testing and for the queue dashboard. */
  async triggerPromptSweep() {
    await this.queue.add(CONNECTION_JOBS.PROMPT_DUE, {}, DEFAULT_JOB_OPTIONS);
  }
}
