import { OnModuleDestroy, Injectable } from '@nestjs/common';
import Redis, { RedisOptions } from 'ioredis';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly client: Redis;

  constructor() {
    const options: RedisOptions = {
      maxRetriesPerRequest: 2,

      enableReadyCheck: true,

      retryStrategy: (attempt) => {
        const delay = Math.min(attempt * 100, 300);
        console.warn(`Redis retry ${attempt}, delay ${delay}ms`);
        return delay;
      },

      ...(process.env.REDIS_TLS === 'true' ? { tls: {} } : {}),

      username: process.env.REDIS_USERNAME,
      password: process.env.REDIS_PASSWORD,
    };

    if (process.env.REDIS_URL) {
      const url = process.env.REDIS_URL.replace(/^redis:\/\//, 'rediss://');
      this.client = new Redis(url, options);
    } else {
      this.client = new Redis({
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: Number(process.env.REDIS_PORT) || 6379,
        db: Number(process.env.REDIS_DB) || 0,
        ...options,
      });
    }

    this.setupEventHandlers();
    this.warmUp();
  }

  private setupEventHandlers() {
    this.client.on('connect', () => console.log('Redis: connected'));
    this.client.on('ready', () => console.log('Redis: ready'));
    this.client.on('reconnecting', () =>
      console.warn('Redis: reconnecting...'),
    );
    this.client.on('end', () => console.log('Redis: closed'));
    this.client.on('error', (err) => console.error('Redis: error:', err));
  }

  private async warmUp() {
    try {
      await this.client.ping();
    } catch (err) {
      console.error('Redis warmup failed', err);
    }
  }

  getClient(): Redis {
    return this.client;
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.client.setex(key, ttlSeconds, value);
    } else {
      await this.client.set(key, value);
    }
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async exists(key: string): Promise<boolean> {
    const result = await this.client.exists(key);
    return result === 1;
  }

  async ttl(key: string): Promise<number> {
    return this.client.ttl(key);
  }

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async setJson<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    await this.set(key, JSON.stringify(value), ttlSeconds);
  }

  async acquireLock(resource: string, ttlMs: number): Promise<boolean> {
    const key = `lock:${resource}`;
    const result = await this.client.set(key, '1', 'PX', ttlMs, 'NX');
    return result === 'OK';
  }

  async releaseLock(resource: string): Promise<void> {
    await this.client.del(`lock:${resource}`);
  }

  async storeToken(
    type: string,
    token: string,
    userId: string,
    ttlSeconds: number,
  ): Promise<void> {
    await this.set(`token:${type}:${token}`, userId, ttlSeconds);
  }

  async verifyToken(type: string, token: string): Promise<string | null> {
    return this.get(`token:${type}:${token}`);
  }

  async revokeToken(type: string, token: string): Promise<void> {
    await this.del(`token:${type}:${token}`);
  }

  async cacheGet<T>(namespace: string, id: string): Promise<T | null> {
    return this.getJson<T>(`cache:${namespace}:${id}`);
  }

  async cacheSet<T>(
    namespace: string,
    id: string,
    value: T,
    ttlSeconds = 300,
  ): Promise<void> {
    await this.setJson<T>(`cache:${namespace}:${id}`, value, ttlSeconds);
  }

  async cacheDel(namespace: string, id: string): Promise<void> {
    await this.del(`cache:${namespace}:${id}`);
  }

  async incrementWithExpiry(
    key: string,
    windowSeconds: number,
  ): Promise<number> {
    const multi = this.client.multi();
    multi.incr(key);
    multi.expire(key, windowSeconds);
    const results = await multi.exec();
    return (results?.[0]?.[1] as number) ?? 0;
  }

  async onModuleDestroy() {
    await this.client.quit();
  }
}
