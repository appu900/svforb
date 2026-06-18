import { Injectable } from '@nestjs/common';
import { RedisService } from '../../../infra/redis/redis.service';

const K = {
  LISTING:          (id: number)               => `listing:single:${id}`,
  ORG_PAGE:         (orgId: number, page: number) => `listing:org:${orgId}:p${page}`,
  RECENT_PAGE:      (page: number)             => `listing:recent:p${page}`,
} as const;

const TTL = {
  LISTING:   5 * 60,  // 5 min — single listing detail
  ORG_PAGE:  2 * 60,  // 2 min — org listing page
  RECENT:    60,      // 1 min — recent global feed (changes fast)
} as const;

@Injectable()
export class FoodListingCacheManager {
  constructor(private readonly redis: RedisService) {}

  async getListing<T>(id: number): Promise<T | null> {
    return this.redis.getJson<T>(K.LISTING(id));
  }

  async setListing<T>(id: number, data: T): Promise<void> {
    await this.redis.setJson(K.LISTING(id), data, TTL.LISTING);
  }

  async delListing(id: number): Promise<void> {
    await this.redis.del(K.LISTING(id));
  }

  async getOrgPage<T>(orgId: number, page: number): Promise<T | null> {
    return this.redis.getJson<T>(K.ORG_PAGE(orgId, page));
  }

  async setOrgPage<T>(orgId: number, page: number, data: T): Promise<void> {
    await this.redis.setJson(K.ORG_PAGE(orgId, page), data, TTL.ORG_PAGE);
  }

  // On create/update invalidate page 1 only — further pages go stale by TTL
  async invalidateOrgPage1(orgId: number): Promise<void> {
    await this.redis.del(K.ORG_PAGE(orgId, 1));
  }

  async getRecentPage<T>(page: number): Promise<T | null> {
    return this.redis.getJson<T>(K.RECENT_PAGE(page));
  }

  async setRecentPage<T>(page: number, data: T): Promise<void> {
    await this.redis.setJson(K.RECENT_PAGE(page), data, TTL.RECENT);
  }

  async invalidateRecentPage1(): Promise<void> {
    await this.redis.del(K.RECENT_PAGE(1));
  }
}
