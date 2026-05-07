import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { FOOD_LISTING_QUEUE } from './types/queue.types';
import { FoodListingController } from './foodlisting.controller';
import { FoodListingService } from './foodlisting.service';
import { ProximityModule } from '../psearch/psearch.module';


@Module({
  imports: [
    BullModule.registerQueue({ name: FOOD_LISTING_QUEUE }),
    ProximityModule
  ],
  controllers: [FoodListingController],
  providers: [FoodListingService],
})
export class FoodListingModule {}
