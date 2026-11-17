import { ListingStatus } from '@prisma/client';
import {
  LINE_STATUS, bucketTotal, deriveLineStatus, notRecoveredBuckets, type LineOutcome,
} from './mfc-outcomes';

const out = (o: Partial<LineOutcome> & { qtyKg: number }): LineOutcome => ({
  listedKg: 0, activeListedKg: 0, claimedKg: 0, collectedKg: 0, listingStatuses: [], ...o,
});

describe('deriveLineStatus', () => {
  it('never listed', () => {
    expect(deriveLineStatus(out({ qtyKg: 5 }))).toBe(LINE_STATUS.NOT_LISTED);
  });

  it('listed and waiting', () => {
    expect(deriveLineStatus(out({
      qtyKg: 5, listedKg: 5, activeListedKg: 5, listingStatuses: [ListingStatus.ACTIVE],
    }))).toBe(LINE_STATUS.LISTED);
  });

  it('claimed but not collected', () => {
    expect(deriveLineStatus(out({
      qtyKg: 5, listedKg: 5, activeListedKg: 5, claimedKg: 5,
      listingStatuses: [ListingStatus.CLAIMED],
    }))).toBe(LINE_STATUS.CLAIMED);
  });

  // UAT-08: publish with no collection is 0 recovered; a partial collection counts.
  it('partially collected', () => {
    expect(deriveLineStatus(out({
      qtyKg: 10, listedKg: 10, claimedKg: 10, collectedKg: 4,
      listingStatuses: [ListingStatus.CLAIMED],
    }))).toBe(LINE_STATUS.PARTIALLY_COLLECTED);
  });

  it('fully collected', () => {
    expect(deriveLineStatus(out({
      qtyKg: 4, listedKg: 4, claimedKg: 4, collectedKg: 4,
      listingStatuses: [ListingStatus.CLAIMED],
    }))).toBe(LINE_STATUS.COLLECTED);
  });

  it('expired unclaimed', () => {
    expect(deriveLineStatus(out({
      qtyKg: 5, listedKg: 5, listingStatuses: [ListingStatus.EXPIRED],
    }))).toBe(LINE_STATUS.EXPIRED);
  });

  it('cancelled', () => {
    expect(deriveLineStatus(out({
      qtyKg: 5, listedKg: 5, listingStatuses: [ListingStatus.CANCELLED],
    }))).toBe(LINE_STATUS.CANCELLED);
  });

  // Once the charity has it, the listing's later fate is history.
  it('collected beats a later expiry', () => {
    expect(deriveLineStatus(out({
      qtyKg: 4, listedKg: 4, claimedKg: 4, collectedKg: 4,
      listingStatuses: [ListingStatus.EXPIRED],
    }))).toBe(LINE_STATUS.COLLECTED);
  });
});

describe('notRecoveredBuckets', () => {
  const sums = (lines: LineOutcome[]) => {
    const recorded = lines.reduce((s, l) => s + l.qtyKg, 0);
    const collected = lines.reduce((s, l) => s + l.collectedKg, 0);
    return Number((recorded - collected).toFixed(2));
  };

  it('food never listed lands in notListed', () => {
    const lines = [out({ qtyKg: 5 })];
    expect(notRecoveredBuckets(lines).notListed).toBe(5);
    expect(bucketTotal(notRecoveredBuckets(lines))).toBe(sums(lines));
  });

  it('listed but unclaimed', () => {
    const lines = [out({ qtyKg: 5, listedKg: 5, activeListedKg: 5,
      listingStatuses: [ListingStatus.ACTIVE] })];
    expect(notRecoveredBuckets(lines).listedNotClaimed).toBe(5);
    expect(bucketTotal(notRecoveredBuckets(lines))).toBe(sums(lines));
  });

  it('expired and cancelled land in their own buckets', () => {
    const lines = [
      out({ qtyKg: 5, listedKg: 5, listingStatuses: [ListingStatus.EXPIRED] }),
      out({ qtyKg: 3, listedKg: 3, listingStatuses: [ListingStatus.CANCELLED] }),
    ];
    const b = notRecoveredBuckets(lines);
    expect(b.expired).toBe(5);
    expect(b.cancelled).toBe(3);
    expect(bucketTotal(b)).toBe(sums(lines));
  });

  it('claimed but not collected is its own bucket', () => {
    const lines = [out({ qtyKg: 6, listedKg: 6, activeListedKg: 6, claimedKg: 6,
      listingStatuses: [ListingStatus.CLAIMED] })];
    expect(notRecoveredBuckets(lines).claimedNotCollected).toBe(6);
    expect(bucketTotal(notRecoveredBuckets(lines))).toBe(sums(lines));
  });

  it('a fully collected line contributes nothing', () => {
    const lines = [out({ qtyKg: 4, listedKg: 4, claimedKg: 4, collectedKg: 4 })];
    expect(bucketTotal(notRecoveredBuckets(lines))).toBe(0);
  });

  // The invariant the spec asks for a test on.
  it('buckets always sum to recorded minus collected', () => {
    const lines = [
      out({ qtyKg: 5 }),
      out({ qtyKg: 4, listedKg: 4, activeListedKg: 4, listingStatuses: [ListingStatus.ACTIVE] }),
      out({ qtyKg: 3, listedKg: 3, listingStatuses: [ListingStatus.EXPIRED] }),
      out({ qtyKg: 2, listedKg: 2, listingStatuses: [ListingStatus.CANCELLED] }),
      out({ qtyKg: 6, listedKg: 6, activeListedKg: 6, claimedKg: 6, collectedKg: 2,
            listingStatuses: [ListingStatus.CLAIMED] }),
      out({ qtyKg: 8, listedKg: 8, claimedKg: 8, collectedKg: 8 }),
    ];
    expect(bucketTotal(notRecoveredBuckets(lines))).toBe(sums(lines));
  });

  it('a partly listed line splits across buckets and still balances', () => {
    // 10 kg recorded, only 6 listed and expired: 4 never listed, 6 expired.
    const lines = [out({ qtyKg: 10, listedKg: 6, listingStatuses: [ListingStatus.EXPIRED] })];
    const b = notRecoveredBuckets(lines);
    expect(b.notListed).toBe(4);
    expect(b.expired).toBe(6);
    expect(bucketTotal(b)).toBe(10);
  });

  it('an empty record is all zeros', () => {
    expect(bucketTotal(notRecoveredBuckets([]))).toBe(0);
  });
});
