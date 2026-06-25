import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { TokenPlatform, TokenType } from '@prisma/client';
import { Job } from 'bullmq';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import {
  BatchSendResult,
  FanOutJobData,
  FirebaseMessagePayload,
  NotificationJobData,
  SendBatchJobData,
  TokenWithType,
} from '../interfaces';
import { FirebaseGateway } from '../gateways/firebase.gateway';
import { ExpoGateway } from '../gateways/expo.gateway';
import { NotificationProducer } from '../producers/notification.producer';
import {
  NOTIFICATION_QUEUE_NAME,
  WORKER_CONCURRENCY,
  TOKEN_FAILURE_THRESHOLD,
  FAN_OUT_BATCH_SIZE,
} from '../constants';

@Processor(NOTIFICATION_QUEUE_NAME, { concurrency: WORKER_CONCURRENCY })
export class NotificationWorker extends WorkerHost {
  private readonly logger = new Logger(NotificationWorker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly firebase: FirebaseGateway,
    private readonly expo: ExpoGateway,
    private readonly producer: NotificationProducer,
  ) {
    super();
  }

  async process(job: Job<NotificationJobData>): Promise<void> {
    switch (job.data.type) {
      case 'fan-out':
        return this.handleFanOut(job as Job<FanOutJobData>);
      case 'send-batch':
        return this.handleSendBatch(job as Job<SendBatchJobData>);
      default:
        throw new Error(`Unknown job type: ${(job.data as any).type}`);
    }
  }

  @OnWorkerEvent('active')
  onActive(job: Job<NotificationJobData>) {
    this.logger.log(
      `Job started: id=${job.id} type=${job.data.type} attempt=${job.attemptsMade + 1}`,
    );
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<NotificationJobData>) {
    this.logger.log(
      `Job completed: id=${job.id} type=${job.data.type} durationMs=${Date.now() - job.timestamp}`,
    );
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<NotificationJobData> | undefined, error: Error) {
    if (!job) return;

    this.logger.error(
      `Job failed: id=${job.id} type=${job.data.type} attempt=${job.attemptsMade}/${job.opts.attempts} error=${error.message}`,
    );

    if (job.attemptsMade >= (job.opts.attempts ?? JOB_ATTEMPTS_FALLBACK)) {
      try {
        await this.prisma.notificationRecord.update({
          where: { id: job.data.notificationId },
          data: {
            status: 'failed',
            lastError: `Job permanently failed after ${job.attemptsMade} attempts: ${error.message}`,
            completedAt: new Date(),
          },
        });
        this.logger.warn(
          `Notification ${job.data.notificationId} marked FAILED after max retries`,
        );
      } catch (dbErr) {
        this.logger.error(
          `Failed to update notification status on final failure: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`,
        );
      }
    }
  }


  private async handleFanOut(job: Job<FanOutJobData>): Promise<void> {
    const { notificationId } = job.data;

    const notif = await this.prisma.notificationRecord.findUnique({
      where: { id: notificationId },
    });

    if (!notif) {
      this.logger.error(`Notification ${notificationId} not found — skipping`);
      return;
    }

    await this.prisma.notificationRecord.update({
      where: { id: notificationId },
      data: { status: 'processing' },
    });

    const tokens = await this.resolveTokens(notif);

    if (tokens.length === 0) {
      await this.prisma.notificationRecord.update({
        where: { id: notificationId },
        data: {
          status: 'failed',
          lastError: 'No active device tokens found for targets',
          completedAt: new Date(),
        },
      });
      return;
    }

    await this.prisma.notificationRecord.update({
      where: { id: notificationId },
      data: { totalTargets: tokens.length },
    });

    if (tokens.length <= FAN_OUT_BATCH_SIZE) {
      await this.sendTokens(notif, tokens);
      return;
    }

    const totalBatches = await this.producer.enqueueBatches(
      notificationId,
      tokens,
      (notif.priority as 'high' | 'normal' | 'low') ?? 'normal',
    );

    this.logger.log(
      `Fan-out complete: notificationId=${notificationId} totalTokens=${tokens.length} totalBatches=${totalBatches}`,
    );
  }


  private async handleSendBatch(job: Job<SendBatchJobData>): Promise<void> {
    const { notificationId, tokens, batchIndex } = job.data;

    const notif = await this.prisma.notificationRecord.findUnique({
      where: { id: notificationId },
    });

    if (!notif) {
      this.logger.error(
        `Notification ${notificationId} not found for batch ${batchIndex} — skipping`,
      );
      return;
    }

    await this.sendTokens(notif, tokens);
  }

