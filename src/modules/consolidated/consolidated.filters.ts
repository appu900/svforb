import { Prisma } from '@prisma/client';

/**
 * One home for every "which listings and claims count" rule.
 *
 * These are applied across foodlisting, claims, impact, psearch and the
 * enterprise reporting services. Writing the conditions inline in each file is
 * how reporting totals drift apart, so always import from here.
 */

/** Charity discovery: a site's contribution is never offered on its own. */
export const DISCOVERABLE_LISTING = {
  consolidatedRole: { not: 'CONTRIBUTION' },
} as const;

/** Business listing screens: the master is the collection, not a listing. */
export const BUSINESS_LIST_LISTING = {
  consolidatedRole: { not: 'MASTER' },
} as const;

/** Impact counts the per-site allocations, never the master claim. */
export const IMPACT_CLAIM = {
  claimKind: { not: 'CONSOLIDATED_MASTER' },
} as const;

/** "How many collections happened" counts the master, not its allocations. */
export const OPERATIONAL_CLAIM = {
  claimKind: { not: 'CONSOLIDATED_ALLOCATION' },
} as const;

export const SQL_DISCOVERABLE = Prisma.sql`fl."consolidatedRole" <> 'CONTRIBUTION'`;
export const SQL_IMPACT_CLAIM = Prisma.sql`fc."claimKind" <> 'CONSOLIDATED_MASTER'`;

/**
 * The enterprise reporting queries alias food_claims as `c` and food_listings
 * as `l`. Same rules, different alias — spelled out rather than built from a
 * string, so the alias cannot be mistyped into a silently wrong filter.
 */
export const SQL_IMPACT_CLAIM_C = Prisma.sql`c."claimKind" <> 'CONSOLIDATED_MASTER'`;
export const SQL_OPERATIONAL_CLAIM_C = Prisma.sql`c."claimKind" <> 'CONSOLIDATED_ALLOCATION'`;
export const SQL_BUSINESS_LISTING_L = Prisma.sql`l."consolidatedRole" <> 'MASTER'`;
export const SQL_DISCOVERABLE_L = Prisma.sql`l."consolidatedRole" <> 'CONTRIBUTION'`;
