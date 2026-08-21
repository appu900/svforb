/** The plan name that marks an organisation as an Enterprise. */
export const ENTERPRISE_PLAN_NAME = 'ENTERPRISE';

/** Reporting dimensions a caller can aggregate over. */
export const SCOPE = {
  ENTERPRISE: 'ENTERPRISE',
  GROUP: 'GROUP',
  CLUSTER: 'CLUSTER',
  TERRITORY: 'TERRITORY',
  SITE: 'SITE',
} as const;

export type ScopeType = (typeof SCOPE)[keyof typeof SCOPE];

export const ENTERPRISE_ERROR = {
  NOT_ENTERPRISE: 'NOT_ENTERPRISE',
  GROUP_HAS_CLUSTERS: 'GROUP_HAS_CLUSTERS',
  SITE_ALREADY_ASSIGNED: 'SITE_ALREADY_ASSIGNED',
  CONTRACT_EXISTS: 'CONTRACT_EXISTS',
  INVOICE_NOT_PAYABLE: 'INVOICE_NOT_PAYABLE',
  ALREADY_INVOICED: 'ALREADY_INVOICED',
  OUTSIDE_SCOPE: 'OUTSIDE_SCOPE',
  LAST_SUPER_ADMIN: 'LAST_SUPER_ADMIN',
} as const;

/** Advances a billing anchor by one cycle. */
export function addBillingPeriod(from: Date, frequency: string): Date {
  const next = new Date(from);
  const months = frequency === 'ANNUAL' ? 12 : frequency === 'QUARTERLY' ? 3 : 1;
  next.setMonth(next.getMonth() + months);
  return next;
}
