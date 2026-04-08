import { Module } from '@nestjs/common';
import { SitesController } from './sites.controller';
import { SitesService } from './service/sites.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [SitesController],
  providers: [SitesService],
})
export class SitesModule {}
