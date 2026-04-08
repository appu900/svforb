import { Module } from '@nestjs/common';
import { SitesController } from './sites.controller';
import { SitesService } from './service/sites.service';
import { AuthModule } from '../auth/auth.module';
import { NotificationModule } from '../notifications/notification.module';

@Module({
  imports: [AuthModule, NotificationModule],
  controllers: [SitesController],
  providers: [SitesService],
})
export class SitesModule {}
