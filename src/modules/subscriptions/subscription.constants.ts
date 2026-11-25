import { BillingModule, OrgType, SubscriptionStatus } from '@prisma/client';

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

/**
 * Statuses that mean a billing relationship is still live. A second Checkout in
 * any of these would create a duplicate Stripe subscription, so they route to
 * the change-plan flow instead.
 */
export const LIVE_STATUSES: readonly SubscriptionStatus[] = [
  SubscriptionStatus.TRIALING,
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.PAST_DUE,
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
  MODULE_MFC: 'module_mfc',
  MODULE_CONNECT: 'module_connect',
} as const;

export type FeatureKey = (typeof FEATURE)[keyof typeof FEATURE];

/** Machine-readable error codes so the client can route to the right screen. */
export const BILLING_ERROR = {
  SUBSCRIPTION_REQUIRED: 'SUBSCRIPTION_REQUIRED',
  SUBSCRIPTION_INACTIVE: 'SUBSCRIPTION_INACTIVE',
  /// Checkout was called by an org that already has a live plan — use change-plan
  PLAN_CHANGE_REQUIRED: 'PLAN_CHANGE_REQUIRED',
  /// change-plan was called by an org with nothing to change from — use checkout
  NO_ACTIVE_SUBSCRIPTION: 'NO_ACTIVE_SUBSCRIPTION',
  ALREADY_ON_PLAN: 'ALREADY_ON_PLAN',
  /// Upgrading off a card-less free trial — collect a card before charging
  PAYMENT_METHOD_REQUIRED: 'PAYMENT_METHOD_REQUIRED',
  SITE_LIMIT_REACHED: 'SITE_LIMIT_REACHED',
  USER_LIMIT_REACHED: 'USER_LIMIT_REACHED',
  FEATURE_NOT_IN_PLAN: 'FEATURE_NOT_IN_PLAN',
  /// The plan does not include the module this route belongs to
  MODULE_REQUIRED: 'MODULE_REQUIRED',
  /// /billing/trial was called for a plan sold without a free trial (Make Food Count)
  TRIAL_NOT_OFFERED: 'TRIAL_NOT_OFFERED',
} as const;

/** A module an org can hold. COMPLETE is a plan, not a module: it grants both. */
export type ProductModule = 'MFC' | 'CONNECT';

export const ALL_MODULES: readonly ProductModule[] = ['MFC', 'CONNECT'];

/** The modules a plan's `module` grants. */
export function expandModules(module: BillingModule | null | undefined): ProductModule[] {
  switch (module) {
    case BillingModule.MFC:
      return ['MFC'];
    case BillingModule.CONNECT:
      return ['CONNECT'];
    case BillingModule.COMPLETE:
      return ['MFC', 'CONNECT'];
    default:
      return [];
  }
}

export const MODULE_DISPLAY_NAME: Record<ProductModule, string> = {
  MFC: 'Make Food Count',
  CONNECT: 'Saveful Connect',
};
