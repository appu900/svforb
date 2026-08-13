import { Injectable } from '@nestjs/common';
import { RedisService } from '../../../infra/redis/redis.service';

const K = {
  LISTING_CLAIMS: (listingId: number) => `claims:listing:${listingId}`,
  MY_CLAIMS:      (orgId: number, page: number) => `claims:org:v3:${orgId}:p${page}`,
  // mirror keys from FoodListingCacheManager so claims can bust them
  LISTING_DETAIL: (id: number) => `listing:single:${id}`,
  RECENT_PAGE1:   () => `listing:recent:p1`,
} as const;

const TTL = {
  LISTING_CLAIMS: 60,
  MY_CLAIMS:      2 * 60,
} as const;

@Injectable()
export class ClaimsCacheManager {
  constructor(private readonly redis: RedisService) {}

  async getListingClaims<T>(listingId: number): Promise<T | null> {
    return this.redis.getJson<T>(K.LISTING_CLAIMS(listingId));
  }

  async setListingClaims<T>(listingId: number, data: T): Promise<void> {
    await this.redis.setJson(K.LISTING_CLAIMS(listingId), data, TTL.LISTING_CLAIMS);
  }

  async delListingClaims(listingId: number): Promise<void> {
    await this.redis.del(K.LISTING_CLAIMS(listingId));
  }

  async getMyClaims<T>(orgId: number, page: number): Promise<T | null> {
    return this.redis.getJson<T>(K.MY_CLAIMS(orgId, page));
  }

  async setMyClaims<T>(orgId: number, page: number, data: T): Promise<void> {
    await this.redis.setJson(K.MY_CLAIMS(orgId, page), data, TTL.MY_CLAIMS);
  }

  async invalidateMyClaims(orgId: number): Promise<void> {
    await this.redis.del(K.MY_CLAIMS(orgId, 1));
  }

  async invalidateListing(listingId: number): Promise<void> {
    await this.redis.del(K.LISTING_DETAIL(listingId));
  }

  async invalidateRecentPage1(): Promise<void> {
    await this.redis.del(K.RECENT_PAGE1());
  }

  /** Bust restaurant org listings page 1 (provider feedback / claim changes). */
  async invalidateOrgListings(orgId: number): Promise<void> {
    await this.redis.del(`listing:org:v3:${orgId}:p1`);
  }

  /** Bust all nearby Available Food caches after claim mutations. */
  async invalidateAllNearby(): Promise<void> {
    await this.redis.deleteByPattern('listing:nearby:*');
  }

  async invalidateNearbySite(siteId: number): Promise<void> {
    await this.redis.deleteByPattern(`listing:nearby:${siteId}:*`);
  }
}
