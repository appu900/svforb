import { FoodSource } from '@prisma/client';
import { eligibleKg, gramsToKg, sumKg, toGrams, totalsFor, type TotalsLine } from './mfc-totals';

const line = (
  source: FoodSource, category: string, qtyKg: number | string | { toString(): string },
  fitForHumans = false, deletedAt: Date | null = null,
): TotalsLine => ({ source, category, qtyKg, fitForHumans, deletedAt });

describe('totalsFor', () => {
  // UAT-02 from the client's acceptance list.
  it('UAT-02: chicken 5 fit, beef 3 not, fish 2 fit → 10 / 7 / 3', () => {
    const t = totalsFor([
      line(FoodSource.OVERPRODUCTION, 'meat_poultry', 5, true),
      line(FoodSource.OVERPRODUCTION, 'meat_poultry', 3, false),
      line(FoodSource.OVERPRODUCTION, 'seafood', 2, true),
    ]);
    expect(t.recordedKg).toBe(10);
    expect(t.fitKg).toBe(7);
    expect(t.notFitKg).toBe(3);
  });

  // UAT-03 builds on UAT-02.
  it('UAT-03: + preparation 4 + plate scraps 2 → 16 / 7 / 9', () => {
    const t = totalsFor([
      line(FoodSource.OVERPRODUCTION, 'meat_poultry', 5, true),
      line(FoodSource.OVERPRODUCTION, 'meat_poultry', 3, false),
      line(FoodSource.OVERPRODUCTION, 'seafood', 2, true),
      line(FoodSource.PREPARATION, 'peels_trimmings', 4),
      line(FoodSource.PLATE_SCRAPS, 'plate_scraps', 2),
    ]);
    expect(t.recordedKg).toBe(16);
    expect(t.fitKg).toBe(7);
    expect(t.notFitKg).toBe(9);
  });

  it('fit + notFit always equals recorded', () => {
    const t = totalsFor([
      line(FoodSource.OVERPRODUCTION, 'dairy', '1.33', true),
      line(FoodSource.SPOILAGE, 'dairy', '2.67'),
    ]);
    expect(t.fitKg + t.notFitKg).toBe(t.recordedKg);
    expect(t.recordedKg).toBe(4);
  });

  // Floats drift here: 0.1 + 0.2 is 0.30000000000000004.
  it('does not drift on decimals', () => {
    const t = totalsFor([
      line(FoodSource.PREPARATION, 'shells', '0.1'),
      line(FoodSource.PREPARATION, 'shells', '0.2'),
    ]);
    expect(t.recordedKg).toBe(0.3);
  });

  it('accepts Prisma Decimal objects, not only numbers', () => {
    const decimal = { toString: () => '12.50' };
    const t = totalsFor([line(FoodSource.OVERPRODUCTION, 'dairy', decimal, true)]);
    expect(t.recordedKg).toBe(12.5);
  });

  it('ignores soft-deleted lines but keeps the rest', () => {
    const t = totalsFor([
      line(FoodSource.OVERPRODUCTION, 'dairy', 5, true),
      line(FoodSource.OVERPRODUCTION, 'dairy', 3, true, new Date()),
    ]);
    expect(t.recordedKg).toBe(5);
    expect(t.lineCount).toBe(1);
  });

  it('breaks down by source', () => {
    const t = totalsFor([
      line(FoodSource.OVERPRODUCTION, 'meat_poultry', 5, true),
      line(FoodSource.SPOILAGE, 'dairy', 3),
      line(FoodSource.SPOILAGE, 'seafood', 2),
    ]);
    const spoilage = t.bySource.find((s) => s.source === FoodSource.SPOILAGE)!;
    expect(spoilage.recordedKg).toBe(5);
    expect(spoilage.fitKg).toBe(0);
    expect(spoilage.notFitKg).toBe(5);
  });

  it('breaks down by category, largest first', () => {
    const t = totalsFor([
      line(FoodSource.OVERPRODUCTION, 'seafood', 2, true),
      line(FoodSource.OVERPRODUCTION, 'meat_poultry', 8, true),
    ]);
    expect(t.byCategory.map((c) => c.category)).toEqual(['meat_poultry', 'seafood']);
    expect(t.byCategory[0].recordedKg).toBe(8);
  });

  it('an empty record is zeros, not an error', () => {
    const t = totalsFor([]);
    expect(t).toMatchObject({ recordedKg: 0, fitKg: 0, notFitKg: 0, lineCount: 0 });
    expect(t.bySource).toEqual([]);
  });
});

describe('eligibleKg', () => {
  // UAT-06 / UAT-07: 7 kg to people, 9 kg down the non-edible pathway.
  it('splits the record into the two listing kinds', () => {
    const lines = [
      line(FoodSource.OVERPRODUCTION, 'meat_poultry', 5, true),
      line(FoodSource.OVERPRODUCTION, 'meat_poultry', 3, false),
      line(FoodSource.OVERPRODUCTION, 'seafood', 2, true),
      line(FoodSource.PREPARATION, 'peels_trimmings', 4),
      line(FoodSource.PLATE_SCRAPS, 'plate_scraps', 2),
    ];
    expect(eligibleKg(lines)).toEqual({ edibleKg: 7, nonEdibleKg: 9 });
  });

  it('the two kinds together are the whole record', () => {
    const lines = [
      line(FoodSource.OVERPRODUCTION, 'dairy', '3.33', true),
      line(FoodSource.SPOILAGE, 'dairy', '1.67'),
    ];
    const { edibleKg: e, nonEdibleKg: n } = eligibleKg(lines);
    expect(e + n).toBe(totalsFor(lines).recordedKg);
  });
});

describe('gram conversion', () => {
  it('round-trips two decimal places', () => {
    for (const v of ['0.01', '1.99', '500.00', '123.45']) {
      expect(gramsToKg(toGrams(v))).toBe(Number(v));
    }
  });

  it('treats unparseable input as zero rather than NaN', () => {
    expect(toGrams('abc')).toBe(0);
  });

  it('sumKg adds exact weights without drift', () => {
    expect(sumKg(['0.1', '0.2', '0.3'])).toBe(0.6);
  });
});
