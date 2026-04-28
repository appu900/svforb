import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CharityController } from './charity.controller';
import { CharityCacheManager } from './cache/charity.cache.manager';
import { CharityService } from './service/charity.service';

@Module({
  imports: [AuthModule],
  controllers: [CharityController],
  providers: [CharityService, CharityCacheManager],
})
export class CharityModule {}
