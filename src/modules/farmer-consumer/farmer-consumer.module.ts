import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FarmerConsumerController } from './farmer-consumer.controller';
import { FarmerConsumerService } from './service/farmer-consumer.service';
import { FarmerConsumerCacheManager } from './cache/farmer-consumer.cache.manager';

@Module({
  imports: [AuthModule],
  controllers: [FarmerConsumerController],
  providers: [FarmerConsumerService, FarmerConsumerCacheManager],
})
export class FarmerConsumerModule {}
