import { Module, Global } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EMAIL_QUEUE } from './types/email.types';
import { PUSH_QUEUE } from './types/push.types';
import { MailerService } from './services/mailer.service';
import { FirebaseService } from './services/firebase.service';
import { EmailQueueService } from './queues/email.queue.service';
import { PushQueueService } from './queues/push.queue.service';
import { EmailWorker } from './workers/email.worker';
import { PushWorker } from './workers/push.worker';

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => {
        const url = config.get<string>('REDIS_URL');
        const tls = config.get<string>('REDIS_TLS') === 'true';

        return {
          connection: url
            ? { url, ...(tls ? { tls: {} } : {}) }
            : {
                host: config.get<string>('REDIS_HOST', 'localhost'),
                port: config.get<number>('REDIS_PORT', 6379),
                password: config.get<string>('REDIS_PASSWORD'),
                username: config.get<string>('REDIS_USERNAME'),
                ...(tls ? { tls: {} } : {}),
              },
        };
      },
      inject: [ConfigService],
    }),
    BullModule.registerQueue({ name: EMAIL_QUEUE }),
    BullModule.registerQueue({ name: PUSH_QUEUE }),
  ],
  providers: [
    MailerService,
    // FirebaseService,
    EmailQueueService,
    PushQueueService,
    EmailWorker,
    // PushWorker,
  ],
  exports: [EmailQueueService, PushQueueService],
})
export class NotificationModule {}
