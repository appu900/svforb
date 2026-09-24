import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConnectionStatus } from '@prisma/client';
import { Job } from 'bullmq';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { ConnectionDailyService } from '../connection.daily.service';
import { CONNECTION_JOBS, CONNECTION_QUEUE } from '../queues/connection.queue.service';

@Processor(CONNECTION_QUEUE)
export class ConnectionWorker extends WorkerHost {
  private readonly logger = new Logger(ConnectionWorker.name);

  constructor(
    private readonly daily: ConnectionDailyService,
    private readonly prisma: PrismaService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case CONNECTION_JOBS.PROMPT_DUE:
        await this.daily.promptDueCollections();
        break;

      case CONNECTION_JOBS.SWEEP_UNCONFIRMED:
        await this.daily.sweepUnconfirmed();
        // Days whose window closed with nothing published at all.
        await this.daily.sweepMissed();
        break;

      case CONNECTION_JOBS.EXPIRE_INVITATIONS:
        await this.expireInvitations();
        break;

      default:
        this.logger.warn(`Unhandled connection job: ${job.name}`);
    }
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
    }
  }
}
