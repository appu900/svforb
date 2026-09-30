import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { RedisService } from '../redis/redis.service';
import { CACHE_DOMAINS, CacheDomain } from './http-cache.domains';

/**
 * Redis is an optimisation here, never a dependency: a slow or unreachable
 * Redis must fall through to the database rather than stall the request.
 */
const REDIS_TIMEOUT_MS = 200;

/** Larger responses are served uncached rather than bloating Redis. */
const MAX_CACHED_BYTES = 512 * 1024;

/**
 * Cached GET responses, invalidated by domain version.
 *
 * Each domain has a counter. Response keys embed the counter's value at the
 * moment the request started, so invalidating a domain is one INCR — every key
 * built from the old version simply stops being read and ages out on its TTL.
 * No SCAN, no multi-key DEL.
 *
 * Reading the version before the handler runs also closes the classic race: a
 * GET that started before a write stores its (possibly stale) result under the
 * old version, which nothing reads any more.
 */
@Injectable()
export class HttpCacheService {
  private readonly logger = new Logger(HttpCacheService.name);
  readonly enabled = process.env.HTTP_CACHE_ENABLED !== 'false';

  constructor(private readonly redis: RedisService) {}

  /** The domain's current version, or null when Redis cannot answer in time. */
  async version(domain: CacheDomain): Promise<string | null> {
    return this.safely(async () => (await this.redis.get(versionKey(domain))) ?? '0');
  }

  key(domain: CacheDomain, version: string, scope: string, url: string): string {
    const digest = createHash('sha1').update(`${scope}|${url}`).digest('hex');
    return `httpcache:${domain}:v${version}:${digest}`;
  }

  async read(key: string): Promise<{ value: unknown } | null> {
    const raw = await this.safely(() => this.redis.get(key));
    if (raw == null) return null;
    try {
      return { value: JSON.parse(raw) };
    } catch {
      return null;
    }
  }

  async write(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (value === undefined) return;
    let raw: string;
    try {
      raw = JSON.stringify(value);
    } catch {
      return;
    }
    if (raw.length > MAX_CACHED_BYTES) return;
    await this.safely(() => this.redis.set(key, raw, ttlSeconds));
  }

  /**
   * Makes every cached response in these domains stale. Safe to call from
   * workers and webhooks as well as HTTP writes.
   */
  async invalidate(domains: readonly CacheDomain[] = CACHE_DOMAINS): Promise<void> {
    if (!this.enabled || !domains.length) return;
    const client = this.redis.getClient();
    await this.safely(() =>
      Promise.all([...new Set(domains)].map((d) => client.incr(versionKey(d)))),
    );
  }

  private async safely<T>(op: () => Promise<T>): Promise<T | null> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), REDIS_TIMEOUT_MS);
    });
    try {
      return await Promise.race([op(), timeout]);
    } catch (err) {
      this.logger.warn(`HTTP cache skipped: ${err instanceof Error ? err.message : err}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

function versionKey(domain: CacheDomain): string {
  return `httpcache:ver:${domain}`;
}
