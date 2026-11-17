import { FoodSource } from '@prisma/client';

/**
 * Summing food lines — pure, so the arithmetic the whole feature reports can be
 * tested without a database.
 *
 * Kilograms are stored as Decimal(10,2) and arrive as strings or Prisma
 * Decimals. Adding them as floats drifts (0.1 + 0.2), so everything is summed
 * in whole grams and converted back once at the end.
 */

/** Anything Prisma might hand back for a Decimal column. */
export type KgInput = number | string | { toString(): string };

export interface TotalsLine {
  source: FoodSource;
  category: string;
  qtyKg: KgInput;
  fitForHumans: boolean;
  deletedAt?: Date | null;
}

export interface SourceTotal {
  source: FoodSource;
  recordedKg: number;
  fitKg: number;
  notFitKg: number;
}

export interface CategoryTotal {
  category: string;
  recordedKg: number;
}

export interface RecordTotals {
  recordedKg: number;
  fitKg: number;
  notFitKg: number;
  lineCount: number;
  bySource: SourceTotal[];
  byCategory: CategoryTotal[];
}

const GRAMS = 1000;

/** Decimal(10,2) in, whole grams out — exact for everything we accept. */
export function toGrams(value: KgInput): number {
  const n = typeof value === 'number' ? value : Number(value.toString());
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * GRAMS);
}

export function gramsToKg(grams: number): number {
  return Math.round(grams) / GRAMS;
}

/** Live means not soft-deleted. Deleted lines keep their history but count nowhere. */
export function liveLines<T extends { deletedAt?: Date | null }>(lines: T[]): T[] {
  return lines.filter((l) => !l.deletedAt);
}

export function totalsFor(lines: TotalsLine[]): RecordTotals {
  const live = liveLines(lines);

  let recorded = 0;
  let fit = 0;
  const bySource = new Map<FoodSource, { recorded: number; fit: number }>();
  const byCategory = new Map<string, number>();

  for (const line of live) {
    const grams = toGrams(line.qtyKg);
    recorded += grams;
    if (line.fitForHumans) fit += grams;

    const s = bySource.get(line.source) ?? { recorded: 0, fit: 0 };
    s.recorded += grams;
    if (line.fitForHumans) s.fit += grams;
    bySource.set(line.source, s);

    byCategory.set(line.category, (byCategory.get(line.category) ?? 0) + grams);
  }

  return {
    recordedKg: gramsToKg(recorded),
    fitKg: gramsToKg(fit),
    // Derived, never summed separately, so fit + notFit always equals recorded.
    notFitKg: gramsToKg(recorded - fit),
    lineCount: live.length,
    bySource: [...bySource.entries()].map(([source, t]) => ({
      source,
      recordedKg: gramsToKg(t.recorded),
      fitKg: gramsToKg(t.fit),
      notFitKg: gramsToKg(t.recorded - t.fit),
    })),
    byCategory: [...byCategory.entries()]
      .map(([category, grams]) => ({ category, recordedKg: gramsToKg(grams) }))
      .sort((a, b) => b.recordedKg - a.recordedKg),
  };
}

/**
 * What could be offered, by listing kind.
 *
 * Fit lines go to people; everything else is the non-edible pathway. The two
 * are exclusive and together make up the whole record.
 */
export function eligibleKg(lines: TotalsLine[]): { edibleKg: number; nonEdibleKg: number } {
  const totals = totalsFor(lines);
  return { edibleKg: totals.fitKg, nonEdibleKg: totals.notFitKg };
}

/** Sums kilograms that are already exact, e.g. listed or collected weights. */
export function sumKg(values: KgInput[]): number {
  return gramsToKg(values.reduce<number>((total, v) => total + toGrams(v), 0));
}
