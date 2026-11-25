import { BillingModule, OrgType, PlanScope, SubscriptionStatus } from '@prisma/client';

import { BILLING_ERROR, expandModules } from '../subscription.constants';
import { SubscriptionAccessService } from './subscription-access.service';

/**
 * Which modules an organisation may use (modular billing). Prisma is stubbed,
 * so this runs without a database.
 */
describe('SubscriptionAccessService modules', () => {
  function plan(module: BillingModule, name = `${module}_SINGLE`) {
    return {
      id: 1,
      name,
      displayName: name,
      module,
      scope: PlanScope.SINGLE,
      maxSites: 1,
      maxUserPerSite: null,
      planFeatures: [],
    };
  }

  function build(options: {
    sub?: { status: SubscriptionStatus; plan: ReturnType<typeof plan> } | null;
    freeTrialUsedAt?: Date | null;
  }) {
    const sub = options.sub
      ? {
          ...options.sub,
          billingCycle: 'MONTHLY',
          quantity: 1,
          trialEndsAt: null,
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          pendingPlanId: null,
          pendingPlan: null,
          pendingBillingCycle: null,
          pendingChangeEffectiveAt: null,
        }
      : null;
    const prisma = {
      orgSubscription: { findUnique: jest.fn().mockResolvedValue(sub) },
      organisation: {
        findUnique: jest.fn().mockResolvedValue({ freeTrialUsedAt: options.freeTrialUsedAt ?? null }),
      },
    };
    return new SubscriptionAccessService(prisma as never);
  }

  const business = { sub: 1, orgId: 10, orgType: OrgType.BUSINESS_SINGLE } as never;
  const charity = { sub: 2, orgId: 20, orgType: OrgType.CHARITY_SINGLE } as never;

  it('expands COMPLETE into both modules', () => {
    expect(expandModules(BillingModule.COMPLETE)).toEqual(['MFC', 'CONNECT']);
    expect(expandModules(BillingModule.MFC)).toEqual(['MFC']);
    expect(expandModules(BillingModule.CONNECT)).toEqual(['CONNECT']);
    expect(expandModules(null)).toEqual([]);
  });

  it('grants only the module an active single-module plan sells', async () => {
    const service = build({ sub: { status: SubscriptionStatus.ACTIVE, plan: plan(BillingModule.MFC) } });
    const ent = await service.getEntitlements(business);
    expect(ent.modules).toEqual(['MFC']);
    expect(ent.planModule).toBe(BillingModule.MFC);
    expect(ent.planScope).toBe(PlanScope.SINGLE);
  });

  it('grants both modules on a trialing Complete plan', async () => {
    const service = build({ sub: { status: SubscriptionStatus.TRIALING, plan: plan(BillingModule.COMPLETE) } });
    await expect(service.getEntitlements(business)).resolves.toMatchObject({
      entitled: true,
      modules: ['MFC', 'CONNECT'],
    });
  });

  it('treats a legacy Single Site + subscription as Saveful Connect', async () => {
    const service = build({
      sub: { status: SubscriptionStatus.ACTIVE, plan: plan(BillingModule.CONNECT, 'SINGLE_SITE_PLUS') },
    });
    await expect(service.getEntitlements(business)).resolves.toMatchObject({ modules: ['CONNECT'] });
  });

  it('grants no module once the plan has lapsed, but still reports which it was', async () => {
    const service = build({ sub: { status: SubscriptionStatus.PAST_DUE, plan: plan(BillingModule.COMPLETE) } });
    const ent = await service.getEntitlements(business);
    expect(ent.entitled).toBe(false);
    expect(ent.modules).toEqual([]);
    expect(ent.planModule).toBe(BillingModule.COMPLETE);
  });

  it('grants no module to a billable org without a plan', async () => {
    const service = build({ sub: null });
    await expect(service.getEntitlements(business)).resolves.toMatchObject({
      entitled: false,
      modules: [],
      freeTrialAvailable: true,
    });
  });

  it('never limits a free-forever org by module', async () => {
    const service = build({});
    await expect(service.getEntitlements(charity)).resolves.toMatchObject({
      billingRequired: false,
      modules: ['MFC', 'CONNECT'],
    });
  });

  it('rejects a module the plan does not include with MODULE_REQUIRED', async () => {
    const service = build({ sub: { status: SubscriptionStatus.ACTIVE, plan: plan(BillingModule.CONNECT) } });
    await expect(service.assertModule(business, 'MFC')).rejects.toMatchObject({
      response: { error: BILLING_ERROR.MODULE_REQUIRED, module: 'MFC' },
      status: 402,
    });
    await expect(service.assertModule(business, 'CONNECT')).resolves.toMatchObject({ entitled: true });
  });

  it('reports a missing plan as SUBSCRIPTION_REQUIRED, not MODULE_REQUIRED', async () => {
    const service = build({ sub: null });
    await expect(service.assertModule(business, 'MFC')).rejects.toMatchObject({
      response: { error: BILLING_ERROR.SUBSCRIPTION_REQUIRED },
    });
  });
});
