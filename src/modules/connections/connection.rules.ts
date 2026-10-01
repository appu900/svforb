import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  ConnectionDayOutcome,
  ConnectionStatus,
  ListingReleaseReason,
  ListingStatus,
} from '@prisma/client';

/**
 * The decisions the Connections feature turns on, as pure functions.
 *
 * Kept out of the service so the rules that matter — who may see an exclusive
 * listing, when it falls back to the network, whether a transition is legal —
 * can be tested without a database, and so every call site shares one answer
 * rather than re-deriving it.
 */

export const CONNECTION_ERROR = {
  NOT_EXCLUSIVE_HOLDER: 'NOT_EXCLUSIVE_HOLDER',
  CONNECTION_EXISTS: 'CONNECTION_EXISTS',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  SITE_TIMEZONE_MISSING: 'SITE_TIMEZONE_MISSING',
  NOT_A_CHARITY: 'NOT_A_CHARITY',
  SELF_CONNECTION: 'SELF_CONNECTION',
} as const;

/** Statuses a Connection can still move out of. */
export const TERMINAL_STATUSES: readonly ConnectionStatus[] = [
  ConnectionStatus.DECLINED,
  ConnectionStatus.EXPIRED,
  ConnectionStatus.ENDED,
];

/** Statuses that still count as a live Connection (invite, pause, collect). */
export const LIVE_STATUSES: readonly ConnectionStatus[] = [
  ConnectionStatus.PENDING,
  ConnectionStatus.ACTIVE,
  ConnectionStatus.PAUSED,
];

const ALLOWED_TRANSITIONS: Record<ConnectionStatus, readonly ConnectionStatus[]> = {
  [ConnectionStatus.PENDING]: [
    ConnectionStatus.ACTIVE,
    ConnectionStatus.DECLINED,
    ConnectionStatus.EXPIRED,
    ConnectionStatus.ENDED,
  ],
  [ConnectionStatus.ACTIVE]: [ConnectionStatus.PAUSED, ConnectionStatus.ENDED],
  [ConnectionStatus.PAUSED]: [ConnectionStatus.ACTIVE, ConnectionStatus.ENDED],
  // Terminal — a new invitation starts a new Connection rather than reviving one,
  // so the history of what was agreed stays intact.
  [ConnectionStatus.DECLINED]: [],
  [ConnectionStatus.EXPIRED]: [],
  [ConnectionStatus.ENDED]: [],
};

export function canTransition(from: ConnectionStatus, to: ConnectionStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ConnectionStatus, to: ConnectionStatus): void {
  if (!canTransition(from, to)) {
    throw new ConflictException({
      error: CONNECTION_ERROR.INVALID_TRANSITION,
      message: `A ${from.toLowerCase()} connection cannot become ${to.toLowerCase()}.`,
      from,
      to,
    });
  }
}

/** Only an ACTIVE Connection produces listings. */
export function isCollecting(status: ConnectionStatus): boolean {
  return status === ConnectionStatus.ACTIVE;
}

// ─── Listing exclusivity ─────────────────────────────────────────────────────

export interface ExclusivityView {
  exclusiveToOrgId: number | null;
  releasedAt: Date | null;
}

/**
 * Whether a listing is still reserved for its preferred charity.
 *
 * `releasedAt` is the switch, not the clock: once released a listing is public
 * for good, and until then it is private regardless of how long it has sat.
 * Time-based expiry is the cut-off sweep's job, and it releases explicitly —
 * so a sweep that fails to run can never silently make a listing public.
 */
export function isExclusive(listing: ExclusivityView): boolean {
  return listing.exclusiveToOrgId !== null && listing.releasedAt === null;
}

/** Whether this organisation may see and claim the listing. */
export function canAccessListing(
  listing: ExclusivityView,
  viewerOrgId: number | null | undefined,
): boolean {
  if (!isExclusive(listing)) return true;
  return viewerOrgId != null && viewerOrgId === listing.exclusiveToOrgId;
}

export function assertCanClaim(
  listing: ExclusivityView,
  viewerOrgId: number | null | undefined,
): void {
  if (canAccessListing(listing, viewerOrgId)) return;
  throw new ConflictException({
    error: CONNECTION_ERROR.NOT_EXCLUSIVE_HOLDER,
    message:
      'This collection is reserved for the site’s preferred charity and is not open to the network yet.',
  });
}

/**
 * The Prisma `where` fragment that hides other charities' exclusive listings.
 *
 * Every discovery path composes this, so exclusivity is expressed once. A
 * viewer with no organisation sees only public listings.
 */
export function visibilityWhere(viewerOrgId: number | null | undefined) {
  const publicOnly = [{ exclusiveToOrgId: null }, { releasedAt: { not: null } }];
  return viewerOrgId == null
    ? { OR: publicOnly }
    : { OR: [...publicOnly, { exclusiveToOrgId: viewerOrgId }] };
}

