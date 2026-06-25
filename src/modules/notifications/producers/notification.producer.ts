import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  FanOutJobData,
  NotificationJobData,
  SendBatchJobData,
  TokenWithType,
} from '../interfaces';
import {
  NOTIFICATION_QUEUE_NAME,
  FAN_OUT_BATCH_SIZE,
  JOB_ATTEMPTS,
  JOB_BACKOFF_TYPE,
  JOB_BACKOFF_DELAY,
  JOB_REMOVE_ON_COMPLETE,
  JOB_REMOVE_ON_FAIL,
  BULLMQ_PRIORITY,
} from '../constants';

@Injectable()
export class NotificationProducer {
  private readonly logger = new Logger(NotificationProducer.name);

  constructor(
    @InjectQueue(NOTIFICATION_QUEUE_NAME)
    private readonly queue: Queue<NotificationJobData>,
  ) {}

  async enqueueNotification(
    notificationId: number,
    priority: 'high' | 'normal' | 'low' = 'normal',
    delayMs?: number,
  ): Promise<void> {
    const jobData: FanOutJobData = { type: 'fan-out', notificationId };

    const job = await this.queue.add('fan-out', jobData, {
      priority: BULLMQ_PRIORITY[priority],
      attempts: JOB_ATTEMPTS,
      backoff: { type: JOB_BACKOFF_TYPE, delay: JOB_BACKOFF_DELAY },
      removeOnComplete: JOB_REMOVE_ON_COMPLETE,
      removeOnFail: JOB_REMOVE_ON_FAIL,
      ...(delayMs ? { delay: delayMs } : {}),
    });

    this.logger.log(
      `Notification fan-out job enqueued: jobId=${job.id} notificationId=${notificationId} priority=${priority}`,
    );
  }

  async enqueueBatches(
    notificationId: number,
    tokens: TokenWithType[],
    priority: 'high' | 'normal' | 'low' = 'normal',
  ): Promise<number> {
    const chunks: TokenWithType[][] = [];
    for (let i = 0; i < tokens.length; i += FAN_OUT_BATCH_SIZE) {
      chunks.push(tokens.slice(i, i + FAN_OUT_BATCH_SIZE));
    }

    const totalBatches = chunks.length;

    const jobs = chunks.map((tokenChunk, index) => ({
      name: 'send-batch',
      data: {
        type: 'send-batch' as const,
        notificationId,
        tokens: tokenChunk,
        batchIndex: index,
        totalBatches,
      } satisfies SendBatchJobData,
      opts: {
        priority: BULLMQ_PRIORITY[priority],
        attempts: JOB_ATTEMPTS,
        backoff: { type: JOB_BACKOFF_TYPE, delay: JOB_BACKOFF_DELAY },
        removeOnComplete: JOB_REMOVE_ON_COMPLETE,
        removeOnFail: JOB_REMOVE_ON_FAIL,
      },
    }));

    await this.queue.addBulk(jobs);

    this.logger.log(
      `Send-batch jobs enqueued: notificationId=${notificationId} totalBatches=${totalBatches} totalTokens=${tokens.length}`,
    );

    return totalBatches;
  }

  async getQueueStats(): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  }> {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      this.queue.getWaitingCount(),
      this.queue.getActiveCount(),
      this.queue.getCompletedCount(),
      this.queue.getFailedCount(),
      this.queue.getDelayedCount(),
    ]);
    return { waiting, active, completed, failed, delayed };
  }

  async retryAllFailed(): Promise<number> {
    const failed = await this.queue.getFailed(0, 1000);
    let retried = 0;
    for (const job of failed) {
      try {
        await job.retry();
        retried++;
      } catch (error) {
        this.logger.error(
          `Failed to retry job ${job.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return retried;
  }

  async drain(): Promise<void> {
    await this.queue.drain();
    this.logger.warn('Notification queue drained — all pending jobs removed');
  }
}
