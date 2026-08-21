import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import { DEFAULT_JOB_OPTIONS } from '../../../infra/queues/queus.constants';

export const ENTERPRISE_QUEUE = 'enterprise';

export const ENTERPRISE_JOBS = {
  GENERATE_INVOICES: 'enterprise.generate_invoices',
  MARK_OVERDUE: 'enterprise.mark_overdue',
} as const;

/** Invoices are raised daily; a cycle only produces one because of the
 *  unique (contractId, periodStart) index. */
const DAILY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class EnterpriseQueueService implements OnModuleInit {
  private readonly logger = new Logger(EnterpriseQueueService.name);

  constructor(@InjectQueue(ENTERPRISE_QUEUE) private readonly queue: Queue) {}

  async onModuleInit() {
    try {
      await this.queue.add(
        ENTERPRISE_JOBS.GENERATE_INVOICES,
        {},
        { ...DEFAULT_JOB_OPTIONS, jobId: 'enterprise-invoice-sweep', repeat: { every: DAILY_MS } },
      );
      await this.queue.add(
        ENTERPRISE_JOBS.MARK_OVERDUE,
        {},
        { ...DEFAULT_JOB_OPTIONS, jobId: 'enterprise-overdue-sweep', repeat: { every: DAILY_MS } },
      );
      this.logger.log('Scheduled enterprise invoice + overdue sweeps (daily)');
    } catch (error) {
      this.logger.warn(
        `Could not schedule enterprise sweeps: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Lets an admin kick the sweep without waiting a day. */
  async triggerInvoiceSweep() {
    const job = await this.queue.add(
      ENTERPRISE_JOBS.GENERATE_INVOICES,
      {},
      { removeOnComplete: true },
    );
    return { jobId: job.id };
  }
}
