import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { SubscriptionStatus } from '@prisma/client';
import { Job } from 'bullmq';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { BILLING_JOBS } from '../../../infra/queues/queus.constants';
import { NotificationService } from '../../notifications/services/notification.service';
import { BILLING_QUEUE } from '../queues/billing.queue.service';

@Processor(BILLING_QUEUE)
export class BillingWorker extends WorkerHost {
  private readonly logger = new Logger(BillingWorker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationService: NotificationService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case BILLING_JOBS.CHECK_TRIAL_EXPIRY:
        await this.expireLapsedTrials();
        break;
      default:
        this.logger.warn(`Unhandled billing job: ${job.name}`);
    }
  }

  /**
   * Trials started through Checkout hold a card and convert on their own. This
   * only catches rows from the earlier card-free flow, which have no Stripe
   * object to convert — they expire and the org is blocked until it checks out.
   */
  private async expireLapsedTrials() {
    const now = new Date();

    const lapsed = await this.prisma.orgSubscription.findMany({
      where: {
        status: SubscriptionStatus.TRIALING,
        trialEndsAt: { lt: now },
        // Stripe-backed trials convert on their own — leave those to webhooks.
        stripeSubscriptionId: null,
      },
      select: { id: true, organisationId: true },
    });

    if (!lapsed.length) return;

    await this.prisma.orgSubscription.updateMany({
      where: { id: { in: lapsed.map((s) => s.id) } },
      data: { status: SubscriptionStatus.EXPIRED },
    });

    this.logger.log(`Expired ${lapsed.length} lapsed trial(s)`);

    for (const sub of lapsed) {
      const userIds = await this.prisma.user.findMany({
        where: {
          isActive: true,
          orgMemeberShips: { some: { organisationId: sub.organisationId } },
        },
        select: { id: true },
      });
      if (!userIds.length) continue;

      await this.notificationService
        .send({
          title: 'Your free trial has ended',
          body: 'Choose a plan to keep listing surplus food and tracking your impact.',
          data: { type: 'trial_expired', organisationId: String(sub.organisationId) },
          targetUserIds: userIds.map((u) => String(u.id)),
          priority: 'high',
        })
        .catch((err) =>
          this.logger.warn(`trial-expired notification failed: ${err.message}`),
        );
    }
  }
}
