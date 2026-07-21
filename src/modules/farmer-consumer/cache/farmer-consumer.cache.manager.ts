import { Injectable } from '@nestjs/common';
import { RedisService } from '../../../infra/redis/redis.service';

const K = {
  USERS: (orgId: number) => `fc:users:${orgId}`,
} as const;

const TTL_USERS = 3 * 60;

@Injectable()
export class FarmerConsumerCacheManager {
  constructor(private readonly redis: RedisService) {}

  async getUsers<T>(orgId: number): Promise<T | null> {
    return this.redis.getJson<T>(K.USERS(orgId));
  }

  async setUsers<T>(orgId: number, data: T): Promise<void> {
    await this.redis.setJson(K.USERS(orgId), data, TTL_USERS);
  }

  async invalidateUsers(orgId: number): Promise<void> {
    await this.redis.del(K.USERS(orgId));
  }
}
