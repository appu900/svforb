import { FoodSource } from '@prisma/client';

/**
 * The food taxonomy, served to the app so both sides agree on the keys.
 *
 * Labels may change — the client is still settling wording — so the app binds
 * to `key`, never to `label`. Bump `TAXONOMY_VERSION` whenever a key is added
 * or removed, so a stale app can tell.
 *
 * Rows follow the client's delivery specification §5 (Food taxonomy and entry
 * rules). Only Overproduction may be marked fit for people; every other source
 * is non-edible by default and the server enforces that.
 */
export const TAXONOMY_VERSION = '2026-11-17.1';

/** Nothing sensible weighs more than this in one line; a typo usually does. */
export const MAX_KG_PER_LINE = 500;
export const QTY_DECIMALS = 2;

export interface TaxonomySubtype {
  key: string;
  label: string;
  /** What this becomes on a listing, which is charity-facing wording. */
  listingName: string;
  iconKey: string;
}

export interface TaxonomyEntry {
  source: FoodSource;
  key: string;
  label: string;
  imageKey: string;
  listingName: string;
  listingIconKey: string;
  /** False means the server forces `fitForHumans` to false on these lines. */
  fitAllowed: boolean;
  subtypes?: TaxonomySubtype[];
}

const sub = (key: string, label: string, listingName: string, iconKey: string): TaxonomySubtype =>
  ({ key, label, listingName, iconKey });

