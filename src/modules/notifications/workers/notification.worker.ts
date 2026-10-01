import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
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
import { parseNotificationRecordId } from '../notification-id';
import {
  notificationIsTerminal,
  retryDelayMs,
  shouldRequeueRetryableTokens,
} from '../notification-status';
import {
  NOTIFICATION_QUEUE_NAME,
  WORKER_CONCURRENCY,
  TOKEN_FAILURE_THRESHOLD,
  FAN_OUT_BATCH_SIZE,
  targetAppFromChannel,
  toPrismaTargetApp,
} from '../constants';

@Processor(NOTIFICATION_QUEUE_NAME, { concurrency: WORKER_CONCURRENCY })
export class NotificationWorker extends WorkerHost implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationWorker.name);
  private recoverTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly firebase: FirebaseGateway,
    private readonly expo: ExpoGateway,
    private readonly producer: NotificationProducer,
  ) {
    super();
  }

  async onModuleInit() {
    await this.recoverStuckQueued({ olderThanMs: 0 });
    this.recoverTimer = setInterval(() => {
      void this.recoverStuckQueued({ olderThanMs: 90_000 });
    }, 2 * 60 * 1000);
    this.recoverTimer.unref?.();
  }

  onModuleDestroy() {
    if (this.recoverTimer) clearInterval(this.recoverTimer);
  }

  /** Re-enqueue DB rows still `queued` so a lost Redis job cannot block a user forever. */
  private async recoverStuckQueued(opts: { olderThanMs: number }): Promise<void> {
    const newest = new Date(Date.now() - opts.olderThanMs);
    const since = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const stuck = await this.prisma.notificationRecord.findMany({
      where: {
        status: 'queued',
        createdAt: { gte: since, lte: newest },
      },
      select: { id: true, priority: true },
      orderBy: { id: 'asc' },
      take: 30,
    });
    if (!stuck.length) return;

    this.logger.warn(
      `Re-queueing ${stuck.length} stuck notification(s) still queued`,
    );
    for (const row of stuck) {
      await this.producer.enqueueNotification(
        row.id,
        (row.priority as 'high' | 'normal' | 'low') ?? 'normal',
        undefined,
        { replaceFinished: true },
      );
    }
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
      const notificationId = parseNotificationRecordId(job.data.notificationId);
      if (notificationId == null) {
        this.logger.warn(
          `Skipping failed-status update — junk notificationId=${String(job.data.notificationId)}`,
        );
        return;
      }
      try {
        await this.prisma.notificationRecord.update({
          where: { id: notificationId },
          data: {
            status: 'failed',
            lastError: `Job permanently failed after ${job.attemptsMade} attempts: ${error.message}`,
            completedAt: new Date(),
          },
        });
        this.logger.warn(
          `Notification ${notificationId} marked FAILED after max retries`,
        );
      } catch (dbErr) {
        this.logger.error(
          `Failed to update notification status on final failure: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`,
        );
      }
    }
  }


  private async handleFanOut(job: Job<FanOutJobData>): Promise<void> {
    const notificationId = parseNotificationRecordId(job.data.notificationId);
    if (notificationId == null) {
      this.logger.warn(
        `Dropping fan-out job ${job.id} — invalid notificationId=${String(job.data.notificationId)}`,
      );
      return;
    }

    const notif = await this.prisma.notificationRecord.findUnique({
      where: { id: notificationId },
    });

    if (!notif) {
      this.logger.error(`Notification ${notificationId} not found — skipping`);
      return;
    }

    if (notificationIsTerminal(notif.status)) {
      this.logger.log(
        `Fan-out ${notificationId} already ${notif.status} — skipping`,
      );
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
      await this.sendTokens(notif, tokens, 0);
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
    const { tokens, batchIndex } = job.data;
    const notificationId = parseNotificationRecordId(job.data.notificationId);
    if (notificationId == null) {
      this.logger.warn(
        `Dropping send-batch job ${job.id} — invalid notificationId=${String(job.data.notificationId)}`,
      );
      return;
    }

    const notif = await this.prisma.notificationRecord.findUnique({
      where: { id: notificationId },
    });

    if (!notif) {
      this.logger.error(
        `Notification ${notificationId} not found for batch ${batchIndex} — skipping`,
      );
      return;
    }

    if (notificationIsTerminal(notif.status)) {
      this.logger.log(
        `Send-batch ${job.id} for notification ${notificationId} already ${notif.status} — dropping`,
      );
      return;
    }

    await this.sendTokens(notif, tokens, job.data.retryGeneration ?? 0);
  }

  private async sendTokens(
    notif: {
      id: number;
      title: string;
      body: string;
      data: any;
      imageUrl: string | null;
      deepLink: string | null;
      channel: string;
      failureCount?: number;
    },
    tokens: TokenWithType[],
    retryGeneration: number,
  ): Promise<void> {
    const targetApp = targetAppFromChannel(notif.channel);
    const data = stringifyRecordValues(notif.data ?? {});
    const categoryId = data.categoryId?.trim();
    const payload: FirebaseMessagePayload = {
      title: notif.title,
      body: notif.body,
      data: {
        ...data,
        ...(notif.deepLink ? { deepLink: notif.deepLink } : {}),
        notificationId: String(notif.id),
      },
      imageUrl: notif.imageUrl ?? undefined,
      ...(categoryId ? { apns: { category: categoryId } } : {}),
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
        ? this.firebase.sendToTokens(fcmTokens, payload, targetApp)
        : Promise.resolve<BatchSendResult>({ successTokens: [], retryableTokens: [], invalidTokens: [] }),
    ]);

    const result: BatchSendResult = {
      successTokens: [...expoResult.successTokens, ...firebaseResult.successTokens],
      retryableTokens: [...expoResult.retryableTokens, ...firebaseResult.retryableTokens],
      invalidTokens: [...expoResult.invalidTokens, ...firebaseResult.invalidTokens],
      configError: firebaseResult.configError ?? expoResult.configError,
    };

    await this.updateTokenHealth(result.successTokens, result.invalidTokens);

    if (result.invalidTokens.length > 0) {
      await this.prisma.deviceToken.updateMany({
        where: { token: { in: result.invalidTokens } },
        data: { isActive: false, deactivationReason: 'unregistered', lastFailureAt: new Date() },
      });
    }

    const willRetry = shouldRequeueRetryableTokens({
      retryGeneration,
      failureCount: notif.failureCount ?? 0,
    });
    const failedNow =
      result.invalidTokens.length + (willRetry ? 0 : result.retryableTokens.length);

    await this.prisma.$executeRaw`
      UPDATE notification_records
      SET "successCount" = "successCount" + ${result.successTokens.length},
          "failureCount" = "failureCount" + ${failedNow}
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

      if (willRetry) {
        const retryDocs = await this.prisma.deviceToken.findMany({
          where: {
            token: { in: result.retryableTokens },
            isActive: true,
            targetApp: toPrismaTargetApp(targetApp),
          },
          select: { token: true, tokenType: true },
        });

        // Tokens deactivated between attempts are silently absent from
        // retryDocs. Without counting them the row never reaches totalTargets
        // and sits in `processing` until the 30-minute timeout.
        const droppedCount = result.retryableTokens.length - retryDocs.length;
        if (droppedCount > 0) {
          await this.prisma.$executeRaw`
            UPDATE notification_records
            SET "failureCount" = "failureCount" + ${droppedCount}
            WHERE id = ${notif.id}
          `;
          this.logger.warn(
            `Retry tokens no longer deliverable: notificationId=${notif.id} dropped=${droppedCount}`,
          );
        }

        if (retryDocs.length > 0) {
          const nextGeneration = retryGeneration + 1;
          const retryTokens: TokenWithType[] = retryDocs.map((d) => ({
            token: d.token,
            tokenType: d.tokenType.toLowerCase() as 'apns' | 'fcm' | 'expo',
          }));
          await this.producer.enqueueBatches(notif.id, retryTokens, 'low', {
            retryGeneration: nextGeneration,
            delayMs: retryDelayMs(retryGeneration),
          });
          this.logger.log(
            `Retryable tokens requeued: notificationId=${notif.id} retryCount=${retryTokens.length} generation=${nextGeneration}`,
          );
        }
      } else {
        this.logger.warn(
          `Retryable tokens counted as failure (retries exhausted): notificationId=${notif.id} retryCount=${result.retryableTokens.length} generation=${retryGeneration}`,
        );
      }
    }

    // A provider that is not configured cannot be retried into working. Any
    // results from a provider that *is* configured have already been recorded
    // above, so failing here loses nothing and puts the job in the Failed tab
    // where the misconfiguration is visible.
    if (result.configError) {
      await this.finalizeIfComplete(notif.id);
      throw new Error(result.configError);
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
    channel: string;
  }): Promise<TokenWithType[]> {
    const targetApp = targetAppFromChannel(notif.channel);
    const where: any = {
      isActive: true,
      targetApp: toPrismaTargetApp(targetApp),
    };

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
      select: { token: true, tokenType: true, appBundle: true },
    });

    return docs.map((d) => ({
      token: d.token,
      tokenType: d.tokenType.toLowerCase() as 'apns' | 'fcm' | 'expo',
      appBundle: d.appBundle,
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

function stringifyRecordValues(data: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    out[key] = typeof value === 'string' ? value : String(value);
  }
  return out;
}
