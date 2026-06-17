import { Module } from '@nestjs/common';
import { RedisGeoSearchService } from './redis.geosearch.service';
import { RedisGeoSearchController } from './redis.geosearch.controller';

@Module({
  controllers: [RedisGeoSearchController],
  providers: [RedisGeoSearchService],
  exports: [RedisGeoSearchService],
})
export class RedisGeoSearchModule {}
