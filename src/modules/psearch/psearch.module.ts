import { Module }               from '@nestjs/common';
import { PrismaModule } from '../../infra/prisma/prisma.module';
import { RedisModule } from '../../infra/redis/redis.module';
import { ProximityController } from './p.controller';
import { ProximityService } from './psearch.service';



@Module({
  imports:     [PrismaModule, RedisModule],
  controllers: [ProximityController],
  providers:   [ProximityService],
  exports:     [ProximityService],
})
export class ProximityModule {}