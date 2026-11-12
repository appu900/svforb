import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { S3Module } from '../../uploads/s3/s3.module';
import { RedisGeoSearchModule } from '../redis-geo-search/redis-geo-search.module';
import { FoodListingController } from './controller/food.listing.controller';
import { FoodListingService } from './services/food.listing.service';
import { FoodListingCacheManager } from './cache/food.listing.cache';
import { ListingQueueService, LISTINGS_QUEUE } from './queues/listing.queue.service';
import { ListingWorker } from './workers/listing.worker';
import { SiteNotificationService } from './services/site.notification.service';
import { EnterpriseModule } from '../enterprise/enterprise.module';

@Module({
  imports: [EnterpriseModule, 
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
    SiteNotificationService,
  ],
  // The consolidated module writes its listings through the same code path,
  // so it needs the same queue and cache as an ordinary listing.
  exports: [FoodListingService, ListingQueueService, FoodListingCacheManager],
})
export class FoodListingModule {}
