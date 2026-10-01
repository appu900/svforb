import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NOTIFICATION_QUEUE_NAME } from './constants';
import { EMAIL_QUEUE } from './types/email.types';

import { FirebaseGateway } from './gateways/firebase.gateway';
import { ExpoGateway } from './gateways/expo.gateway';

import { NotificationProducer } from './producers/notification.producer';
import { NotificationWorker } from './workers/notification.worker';

import { NotificationService } from './services/notification.service';
import { NotificationController } from './controllers/notification.controller';

import { MailerService } from './services/mailer.service';
import { EmailQueueService } from './queues/email.queue.service';
import { EmailWorker } from './workers/email.worker';
import { redisTlsEnabled } from '../../infra/redis/redis-tls';

/**
 * The braces keep every key in one hash slot, which ElastiCache serverless
 * requires. The name must not be `{bull}`: the legacy Mongo API shares this
 * Redis under that prefix, and its workers take any job they can see.
 */
export const BULL_PREFIX = '{svforb}';

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => {
        const redisUrl = config.get<string>('REDIS_URL');
        const useTls = redisTlsEnabled({
          redisUrl,
          tlsFlag: config.get<string>('REDIS_TLS'),
          host: config.get<string>('REDIS_HOST', 'localhost'),
        });

        // When REDIS_URL is set, pass the URL so rediss:// enables TLS.
        if (redisUrl) {
          return {
            prefix: BULL_PREFIX,
            connection: {
              url: useTls
                ? redisUrl.replace(/^redis:\/\//, 'rediss://')
                : redisUrl,
              maxRetriesPerRequest: null,
              enableReadyCheck: false,
            },
          };
        }

        return {
          prefix: BULL_PREFIX,
          connection: {
            host: config.get<string>('REDIS_HOST', 'localhost'),
            port: config.get<number>('REDIS_PORT', 6379),
            db: config.get<number>('REDIS_DB', 0),
            username: config.get<string>('REDIS_USERNAME'),
            password: config.get<string>('REDIS_PASSWORD'),
            ...(useTls ? { tls: {} } : {}),
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
          },
        };
      },
      inject: [ConfigService],
    }),
    BullModule.registerQueue({ name: NOTIFICATION_QUEUE_NAME }),
    BullModule.registerQueue({ name: EMAIL_QUEUE }),
  ],
  controllers: [NotificationController],
  providers: [
    FirebaseGateway,
    ExpoGateway,
    NotificationProducer,
    NotificationWorker,
    NotificationService,

    MailerService,
    EmailQueueService,
    EmailWorker,
  ],
  // FirebaseGateway is exported so the health check can report whether push
  // delivery is actually configured.
  exports: [NotificationService, EmailQueueService, FirebaseGateway],
})
export class NotificationModule {}
