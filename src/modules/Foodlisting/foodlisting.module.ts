import { Module } from '@nestjs/common';
import { FoodListingController } from './controller/food.listing.controller';
import { FoodListingService } from './services/food.listing.service';
import { FoodListingCacheManager } from './cache/food.listing.cache';

@Module({
  controllers: [FoodListingController],
  providers: [FoodListingService, FoodListingCacheManager],
  exports: [FoodListingService],
})
export class FoodListingModule {}
