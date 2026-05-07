export const PUSH_QUEUE = 'push';

export enum PushJobName {
  NEW_LISTING_NEARBY = 'push.new_listing_nearby',
}

export interface NewListingNearbyPayload {
  listingId: number;
  businessName: string;
  pickupAddress: string;
  totalQtyKg: number;
  bestBefore: string;
  deviceTokens: string[];
}
