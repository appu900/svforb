import { ListingStatus } from '@prisma/client';

/**
 * What became of recorded food — pure, so the arithmetic every report depends
 * on can be tested without a database.
 */

/** Where one line has got to. The first match in this order wins. */
export const LINE_STATUS = {
  NOT_LISTED: 'NOT_LISTED',
  LISTED: 'LISTED',
  CLAIMED: 'CLAIMED',
  PARTIALLY_COLLECTED: 'PARTIALLY_COLLECTED',
  COLLECTED: 'COLLECTED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
} as const;

export type LineStatus = (typeof LINE_STATUS)[keyof typeof LINE_STATUS];

export interface LineOutcome {
  qtyKg: number;
  listedKg: number;
  /** Held by a listing that is still live — ACTIVE, PARTIAL or CLAIMED. */
  activeListedKg: number;
  claimedKg: number;
  collectedKg: number;
  /** The statuses of every listing this line went onto. */
  listingStatuses: ListingStatus[];
}

const EPSILON = 0.001;

/**
 * Collected wins over everything: once a charity has the food, what happened
 * to the listing afterwards is history, not the outcome.
 */
export function deriveLineStatus(o: LineOutcome): LineStatus {
  if (o.collectedKg >= o.qtyKg - EPSILON && o.collectedKg > 0) return LINE_STATUS.COLLECTED;
  if (o.collectedKg > 0) return LINE_STATUS.PARTIALLY_COLLECTED;
  if (o.claimedKg > 0) return LINE_STATUS.CLAIMED;

  if (o.listedKg <= 0 && o.listingStatuses.length === 0) return LINE_STATUS.NOT_LISTED;

  // Nothing was taken, so the listing's own fate is the line's outcome.
  if (o.activeListedKg > 0) return LINE_STATUS.LISTED;
  if (o.listingStatuses.includes(ListingStatus.EXPIRED)) return LINE_STATUS.EXPIRED;
  if (o.listingStatuses.includes(ListingStatus.CANCELLED)) return LINE_STATUS.CANCELLED;
  return LINE_STATUS.NOT_LISTED;
}

export interface NotRecoveredBuckets {
  notListed: number;
  listedNotClaimed: number;
  expired: number;
  cancelled: number;
  claimedNotCollected: number;
}

const round = (n: number) => Number(n.toFixed(2));

/**
 * Why recorded food was not recovered.
 *
 * The buckets must add up to `recordedKg − collectedKg` exactly — the whole
 * point is that no kilogram goes unexplained. Each line contributes its
 * uncollected remainder to exactly one bucket.
 */
export function notRecoveredBuckets(lines: LineOutcome[]): NotRecoveredBuckets {
  const b: NotRecoveredBuckets = {
    notListed: 0, listedNotClaimed: 0, expired: 0, cancelled: 0, claimedNotCollected: 0,
  };

  for (const line of lines) {
    const remainder = line.qtyKg - line.collectedKg;
    if (remainder <= EPSILON) continue;

    // Claimed but not yet handed over is its own story, whatever the listing says.
    const pending = Math.min(remainder, Math.max(0, line.claimedKg - line.collectedKg));
    b.claimedNotCollected += pending;

    let left = remainder - pending;
    if (left <= EPSILON) continue;

    const neverListed = Math.max(0, line.qtyKg - line.listedKg);
    const unlisted = Math.min(left, neverListed);
    b.notListed += unlisted;
    left -= unlisted;
    if (left <= EPSILON) continue;

    if (line.activeListedKg > 0) {
      b.listedNotClaimed += left;
    } else if (line.listingStatuses.includes(ListingStatus.EXPIRED)) {
      b.expired += left;
    } else if (line.listingStatuses.includes(ListingStatus.CANCELLED)) {
      b.cancelled += left;
    } else {
      b.notListed += left;
    }
  }

  return {
    notListed: round(b.notListed),
    listedNotClaimed: round(b.listedNotClaimed),
    expired: round(b.expired),
    cancelled: round(b.cancelled),
    claimedNotCollected: round(b.claimedNotCollected),
  };
}

export function bucketTotal(b: NotRecoveredBuckets): number {
  return round(
    b.notListed + b.listedNotClaimed + b.expired + b.cancelled + b.claimedNotCollected,
  );
}
