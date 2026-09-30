import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConnectionStatus } from '@prisma/client';
import { Job } from 'bullmq';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { HttpCacheService } from '../../../infra/http-cache/http-cache.service';
import { ConnectionDailyService } from '../connection.daily.service';
import { CONNECTION_JOBS, CONNECTION_QUEUE } from '../queues/connection.queue.service';

@Processor(CONNECTION_QUEUE)
export class ConnectionWorker extends WorkerHost {
  private readonly logger = new Logger(ConnectionWorker.name);

  constructor(
    private readonly daily: ConnectionDailyService,
    private readonly prisma: PrismaService,
    private readonly httpCache: HttpCacheService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case CONNECTION_JOBS.PROMPT_DUE:
        if (await this.daily.promptDueCollections()) await this.invalidateCache();
        break;

      case CONNECTION_JOBS.SWEEP_UNCONFIRMED: {
        const { escalated, released } = await this.daily.sweepUnconfirmed();
        // Business silence at the 2.5-hour deadline — notify the charity.
        const missed = await this.daily.sweepMissed();
        if (escalated || released || missed) await this.invalidateCache();
        break;
      }

      case CONNECTION_JOBS.EXPIRE_INVITATIONS:
        await this.expireInvitations();
        break;

      default:
        this.logger.warn(`Unhandled connection job: ${job.name}`);
    }
  }

  /** Released days publish listings, so both sides of a connection go stale. */
  private invalidateCache(): Promise<void> {
    return this.httpCache.invalidate(['structure', 'activity']);
  }

  /** An invitation nobody answers expires rather than sitting forever. */
  private async expireInvitations(): Promise<void> {
    const result = await this.prisma.connection.updateMany({
      where: {
        status: ConnectionStatus.PENDING,
        invitationExpiresAt: { lt: new Date() },
      },
      data: { status: ConnectionStatus.EXPIRED },
    });
    if (result.count) {
      this.logger.log(`Expired ${result.count} unanswered connection invitation(s)`);
      await this.invalidateCache();
    }
  }
}
