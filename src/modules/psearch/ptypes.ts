// proximity.types.ts

export interface NearbyCharity {
  orgId:       number;
  orgName:     string;
  orgType:     string;
  logoUrl:     string | null;
  region:      string;
  ratingAvg:   number;
  ratingCount: number;
  latitude:    number;
  longitude:   number;
  siteId:      number | null;   // ← ADD
  siteName:    string | null;   // ← ADD
  distanceKm:  number;
}

export interface NearbyListing {
  listingId: number;
  orgId: number;
  orgName: string;
  siteId: number;
  listingType: string;
  foodItems: unknown;
  totalQtyKg: number;
  remainingQtyKg: number;
  pickupAddress: string;
  pickupFromTime: Date | null;
  pickupByTime: Date | null;
  needsRefrigeration: boolean;
  needsReheating: boolean;
  allergens: string[];
  photoUrls: string[];
  status: string;
  bestBefore: Date;
  distanceKm: number;
}