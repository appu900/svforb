import { Module } from '@nestjs/common';
import { S3Module } from 'src/uploads/s3/s3.module';
import { FoodListingController } from './controller/food.listing.controller';
import { FoodListingService } from './services/food.listing.service';
import { FoodListingCacheManager } from './cache/food.listing.cache';

@Module({
  imports: [S3Module],
  controllers: [FoodListingController],
  providers: [FoodListingService, FoodListingCacheManager],
  exports: [FoodListingService],
})
export class FoodListingModule {}
