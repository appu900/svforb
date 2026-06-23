export const PUSH_QUEUE = 'push';

export enum PushJobName {
  NEW_LISTING_NEARBY   = 'push.new_listing_nearby',
  CLAIM_MADE           = 'push.claim_made',
  PARTIAL_CLAIM_UPDATE = 'push.partial_claim_update',
  CLAIM_CONFIRMED      = 'push.claim_confirmed',
  CLAIM_CANCELLED      = 'push.claim_cancelled',
  PICKUP_AVAILABLE     = 'push.pickup_available',
}

export interface NewListingNearbyPayload {
  listingId: number;
  businessName: string;
  pickupAddress: string;
  totalQtyKg: number;
  bestBefore: string;
  deviceTokens: string[];
}

export interface ClaimMadePayload {
  claimId: number;
  listingId: number;
  claimantName: string;
  totalClaimedKg: number;
  deviceTokens: string[];
}

export interface PartialClaimUpdatePayload {
  listingId: number;
  businessName: string;
  pickupAddress: string;
  remainingQtyKg: number;
  deviceTokens: string[];
}

export interface ClaimConfirmedPayload {
  claimId: number;
  listingId: number;
  businessName: string;
  pickupAddress: string;
  pickupByTime?: string;
  deviceTokens: string[];
}

export interface ClaimCancelledPayload {
  claimId: number;
  listingId: number;
  cancelledByName: string;
  deviceTokens: string[];
}

export interface PickupAvailablePayload {
  claimId: number;
  listingId: number;
  businessName: string;
  pickupAddress: string;
  totalQtyKg: number;
  deviceTokens: string[];
}
