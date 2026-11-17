import { FoodSource } from '@prisma/client';
import {
  MAX_KG_PER_LINE, QTY_DECIMALS, TAXONOMY, TAXONOMY_PAYLOAD, TAXONOMY_VERSION,
  isValidSubtype, resolveFitForHumans, taxonomyEntry,
} from './mfc.constants';

describe('taxonomy shape', () => {
  it('every entry carries what the app needs to render and to list', () => {
    for (const entry of TAXONOMY) {
      expect(entry.key).toMatch(/^[a-z0-9_]+$/);
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.imageKey.length).toBeGreaterThan(0);
      // listingName is charity-facing wording, so it must never be blank.
      expect(entry.listingName.length).toBeGreaterThan(0);
      expect(entry.listingIconKey.length).toBeGreaterThan(0);
    }
  });

  it('every subtype carries a listingName and an icon', () => {
    for (const entry of TAXONOMY) {
      for (const sub of entry.subtypes ?? []) {
        expect(sub.key).toMatch(/^[a-z0-9_]+$/);
        expect(sub.label.length).toBeGreaterThan(0);
        expect(sub.listingName.length).toBeGreaterThan(0);
        expect(sub.iconKey.length).toBeGreaterThan(0);
      }
    }
  });

  it('keys are unique within a source', () => {
    const seen = new Set<string>();
    for (const entry of TAXONOMY) {
      const key = `${entry.source}:${entry.key}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('subtype keys are unique within an entry', () => {
    for (const entry of TAXONOMY) {
      const keys = (entry.subtypes ?? []).map((s) => s.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  // The client's spec: only Overproduction can be fit for people.
  it('only Overproduction entries allow fit for humans', () => {
    for (const entry of TAXONOMY) {
      if (entry.source !== FoodSource.OVERPRODUCTION) {
        expect(entry.fitAllowed).toBe(false);
      }
    }
  });

  it('covers all four sources', () => {
    const sources = new Set(TAXONOMY.map((e) => e.source));
    expect(sources).toEqual(new Set(Object.values(FoodSource)));
  });

  // Plate scraps is a single aggregate input, with no food subtypes.
  it('plate scraps is one entry with no subtypes', () => {
    const scraps = TAXONOMY.filter((e) => e.source === FoodSource.PLATE_SCRAPS);
    expect(scraps).toHaveLength(1);
    expect(scraps[0].subtypes).toBeUndefined();
  });

  it('meat and seafood carry the subtypes the client listed', () => {
    const meat = taxonomyEntry(FoodSource.OVERPRODUCTION, 'meat_poultry')!;
    expect(meat.subtypes?.map((s) => s.key))
      .toEqual(['chicken', 'beef', 'lamb', 'pork', 'other']);

    const seafood = taxonomyEntry(FoodSource.OVERPRODUCTION, 'seafood')!;
    expect(seafood.subtypes?.map((s) => s.key)).toEqual(['fish', 'shellfish', 'other']);
  });

  it('serves limits and a version alongside the entries', () => {
    expect(TAXONOMY_PAYLOAD.taxonomyVersion).toBe(TAXONOMY_VERSION);
    expect(TAXONOMY_PAYLOAD.limits).toEqual({
      maxKgPerLine: MAX_KG_PER_LINE, decimals: QTY_DECIMALS,
    });
  });
});

describe('taxonomyEntry', () => {
  it('finds a known category for its own source', () => {
    expect(taxonomyEntry(FoodSource.SPOILAGE, 'dairy')?.label).toBe('Dairy');
  });

  it('rejects an unknown category', () => {
    expect(taxonomyEntry(FoodSource.SPOILAGE, 'unicorn')).toBeUndefined();
  });

  // The same key can exist under two sources and mean different things.
  it('does not leak a category across sources', () => {
    expect(taxonomyEntry(FoodSource.PLATE_SCRAPS, 'dairy')).toBeUndefined();
    expect(taxonomyEntry(FoodSource.SPOILAGE, 'peels_trimmings')).toBeUndefined();
  });
});

describe('isValidSubtype', () => {
  const meat = taxonomyEntry(FoodSource.OVERPRODUCTION, 'meat_poultry')!;
  const dairy = taxonomyEntry(FoodSource.SPOILAGE, 'dairy')!;

  it('accepts a listed subtype', () => {
    expect(isValidSubtype(meat, 'chicken')).toBe(true);
  });

  it('rejects an unlisted subtype', () => {
    expect(isValidSubtype(meat, 'ostrich')).toBe(false);
  });

  it('allows no subtype at all', () => {
    expect(isValidSubtype(meat, undefined)).toBe(true);
    expect(isValidSubtype(dairy, null)).toBe(true);
  });

  it('rejects a subtype on a category that has none', () => {
    expect(isValidSubtype(dairy, 'chicken')).toBe(false);
  });
});

describe('resolveFitForHumans', () => {
  const meat = taxonomyEntry(FoodSource.OVERPRODUCTION, 'meat_poultry')!;
  const spoiled = taxonomyEntry(FoodSource.SPOILAGE, 'meat_poultry')!;
  const scraps = taxonomyEntry(FoodSource.PLATE_SCRAPS, 'plate_scraps')!;

  it('honours the tick on Overproduction', () => {
    expect(resolveFitForHumans(FoodSource.OVERPRODUCTION, meat, true)).toBe(true);
    expect(resolveFitForHumans(FoodSource.OVERPRODUCTION, meat, false)).toBe(false);
  });

  it('defaults to not fit when the client says nothing', () => {
    expect(resolveFitForHumans(FoodSource.OVERPRODUCTION, meat, undefined)).toBe(false);
  });

  // The server decides this, never the client — spoiled food is not donatable
  // however the request is crafted.
  it('forces false on Spoilage even when the client claims true', () => {
    expect(resolveFitForHumans(FoodSource.SPOILAGE, spoiled, true)).toBe(false);
  });

  it('forces false on Preparation and Plate Scraps', () => {
    const peels = taxonomyEntry(FoodSource.PREPARATION, 'peels_trimmings')!;
    expect(resolveFitForHumans(FoodSource.PREPARATION, peels, true)).toBe(false);
    expect(resolveFitForHumans(FoodSource.PLATE_SCRAPS, scraps, true)).toBe(false);
  });
});
