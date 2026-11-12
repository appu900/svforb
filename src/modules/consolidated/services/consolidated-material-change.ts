import { MATERIAL_CATEGORY_DROP_PCT, MATERIAL_QTY_DROP_PCT } from '../consolidated.constants';
import { formatWindowRange } from '../../connections/connection.schedule';

/**
 * Decides whether a change after the charity has claimed is "material" (R11).
 *
 * Material means the charity has to acknowledge it before anything else can
 * happen, so this is deliberately pure: the same two snapshots always give the
 * same answer, and it can be unit tested without a database or a request.
 *
 * The summary is read by the charity, so it never names a contributing site.
 */

export interface ConsolidatedSnapshotItem {
  /** Stable identity across the diff — the source food item id. */
  key: string;
  name: string;
  category: string | null;
  qtyKg: number;
}

export interface ConsolidatedSnapshot {
  pointName: string;
  pointAddress: string;
  pickupStartAt: Date;
  pickupEndAt: Date;
  storage: {
    refrigeration: boolean;
    ambient: boolean;
    freezer: boolean;
    hot: boolean;
    reheating: boolean;
  };
  allergens: string[];
  items: ConsolidatedSnapshotItem[];
}

export const MATERIAL_REASON = {
  LOCATION: 'LOCATION',
  PICKUP_TIME: 'PICKUP_TIME',
  HANDLING: 'HANDLING',
  QTY_DROP_GT_20: 'QTY_DROP_GT_20',
  ITEM_REMOVED: 'ITEM_REMOVED',
  CATEGORY_DROP_GT_20: 'CATEGORY_DROP_GT_20',
} as const;

export type MaterialReason = (typeof MATERIAL_REASON)[keyof typeof MATERIAL_REASON];

export interface MaterialDiff {
  isMaterial: boolean;
  reasons: MaterialReason[];
  /** Neutral text shown to the charity. Never contains site names. */
  summary: string;
}

/** Items without a category are still compared, grouped together (A10). */
const UNCATEGORISED = 'Uncategorised';

function total(items: ConsolidatedSnapshotItem[]): number {
  return items.reduce((sum, i) => sum + i.qtyKg, 0);
}

function byCategory(items: ConsolidatedSnapshotItem[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of items) {
    const key = item.category?.trim() || UNCATEGORISED;
    out.set(key, (out.get(key) ?? 0) + item.qtyKg);
  }
  return out;
}

function sameStorage(a: ConsolidatedSnapshot['storage'], b: ConsolidatedSnapshot['storage']) {
  return (
    a.refrigeration === b.refrigeration &&
    a.ambient === b.ambient &&
    a.freezer === b.freezer &&
    a.hot === b.hot &&
    a.reheating === b.reheating
  );
}

function sameAllergens(a: string[], b: string[]) {
  const left = [...new Set(a.map((x) => x.toLowerCase()))].sort();
  const right = [...new Set(b.map((x) => x.toLowerCase()))].sort();
  return left.length === right.length && left.every((v, i) => v === right[i]);
}

/** A drop of more than `pct`. An increase is never material. */
function droppedMoreThan(before: number, after: number, pct: number): boolean {
  if (before <= 0) return false;
  return after < before * (1 - pct / 100);
}

function kg(value: number): string {
  return `${Number(value.toFixed(2))} kg`;
}

function localTimeRange(start: Date, end: Date, timezone: string): string {
  const minutes = (d: Date) => {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, hour12: false, hour: '2-digit', minute: '2-digit',
    }).formatToParts(d);
    const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
    const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
    return (h === 24 ? 0 : h) * 60 + m;
  };
  return formatWindowRange(minutes(start), minutes(end));
}

export function diffMaterial(
  before: ConsolidatedSnapshot,
  after: ConsolidatedSnapshot,
  timezone = 'Australia/Sydney',
): MaterialDiff {
  const reasons: MaterialReason[] = [];
  const notes: string[] = [];

  if (before.pointName !== after.pointName || before.pointAddress !== after.pointAddress) {
    reasons.push(MATERIAL_REASON.LOCATION);
    notes.push(`Collection point changed to ${after.pointName}, ${after.pointAddress}.`);
  }

  if (
    before.pickupStartAt.getTime() !== after.pickupStartAt.getTime() ||
    before.pickupEndAt.getTime() !== after.pickupEndAt.getTime()
  ) {
    reasons.push(MATERIAL_REASON.PICKUP_TIME);
    notes.push(
      `Pickup time changed to ${localTimeRange(after.pickupStartAt, after.pickupEndAt, timezone)}.`,
    );
  }

  if (!sameStorage(before.storage, after.storage) || !sameAllergens(before.allergens, after.allergens)) {
    reasons.push(MATERIAL_REASON.HANDLING);
    notes.push('Food handling or allergen information changed.');
  }

  // An item disappearing matters however small it was — the charity may have
  // claimed for that item alone.
  const afterKeys = new Set(after.items.map((i) => i.key));
  const removed = before.items.filter((i) => !afterKeys.has(i.key));
  if (removed.length > 0) {
    reasons.push(MATERIAL_REASON.ITEM_REMOVED);
    notes.push(removed.length === 1 ? 'One item is no longer available.' : `${removed.length} items are no longer available.`);
  }

  const beforeTotal = total(before.items);
  const afterTotal = total(after.items);
  if (droppedMoreThan(beforeTotal, afterTotal, MATERIAL_QTY_DROP_PCT)) {
    reasons.push(MATERIAL_REASON.QTY_DROP_GT_20);
    notes.push(`Total reduced from ${kg(beforeTotal)} to ${kg(afterTotal)}.`);
  }

  const beforeCats = byCategory(before.items);
  const afterCats = byCategory(after.items);
  const droppedCategories = [...beforeCats.entries()].filter(([name, qty]) =>
    droppedMoreThan(qty, afterCats.get(name) ?? 0, MATERIAL_CATEGORY_DROP_PCT),
  );
  if (droppedCategories.length > 0) {
    reasons.push(MATERIAL_REASON.CATEGORY_DROP_GT_20);
    notes.push(
      droppedCategories.length === 1
        ? `${droppedCategories[0][0]} was reduced.`
        : `${droppedCategories.length} food categories were reduced.`,
    );
  }

  return {
    isMaterial: reasons.length > 0,
    reasons,
    summary: notes.join(' '),
  };
}
