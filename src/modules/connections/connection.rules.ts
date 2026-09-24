import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  ConnectionDayOutcome,
  ConnectionStatus,
  ListingReleaseReason,
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

/** Statuses that block a second Connection between the same two sites. */
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
 * Whether a day that nobody has answered should now be released automatically.
 *
 * The business is prompted at the cut-off; this is the backstop at the window
 * start, so food never rots because two people ignored a notification.
 */
export function shouldAutoRelease(
  day: { outcome: ConnectionDayOutcome; windowStartAt: Date },
  now: Date,
): boolean {
  return day.outcome === ConnectionDayOutcome.PUBLISHED && now >= day.windowStartAt;
}

/** Whether the business should be chased about an unconfirmed collection. */
export function shouldEscalateToBusiness(
  day: { outcome: ConnectionDayOutcome; cutoffAt: Date; windowStartAt: Date },
  now: Date,
): boolean {
  return (
    day.outcome === ConnectionDayOutcome.PUBLISHED &&
    now >= day.cutoffAt &&
    now < day.windowStartAt
  );
}

// ─── Reliability ─────────────────────────────────────────────────────────────

export interface ReliabilityCounts {
  collected: number;
  released: number;
  missed: number;
  noSurplus: number;
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
 * Days the business had no surplus are excluded — a kitchen with nothing left
 * is not the charity failing to turn up, and counting it would punish the
 * charity for someone else's quiet week.
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
