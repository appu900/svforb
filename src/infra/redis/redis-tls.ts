/** `rediss://` always means TLS. REDIS_TLS=false must not strip that. */
export function redisTlsEnabled(options?: {
  redisUrl?: string;
  tlsFlag?: string;
  host?: string;
}): boolean {
  const redisUrl = options?.redisUrl ?? process.env.REDIS_URL ?? '';
  const tlsFlag = (options?.tlsFlag ?? process.env.REDIS_TLS)?.toLowerCase();
  const host = options?.host ?? process.env.REDIS_HOST ?? '';

  if (redisUrl.startsWith('rediss://')) return true;
  if (tlsFlag === 'true') return true;
  if (tlsFlag === 'false') return false;

  if (host.includes('.cache.amazonaws.com')) return true;
  if (host.includes('.serverless.') && host.includes('amazonaws.com')) {
    return true;
  }

  return false;
}
