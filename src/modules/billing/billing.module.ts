import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { BillingController } from './billing.controller';
import { BillingQueueService, BILLING_QUEUE } from './queues/billing.queue.service';
import { BillingService } from './services/billing.service';
import { StripeService } from './services/stripe.service';
import { StripeWebhookService } from './services/stripe-webhook.service';
import { StripeWebhookController } from './stripe-webhook.controller';
import { BillingWorker } from './workers/billing.worker';

@Module({
  imports: [ConfigModule, AuthModule, BullModule.registerQueue({ name: BILLING_QUEUE })],
  controllers: [BillingController, StripeWebhookController],
  providers: [
    StripeService,
    StripeWebhookService,
    BillingService,
    BillingQueueService,
    BillingWorker,
  ],
  exports: [StripeService, BillingService],
})
export class BillingModule {}
