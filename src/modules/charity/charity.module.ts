import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CharityController } from './charity.controller';
import { CharityCacheManager } from './cache/charity.cache.manager';
import { CharityService } from './service/charity.service';
import { ProximityController } from '../psearch/p.controller';
import { ProximityModule } from '../psearch/psearch.module';

@Module({
  imports: [AuthModule,ProximityModule],
  controllers: [CharityController],
  providers: [CharityService, CharityCacheManager],
})
export class CharityModule {}
