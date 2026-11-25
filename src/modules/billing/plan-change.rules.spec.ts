import { BillingCycle, BillingModule, PlanScope } from '@prisma/client';

import { resolvePlanChange } from './plan-change.rules';

/**
 * The plan-change matrix from docs/modular-billing/REQUIREMENTS.md §4.2,
 * plus legacy and cross-scope cases.
 */
describe('resolvePlanChange', () => {
  type P = { id: number; module: BillingModule; scope: PlanScope; price: number };

  const MFC_SINGLE: P = { id: 1, module: BillingModule.MFC, scope: PlanScope.SINGLE, price: 49 };
  const CONNECT_SINGLE: P = { id: 2, module: BillingModule.CONNECT, scope: PlanScope.SINGLE, price: 49 };
  const COMPLETE_SINGLE: P = { id: 3, module: BillingModule.COMPLETE, scope: PlanScope.SINGLE, price: 89 };
  const CONNECT_MULTI: P = { id: 5, module: BillingModule.CONNECT, scope: PlanScope.MULTI, price: 69 };
  const COMPLETE_MULTI: P = { id: 6, module: BillingModule.COMPLETE, scope: PlanScope.MULTI, price: 99 };
  const SINGLE_SITE: P = { id: 21, module: BillingModule.CONNECT, scope: PlanScope.SINGLE, price: 49 };
  const SINGLE_SITE_PLUS: P = { id: 22, module: BillingModule.CONNECT, scope: PlanScope.SINGLE, price: 69 };
  const MULTI_SITE: P = { id: 23, module: BillingModule.CONNECT, scope: PlanScope.MULTI, price: 89 };

  const M = BillingCycle.MONTHLY;
  const A = BillingCycle.ANNUAL;

  function change(from: P, to: P, fromCycle: BillingCycle = M, toCycle: BillingCycle = fromCycle) {
    return resolvePlanChange({
      currentPlan: from,
      newPlan: to,
      currentCycle: fromCycle,
      newCycle: toCycle,
      tierAmount: (plan) => (plan as P).price,
    });
  }

  describe('module matrix (same scope)', () => {
    it.each([
      ['MFC → CONNECT', MFC_SINGLE, CONNECT_SINGLE, 'DOWNGRADE', 'SWITCH'],
      ['MFC → COMPLETE', MFC_SINGLE, COMPLETE_SINGLE, 'UPGRADE', 'UPGRADE'],
      ['CONNECT → MFC', CONNECT_SINGLE, MFC_SINGLE, 'DOWNGRADE', 'SWITCH'],
      ['CONNECT → COMPLETE', CONNECT_SINGLE, COMPLETE_SINGLE, 'UPGRADE', 'UPGRADE'],
      ['COMPLETE → MFC', COMPLETE_SINGLE, MFC_SINGLE, 'DOWNGRADE', 'DOWNGRADE'],
      ['COMPLETE → CONNECT', COMPLETE_SINGLE, CONNECT_SINGLE, 'DOWNGRADE', 'DOWNGRADE'],
      ['CONNECT_MULTI → COMPLETE_MULTI', CONNECT_MULTI, COMPLETE_MULTI, 'UPGRADE', 'UPGRADE'],
    ])('%s', (_label, from, to, direction, kind) => {
      expect(change(from, to)).toEqual({ direction, kind });
    });

    it('decides by module even when the cycle changes too', () => {
      // Annual Complete → monthly MFC is still losing a module.
      expect(change(COMPLETE_SINGLE, MFC_SINGLE, A, M)).toEqual({ direction: 'DOWNGRADE', kind: 'DOWNGRADE' });
      expect(change(MFC_SINGLE, COMPLETE_SINGLE, A, M)).toEqual({ direction: 'UPGRADE', kind: 'UPGRADE' });
    });
  });

  describe('same plan', () => {
    it('is no change on the same cycle', () => {
      expect(change(CONNECT_SINGLE, CONNECT_SINGLE)).toBeNull();
      expect(change(COMPLETE_SINGLE, COMPLETE_SINGLE, A)).toBeNull();
    });

    it('applies monthly → annual now, and annual → monthly at the period end', () => {
      expect(change(MFC_SINGLE, MFC_SINGLE, M, A)).toEqual({ direction: 'UPGRADE', kind: 'UPGRADE' });
      expect(change(MFC_SINGLE, MFC_SINGLE, A, M)).toEqual({ direction: 'DOWNGRADE', kind: 'DOWNGRADE' });
    });
  });

  describe('legacy plans (module CONNECT)', () => {
    it('Single Site + → Saveful Connect is a cheaper Connect plan: scheduled downgrade', () => {
      expect(change(SINGLE_SITE_PLUS, CONNECT_SINGLE)).toEqual({ direction: 'DOWNGRADE', kind: 'DOWNGRADE' });
    });

    it('Single Site + → Complete gains a module: upgrade', () => {
      expect(change(SINGLE_SITE_PLUS, COMPLETE_SINGLE)).toEqual({ direction: 'UPGRADE', kind: 'UPGRADE' });
    });

    it('Single Site + → Make Food Count swaps the module: scheduled switch', () => {
      expect(change(SINGLE_SITE_PLUS, MFC_SINGLE)).toEqual({ direction: 'DOWNGRADE', kind: 'SWITCH' });
    });

    it('Single Site → Saveful Connect at the same price is a switch, not "already on plan"', () => {
      expect(change(SINGLE_SITE, CONNECT_SINGLE)).toEqual({ direction: 'DOWNGRADE', kind: 'SWITCH' });
    });

    it('Single Site → Saveful Connect annual prepays: upgrade', () => {
      expect(change(SINGLE_SITE, CONNECT_SINGLE, M, A)).toEqual({ direction: 'UPGRADE', kind: 'UPGRADE' });
    });

    it('flat Multi Site → Complete multi gains a module: upgrade', () => {
      expect(change(MULTI_SITE, COMPLETE_MULTI)).toEqual({ direction: 'UPGRADE', kind: 'UPGRADE' });
    });
  });

  describe('between scopes', () => {
    it('falls back to the monthly price', () => {
      expect(change(CONNECT_SINGLE, CONNECT_MULTI)).toEqual({ direction: 'UPGRADE', kind: 'UPGRADE' });
      expect(change(COMPLETE_SINGLE, CONNECT_MULTI)).toEqual({ direction: 'DOWNGRADE', kind: 'DOWNGRADE' });
    });
  });
});
