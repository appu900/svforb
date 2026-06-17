import { Module } from '@nestjs/common';
import { RedisProxyController } from './redisproxy.controller';
import { RedisProxyService } from './redis.proxy,service';
import { RedisService } from '../../infra/redis/redis.service';
import { RedisModule } from '../../infra/redis/redis.module';

@Module({
  imports: [RedisModule],
  controllers: [RedisProxyController],
  providers: [RedisProxyService],
})
export class RedisProxyModule {}
