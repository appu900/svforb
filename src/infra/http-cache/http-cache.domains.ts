/**
 * Every cached GET belongs to one domain, and every write invalidates one or
 * more domains. Invalidation is a version bump (see HttpCacheService), so a
 * domain is the unit of "everything in here may now be stale".
 *
 * Domains are deliberately coarse. Over-invalidating costs a cache miss;
 * under-invalidating serves wrong data, so when in doubt a write reaches wider.
 */
export const CACHE_DOMAINS = ['identity', 'structure', 'billing', 'activity'] as const;
export type CacheDomain = (typeof CACHE_DOMAINS)[number];

/**
 * Route prefix (after /api/v1) → domain. The longest matching prefix wins, so
 * `enterprise/reports` is `activity` even though `enterprise` is `structure`.
 * A route with no match is not cached, and a write to it invalidates everything.
 */
const PREFIX_DOMAINS: Record<string, CacheDomain> = {
  // Users, invitations, profiles and org membership.
  'auth': 'identity',
  'admin/app-users': 'identity',
  'enterprise/users': 'identity',
  'enterprise/invites': 'identity',
  'enterprise/roles': 'identity',
  'enterprise/invitations': 'identity',
  'enterprise/profile': 'identity',
  'farmer-consumer': 'identity',
  'charity/users': 'identity',
  'organization': 'identity',

  // Sites, enterprise hierarchy, charity locations and recurring connections.
  'sites': 'structure',
  'admin/sites': 'structure',
  'enterprise': 'structure',
  'admin/enterprise/dashboard': 'activity',
  'admin/enterprise': 'structure',
  'charity/locations': 'structure',
  'charity/connections': 'structure',
  'connections': 'structure',
  'geo': 'structure',
  'proximity': 'structure',

  // Plans, subscriptions, payments and enterprise contracts.
  'billing': 'billing',
  'subscriptions': 'billing',
  'enterprise/admin': 'billing',
  'enterprise/invoices': 'billing',

  // The food marketplace and everything reported from it.
  'food-listings': 'activity',
  'claims': 'activity',
  'drivers': 'activity',
  'search/driver': 'activity',
  'impact': 'activity',
  'enterprise/reports': 'activity',
  'notifications': 'activity',
};

/**
 * What a write in each domain can make stale. Structure feeds the reports and
 * listing addresses; identity and billing both show up in user and org lists.
 */
export const INVALIDATES: Record<CacheDomain, CacheDomain[]> = {
  identity: ['identity', 'structure'],
  structure: ['structure', 'identity', 'activity'],
  billing: ['billing', 'identity'],
  activity: ['activity'],
};

/** Seconds a cached response lives if no write invalidates it first. */
export const DOMAIN_TTL_SECONDS: Record<CacheDomain, number> = {
  identity: 300,
  structure: 300,
  billing: 300,
  // Background jobs expire listings and claims without an HTTP write.
  activity: 60,
};

const PREFIXES = Object.keys(PREFIX_DOMAINS).sort((a, b) => b.length - a.length);

export function domainForPath(path: string): CacheDomain | null {
  const route = path.replace(/^\/+/, '').replace(/^api\/v1\/?/, '');
  const prefix = PREFIXES.find((p) => route === p || route.startsWith(`${p}/`));
  return prefix ? PREFIX_DOMAINS[prefix] : null;
}