  private async sendTokens(
    notif: { id: number; title: string; body: string; data: any; imageUrl: string | null; deepLink: string | null },
    tokens: TokenWithType[],
  ): Promise<void> {
    const payload: FirebaseMessagePayload = {
      title: notif.title,
      body: notif.body,
      data: {
        ...(notif.data ?? {}),
        ...(notif.deepLink ? { deepLink: notif.deepLink } : {}),
        notificationId: String(notif.id),
      },
      imageUrl: notif.imageUrl ?? undefined,
    };

    const expoTokens = tokens.filter((t) => t.tokenType === 'expo').map((t) => t.token);
    const fcmTokens = tokens
      .filter((t) => t.tokenType === 'fcm' || t.tokenType === 'apns')
      .map((t) => t.token);

    const [expoResult, firebaseResult] = await Promise.all([
      expoTokens.length > 0
        ? this.expo.sendToTokens(expoTokens, payload)
        : Promise.resolve<BatchSendResult>({ successTokens: [], retryableTokens: [], invalidTokens: [] }),
      fcmTokens.length > 0
        ? this.firebase.sendToTokens(fcmTokens, payload)
        : Promise.resolve<BatchSendResult>({ successTokens: [], retryableTokens: [], invalidTokens: [] }),
    ]);

    const result: BatchSendResult = {
      successTokens: [...expoResult.successTokens, ...firebaseResult.successTokens],
      retryableTokens: [...expoResult.retryableTokens, ...firebaseResult.retryableTokens],
      invalidTokens: [...expoResult.invalidTokens, ...firebaseResult.invalidTokens],
    };

    await this.updateTokenHealth(result.successTokens, result.invalidTokens);

    if (result.invalidTokens.length > 0) {
      await this.prisma.deviceToken.updateMany({
        where: { token: { in: result.invalidTokens } },
        data: { isActive: false, deactivationReason: 'unregistered', lastFailureAt: new Date() },
      });
    }

    const failedCount = result.invalidTokens.length + result.retryableTokens.length;

    await this.prisma.$executeRaw`
      UPDATE notification_records
      SET "successCount" = "successCount" + ${result.successTokens.length},
          "failureCount" = "failureCount" + ${failedCount}
      WHERE id = ${notif.id}
    `;

    if (result.retryableTokens.length > 0) {
      await this.prisma.$executeRaw`
        UPDATE notification_records
        SET "failedTokens" = array(
          SELECT DISTINCT unnest("failedTokens" || ${result.retryableTokens}::text[])
        )
        WHERE id = ${notif.id}
      `;

      const retryDocs = await this.prisma.deviceToken.findMany({
        where: { token: { in: result.retryableTokens }, isActive: true },
        select: { token: true, tokenType: true },
      });

      if (retryDocs.length > 0) {
        const retryTokens: TokenWithType[] = retryDocs.map((d) => ({
          token: d.token,
          tokenType: d.tokenType.toLowerCase() as 'apns' | 'fcm' | 'expo',
        }));
        await this.producer.enqueueBatches(notif.id, retryTokens, 'low');
        this.logger.log(
          `Retryable tokens requeued: notificationId=${notif.id} retryCount=${retryTokens.length}`,
        );
      }
    }

    await this.finalizeIfComplete(notif.id);
  }


  private async finalizeIfComplete(notificationId: number): Promise<void> {
    const latest = await this.prisma.notificationRecord.findUnique({
      where: { id: notificationId },
    });
    if (!latest) return;

    const totalProcessed = (latest.successCount || 0) + (latest.failureCount || 0);
    const totalTargets = latest.totalTargets || 0;

    if (totalProcessed < totalTargets && totalTargets > 0) {
      const ageMs = Date.now() - latest.createdAt.getTime();
      if (ageMs < 30 * 60 * 1000) return;

      this.logger.warn(
        `Notification ${notificationId} timed out — finalizing: processed=${totalProcessed}/${totalTargets} ageMs=${ageMs}`,
      );
    }

    if (totalTargets === 0) return;

    let status: string;
    if (latest.successCount === 0) {
      status = 'failed';
    } else if (latest.failureCount > 0) {
      status = 'partially_sent';
    } else {
      status = 'sent';
    }

    await this.prisma.notificationRecord.update({
      where: { id: notificationId },
      data: { status, completedAt: new Date() },
    });

    this.logger.log(
      `Notification ${notificationId} complete: status=${status} success=${latest.successCount} failure=${latest.failureCount}`,
    );
  }


  private async resolveTokens(notif: {
    isBroadcast: boolean;
    targetUserIds: number[];
    targetPlatform: string;
  }): Promise<TokenWithType[]> {
    const where: any = { isActive: true };

    if (!notif.isBroadcast && notif.targetUserIds.length > 0) {
      where.userId = { in: notif.targetUserIds };
    } else if (!notif.isBroadcast) {
      return [];
    }

    if (notif.targetPlatform && notif.targetPlatform !== 'all') {
      where.platform =
        notif.targetPlatform === 'ios' ? TokenPlatform.IOS : TokenPlatform.ANDROID;
    }

    const docs = await this.prisma.deviceToken.findMany({
      where,
      select: { token: true, tokenType: true },
    });

    return docs.map((d) => ({
      token: d.token,
      tokenType: d.tokenType.toLowerCase() as 'apns' | 'fcm' | 'expo',
    }));
  }

  private async updateTokenHealth(
    successTokens: string[],
    failedTokens: string[],
  ): Promise<void> {
    const now = new Date();

    if (successTokens.length > 0) {
      await this.prisma.deviceToken.updateMany({
        where: { token: { in: successTokens } },
        data: { failureCount: 0, lastSuccessAt: now },
      });
    }

    if (failedTokens.length > 0) {
      await this.prisma.$executeRaw`
        UPDATE device_tokens
        SET "failureCount" = "failureCount" + 1,
            "lastFailureAt" = ${now}
        WHERE token = ANY(${failedTokens}::text[])
      `;

      await this.prisma.deviceToken.updateMany({
        where: { token: { in: failedTokens }, failureCount: { gte: TOKEN_FAILURE_THRESHOLD } },
        data: { isActive: false, deactivationReason: 'consecutive_failures' },
      });
    }
  }
}

const JOB_ATTEMPTS_FALLBACK = 3;
