import { BillingCycle, BillingModule, PlanScope } from '@prisma/client';

/** Immediate and prorated, or deferred to the period end. */
export type ChangeDirection = 'UPGRADE' | 'DOWNGRADE';

/**
 * What the change means to the customer. A SWITCH (Make Food Count ↔ Saveful
 * Connect) is billed like a downgrade — deferred to the period end — but is
 * neither a step up nor down, so it is worded differently.
 */
export type ChangeKind = 'UPGRADE' | 'DOWNGRADE' | 'SWITCH';

export type PlanChange = { direction: ChangeDirection; kind: ChangeKind };

type ComparablePlan = {
  id: number;
  module: BillingModule;
  scope: PlanScope;
};

/** COMPLETE holds both modules, so it outranks either one alone. */
const MODULE_RANK: Record<BillingModule, number> = {
  [BillingModule.MFC]: 1,
  [BillingModule.CONNECT]: 1,
  [BillingModule.COMPLETE]: 2,
};

/**
 * Decides how a plan change is billed. Shared by preview and apply so the
 * confirmation dialog always describes what will actually happen.
 *
 * Within one scope the module decides first:
 *   - gaining a module (→ COMPLETE) is an immediate, prorated upgrade
 *   - losing one (COMPLETE →) waits for the period end
 *   - MFC ↔ CONNECT is a switch, also at the period end, so the org keeps
 *     what it paid for this period
 * Same module (e.g. legacy Single Site + → Saveful Connect), or a move between
 * single and multi site, falls back to the monthly list price, then the cycle.
 *
 * Returns null when nothing would change.
 */
export function resolvePlanChange(params: {
  currentPlan: ComparablePlan;
  newPlan: ComparablePlan;
  currentCycle: BillingCycle;
  newCycle: BillingCycle;
  /** Monthly list price in the org's currency. */
  tierAmount: (plan: ComparablePlan) => number;
}): PlanChange | null {
  const { currentPlan, newPlan, currentCycle, newCycle, tierAmount } = params;

  if (currentPlan.scope === newPlan.scope && currentPlan.module !== newPlan.module) {
    const rankDelta = MODULE_RANK[newPlan.module] - MODULE_RANK[currentPlan.module];
    if (rankDelta > 0) return { direction: 'UPGRADE', kind: 'UPGRADE' };
    if (rankDelta < 0) return { direction: 'DOWNGRADE', kind: 'DOWNGRADE' };
    return { direction: 'DOWNGRADE', kind: 'SWITCH' };
  }

  const tierDelta = tierAmount(newPlan) - tierAmount(currentPlan);
  if (tierDelta > 0) return { direction: 'UPGRADE', kind: 'UPGRADE' };
  if (tierDelta < 0) return { direction: 'DOWNGRADE', kind: 'DOWNGRADE' };

  // Same tier price: only the cycle can differ. Annual prepays, so it applies now.
  if (currentPlan.id === newPlan.id && currentCycle === newCycle) return null;
  if (currentCycle === newCycle) {
    // Two different plans at the same price and module (legacy → new at equal
    // price): treat like a switch so nobody pays twice in one period.
    return { direction: 'DOWNGRADE', kind: 'SWITCH' };
  }
  return newCycle === BillingCycle.ANNUAL
    ? { direction: 'UPGRADE', kind: 'UPGRADE' }
    : { direction: 'DOWNGRADE', kind: 'DOWNGRADE' };
}
