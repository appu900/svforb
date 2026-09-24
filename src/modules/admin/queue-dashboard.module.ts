import { Module } from '@nestjs/common';
import { BullBoardModule } from '@bull-board/nestjs';
import { ExpressAdapter } from '@bull-board/express';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { BullModule } from '@nestjs/bullmq';

import { BILLING_QUEUE } from '../billing/queues/billing.queue.service';
import { ENTERPRISE_QUEUE } from '../enterprise/queues/enterprise.queue.service';
import { LISTINGS_QUEUE } from '../foodlisting/queues/listing.queue.service';
import { NOTIFICATION_QUEUE_NAME } from '../notifications/constants';
import { EMAIL_QUEUE } from '../notifications/types/email.types';

/** Every queue this application owns. Others share the Redis instance. */
const QUEUES = [
  EMAIL_QUEUE,
  NOTIFICATION_QUEUE_NAME,
  LISTINGS_QUEUE,
  BILLING_QUEUE,
  ENTERPRISE_QUEUE,
] as const;

/**
 * A view over the BullMQ queues: what ran, what failed, and — the reason this
 * exists — when each repeatable sweep last fired and is next due.
 *
 * Mounted at the server root rather than under the API prefix, because
 * bull-board registers its own Express middleware and `setGlobalPrefix` does
 * not apply to it. Access is gated by basic auth in `main.ts`: job payloads
 * include OTP codes, so this must never be reachable unauthenticated.
 */
@Module({
  imports: [
    BullBoardModule.forRoot({
      route: '/admin/queues',
      adapter: ExpressAdapter,
    }),
    // Registered here as well as in each owning module — bull-board resolves
    // the queue from this module's own injection context.
    ...QUEUES.map((name) => BullModule.registerQueue({ name })),
    ...QUEUES.map((name) =>
      BullBoardModule.forFeature({ name, adapter: BullMQAdapter }),
    ),
  ],
})
export class QueueDashboardModule {}
