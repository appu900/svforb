import { Injectable } from '@nestjs/common';
import { RedisService } from 'src/infra/redis/redis.service';

const K = {
  LOCATIONS: (orgId: number) => `charity:locations:${orgId}`,
  LOCATION: (siteId: number) => `charity:location:${siteId}`,
  USERS: (orgId: number) => `charity:users:${orgId}`,
} as const;

const TTL = {
  LOCATIONS: 5 * 60,
  LOCATION: 5 * 60,
  USERS: 3 * 60,
} as const;

@Injectable()
export class CharityCacheManager {
  constructor(private readonly redis: RedisService) {}

  async getLocations<T>(orgId: number): Promise<T | null> {
    return this.redis.getJson<T>(K.LOCATIONS(orgId));
  }

  async setLocations<T>(orgId: number, data: T): Promise<void> {
    await this.redis.setJson(K.LOCATIONS(orgId), data, TTL.LOCATIONS);
  }

  async invalidateLocations(orgId: number): Promise<void> {
    await this.redis.del(K.LOCATIONS(orgId));
  }

  async getLocation<T>(siteId: number): Promise<T | null> {
    return this.redis.getJson<T>(K.LOCATION(siteId));
  }

  async setLocation<T>(siteId: number, data: T): Promise<void> {
    await this.redis.setJson(K.LOCATION(siteId), data, TTL.LOCATION);
  }

  async invalidateLocation(siteId: number): Promise<void> {
    await this.redis.del(K.LOCATION(siteId));
  }

  async getUsers<T>(orgId: number): Promise<T | null> {
    return this.redis.getJson<T>(K.USERS(orgId));
  }

  async setUsers<T>(orgId: number, data: T): Promise<void> {
    await this.redis.setJson(K.USERS(orgId), data, TTL.USERS);
  }

  async invalidateUsers(orgId: number): Promise<void> {
    await this.redis.del(K.USERS(orgId));
  }
}
