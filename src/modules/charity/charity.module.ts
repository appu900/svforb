import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CharityController } from './charity.controller';
import { CharityCacheManager } from './cache/charity.cache.manager';
import { CharityService } from './service/charity.service';
import { ProximityModule } from '../psearch/psearch.module';
import { RedisGeoSearchModule } from '../redis-geo-search/redis-geo-search.module';

@Module({
  imports: [AuthModule, ProximityModule, RedisGeoSearchModule],
  controllers: [CharityController],
  providers: [CharityService, CharityCacheManager],
})
export class CharityModule {}