export const TAXONOMY: readonly TaxonomyEntry[] = [
  // ─── Overproduction — the only source that can be fit for people ──────────
  {
    source: FoodSource.OVERPRODUCTION,
    key: 'meat_poultry',
    label: 'Meat & Poultry',
    imageKey: 'meat_poultry',
    listingName: 'Meat & poultry',
    listingIconKey: 'meat',
    fitAllowed: true,
    subtypes: [
      sub('chicken', 'Chicken', 'Chicken', 'chicken'),
      sub('beef', 'Beef', 'Beef', 'beef'),
      sub('lamb', 'Lamb', 'Lamb', 'lamb'),
      sub('pork', 'Pork', 'Pork', 'pork'),
      sub('other', 'Other', 'Meat & poultry', 'meat'),
    ],
  },
  {
    source: FoodSource.OVERPRODUCTION,
    key: 'seafood',
    label: 'Seafood',
    imageKey: 'seafood',
    listingName: 'Seafood',
    listingIconKey: 'fish',
    fitAllowed: true,
    subtypes: [
      sub('fish', 'Fish', 'Fish', 'fish'),
      sub('shellfish', 'Shellfish', 'Shellfish', 'shellfish'),
      sub('other', 'Other', 'Seafood', 'fish'),
    ],
  },
  {
    source: FoodSource.OVERPRODUCTION,
    key: 'fruit_veg',
    label: 'Fruit & vegetables',
    imageKey: 'fruit_veg',
    listingName: 'Fruit & vegetables',
    listingIconKey: 'produce',
    fitAllowed: true,
  },
  {
    source: FoodSource.OVERPRODUCTION,
    key: 'dairy',
    label: 'Dairy',
    imageKey: 'dairy',
    listingName: 'Dairy',
    listingIconKey: 'dairy',
    fitAllowed: true,
  },
  {
    source: FoodSource.OVERPRODUCTION,
    key: 'bread_bakery',
    label: 'Bread & baked goods',
    imageKey: 'bread_bakery',
    listingName: 'Bread & baked goods',
    listingIconKey: 'bakery',
    fitAllowed: true,
  },
  {
    source: FoodSource.OVERPRODUCTION,
    key: 'prepared_meals',
    label: 'Prepared meals',
    imageKey: 'prepared_meals',
    listingName: 'Prepared meals',
    listingIconKey: 'meal',
    fitAllowed: true,
  },
  {
    source: FoodSource.OVERPRODUCTION,
    key: 'other',
    label: 'Other',
    imageKey: 'other',
    listingName: 'Surplus food',
    listingIconKey: 'other',
    fitAllowed: true,
  },

  // ─── Spoilage — non-edible by default ─────────────────────────────────────
  {
    source: FoodSource.SPOILAGE,
    key: 'fruit_veg',
    label: 'Fruit & veg',
    imageKey: 'fruit_veg',
    listingName: 'Fruit & vegetables',
    listingIconKey: 'produce',
    fitAllowed: false,
  },
  {
    source: FoodSource.SPOILAGE,
    key: 'dairy',
    label: 'Dairy',
    imageKey: 'dairy',
    listingName: 'Dairy',
    listingIconKey: 'dairy',
    fitAllowed: false,
  },
  {
    source: FoodSource.SPOILAGE,
    key: 'meat_poultry',
    label: 'Meat & Poultry',
    imageKey: 'meat_poultry',
    listingName: 'Meat & poultry',
    listingIconKey: 'meat',
    fitAllowed: false,
  },
  {
    source: FoodSource.SPOILAGE,
    key: 'seafood',
    label: 'Seafood',
    imageKey: 'seafood',
    listingName: 'Seafood',
    listingIconKey: 'fish',
    fitAllowed: false,
  },
  {
    source: FoodSource.SPOILAGE,
    key: 'bread_bakery',
    label: 'Bread & baked goods',
    imageKey: 'bread_bakery',
    listingName: 'Bread & baked goods',
    listingIconKey: 'bakery',
    fitAllowed: false,
  },

  // ─── Preparation — non-edible by default ──────────────────────────────────
  {
    source: FoodSource.PREPARATION,
    key: 'peels_trimmings',
    label: 'Peels & trimmings',
    imageKey: 'peels_trimmings',
    listingName: 'Peels & trimmings',
    listingIconKey: 'produce',
    fitAllowed: false,
  },
  {
    source: FoodSource.PREPARATION,
    key: 'meat_offcuts',
    label: 'Meat offcuts',
    imageKey: 'meat_offcuts',
    listingName: 'Meat offcuts',
    listingIconKey: 'meat',
    fitAllowed: false,
  },
  {
    source: FoodSource.PREPARATION,
    key: 'bread_bakery',
    label: 'Bread & baked goods',
    imageKey: 'bread_bakery',
    listingName: 'Bread & baked goods',
    listingIconKey: 'bakery',
    fitAllowed: false,
  },
  {
    source: FoodSource.PREPARATION,
    key: 'shells',
    label: 'Shells',
    imageKey: 'shells',
    listingName: 'Shells',
    listingIconKey: 'shellfish',
    fitAllowed: false,
  },
  {
    source: FoodSource.PREPARATION,
    key: 'coffee_grounds',
    label: 'Coffee grounds',
    imageKey: 'coffee_grounds',
    listingName: 'Coffee grounds',
    listingIconKey: 'coffee',
    fitAllowed: false,
  },
  {
    source: FoodSource.PREPARATION,
    key: 'preparation_mistake',
    label: 'Preparation mistake',
    imageKey: 'preparation_mistake',
    listingName: 'Preparation waste',
    listingIconKey: 'other',
    fitAllowed: false,
  },

  // ─── Plate scraps — one aggregate line, never fit ─────────────────────────
  {
    source: FoodSource.PLATE_SCRAPS,
    key: 'plate_scraps',
    label: 'Plate scraps',
    imageKey: 'plate_scraps',
    listingName: 'Plate scraps',
    listingIconKey: 'other',
    fitAllowed: false,
  },
] as const;

/** `source:category` → entry, for validating what the app sends. */
const BY_KEY = new Map<string, TaxonomyEntry>(
  TAXONOMY.map((entry) => [`${entry.source}:${entry.key}`, entry]),
);

export function taxonomyEntry(source: FoodSource, category: string): TaxonomyEntry | undefined {
  return BY_KEY.get(`${source}:${category}`);
}

/** Whether a subtype is valid for a category — and categories with none take none. */
export function isValidSubtype(entry: TaxonomyEntry, subtype?: string | null): boolean {
  if (!subtype) return true;
  return Boolean(entry.subtypes?.some((s) => s.key === subtype));
}

/**
 * Only Overproduction can be fit for people. Spoilage, preparation waste and
 * plate scraps are never offered to a charity, whatever the client sends.
 */
export function resolveFitForHumans(
  source: FoodSource,
  entry: TaxonomyEntry,
  requested?: boolean,
): boolean {
  if (!entry.fitAllowed || source !== FoodSource.OVERPRODUCTION) return false;
  return requested === true;
}

export const TAXONOMY_PAYLOAD = {
  taxonomyVersion: TAXONOMY_VERSION,
  limits: { maxKgPerLine: MAX_KG_PER_LINE, decimals: QTY_DECIMALS },
  entries: TAXONOMY,
};
