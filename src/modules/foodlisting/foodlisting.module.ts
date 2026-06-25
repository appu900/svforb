import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { S3Module } from 'src/uploads/s3/s3.module';
import { RedisGeoSearchModule } from '../redis-geo-search/redis-geo-search.module';
import { FoodListingController } from './controller/food.listing.controller';
import { FoodListingService } from './services/food.listing.service';
import { FoodListingCacheManager } from './cache/food.listing.cache';
import { ListingQueueService, LISTINGS_QUEUE } from './queues/listing.queue.service';
import { ListingWorker } from './workers/listing.worker';

@Module({
  imports: [
    S3Module,
    RedisGeoSearchModule,
    BullModule.registerQueue({ name: LISTINGS_QUEUE }),
  ],
  controllers: [FoodListingController],
  providers: [
    FoodListingService,
    FoodListingCacheManager,
    ListingQueueService,
    ListingWorker,
  ],
  exports: [FoodListingService],
})
export class FoodListingModule {}
