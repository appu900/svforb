import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EnterpriseModule } from '../enterprise/enterprise.module';
import { NotificationModule } from '../notifications/notification.module';
import { ConnectionDailyService } from './connection.daily.service';
import { ConnectionNotifier } from './connection.notifier';
import { ConnectionService } from './connection.service';
import {
  CharityConnectionController, ConnectionController,
} from './controllers/connection.controller';
import { CONNECTION_QUEUE, ConnectionQueueService } from './queues/connection.queue.service';
import { ConnectionWorker } from './workers/connection.worker';

@Module({
  imports: [
    AuthModule,
    NotificationModule,
    // For snapshotForSite, so a listing carries the same Enterprise
    // classification as any other.
    EnterpriseModule,
    BullModule.registerQueue({ name: CONNECTION_QUEUE }),
  ],
  controllers: [ConnectionController, CharityConnectionController],
  providers: [
    ConnectionService,
    ConnectionDailyService,
    ConnectionNotifier,
    ConnectionQueueService,
    ConnectionWorker,
  ],
  exports: [ConnectionService, ConnectionDailyService],
})
export class ConnectionsModule {}
