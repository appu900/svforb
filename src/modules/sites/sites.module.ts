import { Module } from '@nestjs/common';
import { SitesController } from './sites.controller';
import { SitesService } from './service/sites.service';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { NotificationModule } from '../notifications/notification.module';
import { ProximityModule } from '../psearch/psearch.module';

@Module({
  imports: [AuthModule, NotificationModule, ProximityModule, BillingModule],
  controllers: [SitesController],
  providers: [SitesService],
})
export class SitesModule {}
