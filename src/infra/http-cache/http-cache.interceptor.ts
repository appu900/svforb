import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, concatMap, of, tap } from 'rxjs';
import { Jwtpayload } from '../../modules/auth/interface/jwt.interface';
import { INVALIDATES_CACHE, NO_CACHE } from './http-cache.decorators';
import {
  CACHE_DOMAINS,
  CacheDomain,
  DOMAIN_TTL_SECONDS,
  INVALIDATES,
  domainForPath,
} from './http-cache.domains';
import { HttpCacheService } from './http-cache.service';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Global response cache. GETs are served from Redis; successful writes bump
 * the versions of the domains they affect, and the next GET rebuilds the entry.
 *
 * Responses are cached per caller: the key includes every JWT claim that can
 * change what a handler returns, so one user is never served another's data.
 * Guards run before interceptors, so authorisation still happens on every hit.
 *
 * Opt a route out with @NoCache(); narrow what a write invalidates with
 * @InvalidatesCache(...).
 */
@Injectable()
export class HttpCacheInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly cache: HttpCacheService,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    if (!this.cache.enabled || context.getType() !== 'http') return next.handle();

    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    const domain = domainForPath(request.path);

    if (WRITE_METHODS.has(request.method)) {
      const domains = this.invalidatedBy(context, domain);
      // Awaited before the response goes out, so a client that re-fetches
      // straight after a write never reads the entry the write made stale.
      return next.handle().pipe(
        concatMap(async (value) => {
          await this.cache.invalidate(domains);
          return value;
        }),
      );
    }

    if (request.method !== 'GET' || !domain) return next.handle();

    const noCache = this.reflector.getAllAndOverride<boolean>(NO_CACHE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (noCache) return next.handle();

    const version = await this.cache.version(domain);
    if (version === null) return next.handle();

    const key = this.cache.key(domain, version, scopeOf(request.user), normalisedUrl(request.originalUrl));
    const hit = await this.cache.read(key);
    if (hit) {
      response.setHeader('X-Cache', 'HIT');
      return of(hit.value);
    }

    response.setHeader('X-Cache', 'MISS');
    return next.handle().pipe(
      tap((value) => {
        void this.cache.write(key, value, DOMAIN_TTL_SECONDS[domain]);
      }),
    );
  }

  private invalidatedBy(context: ExecutionContext, domain: CacheDomain | null): readonly CacheDomain[] {
    const explicit = this.reflector.getAllAndOverride<CacheDomain[] | undefined>(INVALIDATES_CACHE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (explicit) return explicit;
    // An unmapped route could have touched anything.
    return domain ? INVALIDATES[domain] : CACHE_DOMAINS;
  }
}

/** Everything in the token that can change what a handler returns. */
function scopeOf(user: Jwtpayload | undefined): string {
  if (!user) return 'public';
  return JSON.stringify([
    user.sub,
    user.platformRole,
    user.orgId,
    user.orgType,
    user.orgRole,
    user.enterpriseRole,
    user.siteId,
    user.siteRole,
  ]);
}

/** `?b=2&a=1` and `?a=1&b=2` are the same request. */
function normalisedUrl(originalUrl: string): string {
  const url = new URL(originalUrl, 'http://cache.local');
  url.searchParams.sort();
  return `${url.pathname}${url.search}`;
}
