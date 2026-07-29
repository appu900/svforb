import { OrgType, SubscriptionStatus } from '@prisma/client';

/**
 * Org types that receive food. The platform is free for them for life —
 * they never hold an OrgSubscription and are never gated.
 */
export const FREE_FOREVER_ORG_TYPES: readonly OrgType[] = [
  OrgType.CHARITY,
  OrgType.CHARITY_SINGLE,
  OrgType.CHARITY_MULTI,
  OrgType.FARMER_CONSUMER,
];

/**
 * Org types that list surplus food. They sign up with no subscription and must
 * choose a plan before they can perform any write action.
 */
export const BILLABLE_ORG_TYPES: readonly OrgType[] = [
  OrgType.BUSINESS_SINGLE,
  OrgType.BUSINESS_MULTI,
  OrgType.FARMER_PRODUCER,
];

/** Statuses that grant full product access. */
export const ENTITLING_STATUSES: readonly SubscriptionStatus[] = [
  SubscriptionStatus.TRIALING,
  SubscriptionStatus.ACTIVE,
];

export function requiresBilling(orgType?: OrgType | null): boolean {
  return !!orgType && BILLABLE_ORG_TYPES.includes(orgType);
}

export function isFreeForever(orgType?: OrgType | null): boolean {
  return !!orgType && FREE_FOREVER_ORG_TYPES.includes(orgType);
}

/** Stable PlanFeature.key values — must match prisma/seed.ts. */
export const FEATURE = {
  SURPLUS_LISTING: 'surplus_listing',
  CHARITY_MATCHING: 'charity_matching',
  BASIC_IMPACT_TRACKING: 'basic_impact_tracking',
  DATE_SPECIFICATION: 'date_specification',
  OPERATIONAL_INSIGHTS: 'operational_insights',
  COST_SAVING_INSIGHTS: 'cost_saving_insights',
  ESG_REPORTS: 'esg_reports',
  PRIORITY_SUPPORT: 'priority_support',
} as const;

export type FeatureKey = (typeof FEATURE)[keyof typeof FEATURE];

/** Machine-readable error codes so the client can route to the right screen. */
export const BILLING_ERROR = {
  SUBSCRIPTION_REQUIRED: 'SUBSCRIPTION_REQUIRED',
  SUBSCRIPTION_INACTIVE: 'SUBSCRIPTION_INACTIVE',
  SITE_LIMIT_REACHED: 'SITE_LIMIT_REACHED',
  USER_LIMIT_REACHED: 'USER_LIMIT_REACHED',
  FEATURE_NOT_IN_PLAN: 'FEATURE_NOT_IN_PLAN',
} as const;
