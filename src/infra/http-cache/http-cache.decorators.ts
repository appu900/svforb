import { SetMetadata } from '@nestjs/common';
import { CacheDomain } from './http-cache.domains';

export const NO_CACHE = 'httpCache:noCache';
export const INVALIDATES_CACHE = 'httpCache:invalidates';

/**
 * Exempts a GET route (or a whole controller) from the response cache.
 *
 * Use for live data — driver locations, unread notifications, queue stats — and
 * for any GET that has side effects.
 */
export const NoCache = () => SetMetadata(NO_CACHE, true);

/**
 * Overrides which domains a write invalidates. By default a write invalidates
 * its own domain and everything that domain feeds (see INVALIDATES).
 *
 * With no arguments the write invalidates nothing — for high-frequency writes
 * that no cached GET reads, like driver location pings or logging in.
 */
export const InvalidatesCache = (...domains: CacheDomain[]) =>
  SetMetadata(INVALIDATES_CACHE, domains);