/** The same rule as raw SQL, for the PostGIS proximity path. */
export function visibilitySql(alias: string, viewerOrgId: number | null | undefined): string {
  const base = `("${alias}"."exclusiveToOrgId" IS NULL OR "${alias}"."releasedAt" IS NOT NULL`;
  return viewerOrgId == null
    ? `${base})`
    : `${base} OR "${alias}"."exclusiveToOrgId" = ${Number(viewerOrgId)})`;
}

// ─── Fallback ────────────────────────────────────────────────────────────────

export type ReleaseTrigger =
  | 'CHARITY_DECLINED'
  | 'BUSINESS_RELEASED'
  | 'AUTO_RELEASED'
  | 'PARTIAL_REMAINDER';

export function releaseReasonFor(trigger: ReleaseTrigger): ListingReleaseReason {
  return ListingReleaseReason[trigger];
}

/**
 * Charity must confirm 1.5 hours before pickup. If they had that window and
 * stay silent, release to nearby. A listing created after that deadline
 * (late surplus) stays reserved until the pickup window ends.
 */
export function shouldAutoRelease(
  day: {
    outcome: ConnectionDayOutcome;
    cutoffAt: Date;
    windowEndAt: Date;
    publishedAt?: Date | null;
  },
  now: Date,
): boolean {
  if (day.outcome !== ConnectionDayOutcome.PUBLISHED) return false;
  if (now >= day.windowEndAt) return true;
  if (now < day.cutoffAt) return false;
  if (day.publishedAt && day.publishedAt.getTime() >= day.cutoffAt.getTime()) {
    return false;
  }
  return true;
}

/**
 * Remaining food can still go to the network. A claimed listing is reserved
 * for the charity — do not release it, and do not treat the day as collected.
 */
export function listingCanBeReleased(status: ListingStatus | null | undefined): boolean {
  return status === ListingStatus.ACTIVE || status === ListingStatus.PARTIAL;
}

export function listingIsAwaitingCollection(
  status: ListingStatus | null | undefined,
): boolean {
  return status === ListingStatus.CLAIMED;
}

/**
 * Close the connection day as COLLECTED only when the listing is fully
 * reserved. A PARTIAL collect must leave the day PUBLISHED so leftover
 * food can still be released to the network.
 */
export function canMarkConnectionDayCollected(
  status: ListingStatus | null | undefined,
): boolean {
  return status === ListingStatus.CLAIMED;
}

export type PublishedListingSweepAction =
  | 'try_release'
  | 'await_collection'
  | 'close_missed';

export function publishedListingSweepAction(
  status: ListingStatus | null | undefined,
): PublishedListingSweepAction {
  if (listingCanBeReleased(status)) return 'try_release';
  if (listingIsAwaitingCollection(status)) return 'await_collection';
  return 'close_missed';
}

/**
 * Only when the listing itself is gone (expired, cancelled, or deleted).
 * CLAIMED is not closed here — that is still in progress until pickup.
 */
export function dayOutcomeWhenListingClosed(
  status: ListingStatus | null | undefined,
): ConnectionDayOutcome | null {
  return publishedListingSweepAction(status) === 'close_missed'
    ? ConnectionDayOutcome.MISSED
    : null;
}

/** Whether the business should be chased about an unconfirmed collection. */
export function shouldEscalateToBusiness(
  day: {
    outcome: ConnectionDayOutcome;
    cutoffAt: Date;
    windowStartAt: Date;
    publishedAt?: Date | null;
  },
  now: Date,
): boolean {
  if (day.outcome !== ConnectionDayOutcome.PUBLISHED) return false;
  if (now < day.cutoffAt || now >= day.windowStartAt) return false;
  if (day.publishedAt && day.publishedAt.getTime() >= day.cutoffAt.getTime()) {
    return false;
  }
  return true;
}

// ─── Reliability ─────────────────────────────────────────────────────────────

export interface ReliabilityCounts {
  collected: number;
  released: number;
  missed: number;
  noSurplus: number;
  noResponse?: number;
}

export interface Reliability {
  /** Days the charity was actually offered food. */
  offered: number;
  collected: number;
  /** Declined or released to the network. */
  declined: number;
  /** Offered and never answered. */
  missed: number;
  /** collected / offered, 0–100, or null when nothing has been offered yet. */
  percent: number | null;
}

/**
 * Reliability is measured against days the charity was actually offered food.
 *
 * Days the business had no surplus, or never answered, are excluded — a kitchen
 * with nothing left is not the charity failing to turn up.
 */
export function reliabilityFrom(counts: ReliabilityCounts): Reliability {
  const offered = counts.collected + counts.released + counts.missed;
  return {
    offered,
    collected: counts.collected,
    declined: counts.released,
    missed: counts.missed,
    percent: offered === 0 ? null : Math.round((counts.collected / offered) * 1000) / 10,
  };
}

export function assertDistinctSites(donorSiteId: number, receiverSiteId: number): void {
  if (donorSiteId === receiverSiteId) {
    throw new BadRequestException({
      error: CONNECTION_ERROR.SELF_CONNECTION,
      message: 'A site cannot be connected to itself.',
    });
  }
}
