import {
  BillingCycle,
  BillingModule,
  OrgRole,
  OrgType,
  PlanScope,
  SubscriptionStatus,
} from '@prisma/client';

import { BILLING_ERROR } from '../../subscriptions/subscription.constants';
import { BillingService } from './billing.service';

/**
 * Modular billing rules in BillingService: per-plan trials, keeping a trial on
 * an upgrade to a trialled plan, and per-site quantity. Prisma and Stripe are
 * stubbed, so this runs without a database or network.
 */
describe('BillingService (modular billing)', () => {
  const ORG_ID = 10;

  function plan(overrides: Record<string, unknown>) {
    return {
      id: 1,
      name: 'PLAN',
      displayName: 'Plan',
      module: BillingModule.CONNECT,
      scope: PlanScope.SINGLE,
      trialDays: 30,
      priceMonthly: 49,
      priceAnnual: 490,
      priceMonthlyInr: 5,
      priceAnnualInr: 50,
      isPerSite: false,
      contactSalesOnly: false,
      isActive: true,
      applicableOrgTypes: [OrgType.BUSINESS_SINGLE, OrgType.BUSINESS_MULTI],
      stripeProductId: 'prod_1',
      ...overrides,
    };
  }

  const MFC_SINGLE = plan({ id: 1, name: 'MFC_SINGLE', displayName: 'Make Food Count', module: BillingModule.MFC, trialDays: 0 });
  const CONNECT_SINGLE = plan({ id: 2, name: 'CONNECT_SINGLE', displayName: 'Saveful Connect' });
  const COMPLETE_SINGLE = plan({
    id: 3, name: 'COMPLETE_SINGLE', displayName: 'Complete Solution', module: BillingModule.COMPLETE, priceMonthly: 89, priceAnnual: 890,
  });
  const CONNECT_MULTI = plan({
    id: 5, name: 'CONNECT_MULTI', displayName: 'Saveful Connect', scope: PlanScope.MULTI, priceMonthly: 69, priceAnnual: 690, isPerSite: true,
  });
  const MULTI_SITE = plan({
    id: 23, name: 'MULTI_SITE', displayName: 'Multi Site', scope: PlanScope.MULTI, priceMonthly: 89, priceAnnual: 890, isPerSite: false,
  });
  /** A trial-less plan above Connect, to exercise the "trial ends now" path. */
  const COMPLETE_NO_TRIAL = plan({ ...COMPLETE_SINGLE, id: 4, trialDays: 0 });

  const PLANS = [MFC_SINGLE, CONNECT_SINGLE, COMPLETE_SINGLE, CONNECT_MULTI, MULTI_SITE, COMPLETE_NO_TRIAL];

  function build(options: {
    orgSub?: Record<string, unknown> | null;
    freeTrialUsedAt?: Date | null;
    siteCount?: number;
    stripeStatus?: string;
    hasCard?: boolean;
  } = {}) {
    const prisma = {
      organisation: {
        findUnique: jest.fn().mockResolvedValue({
          id: ORG_ID, name: 'Venue', region: 'AU', freeTrialUsedAt: options.freeTrialUsedAt ?? null,
        }),
      },
      subscriptionPlan: {
        findUnique: jest.fn(({ where }: { where: { id: number } }) =>
          Promise.resolve(PLANS.find((p) => p.id === where.id) ?? null)),
        update: jest.fn(),
      },
      orgSubscription: {
        findUnique: jest.fn().mockResolvedValue(options.orgSub ?? null),
        update: jest.fn().mockResolvedValue({}),
      },
      user: { findUnique: jest.fn().mockResolvedValue({ email: 'owner@example.com' }) },
      site: { count: jest.fn().mockResolvedValue(options.siteCount ?? 1) },
    };

    const trialEnd = Math.floor(Date.UTC(2026, 11, 20) / 1000);
    const stripeSub = {
      id: 'sub_1',
      status: options.stripeStatus ?? 'active',
      trial_end: options.stripeStatus === 'trialing' ? trialEnd : null,
      customer: 'cus_1',
      default_payment_method: options.hasCard ? 'pm_1' : null,
      items: { data: [{ id: 'si_1', current_period_end: trialEnd }] },
    };

    const stripe = {
      checkout: { sessions: { create: jest.fn().mockResolvedValue({ id: 'cs_1', url: 'https://checkout' }) } },
      products: { retrieve: jest.fn().mockResolvedValue({ id: 'prod_1', deleted: false }) },
      subscriptions: {
        retrieve: jest.fn().mockResolvedValue(stripeSub),
        update: jest.fn().mockResolvedValue(stripeSub),
      },
      customers: {
        retrieve: jest.fn().mockResolvedValue({ deleted: false, invoice_settings: {}, default_source: null }),
      },
      paymentMethods: { list: jest.fn().mockResolvedValue({ data: options.hasCard ? [{ id: 'pm_1' }] : [] }) },
      subscriptionSchedules: { release: jest.fn() },
      invoices: { createPreview: jest.fn() },
    };
    const stripeService = { stripe, ensureCustomer: jest.fn().mockResolvedValue('cus_1') };
    const config = { get: jest.fn((_key: string, fallback?: string) => fallback) };

    const service = new BillingService(prisma as never, stripeService as never, config as never);
    return { service, prisma, stripe };
  }

  const admin = (orgType: OrgType = OrgType.BUSINESS_SINGLE) =>
    ({ sub: 1, email: 'owner@example.com', orgId: ORG_ID, orgType, orgRole: OrgRole.SUPER_ADMIN }) as never;

  function liveSub(current: Record<string, unknown>, status: SubscriptionStatus = SubscriptionStatus.ACTIVE) {
    return {
      organisationId: ORG_ID,
      planId: current.id,
      plan: current,
      status,
      billingCycle: BillingCycle.MONTHLY,
      quantity: 1,
      stripeSubscriptionId: 'sub_1',
      stripeCustomerId: 'cus_1',
      stripeScheduleId: null,
      currentPeriodEnd: new Date('2026-12-20T00:00:00Z'),
    };
  }

  describe('free trial', () => {
    it('refuses Make Food Count with TRIAL_NOT_OFFERED, before touching Stripe', async () => {
      const { service, stripe } = build();
      await expect(service.startFreeTrial(admin(), { planId: MFC_SINGLE.id } as never)).rejects.toMatchObject({
        response: { error: BILLING_ERROR.TRIAL_NOT_OFFERED },
        status: 400,
      });
      expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    });

    it("uses the plan's trial length", async () => {
      const { service, stripe } = build();
      const result = await service.startFreeTrial(admin(), { planId: COMPLETE_SINGLE.id } as never);
      expect(result.trialDays).toBe(30);
      expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          subscription_data: expect.objectContaining({ trial_period_days: 30 }),
          payment_method_collection: 'if_required',
        }),
      );
    });

    it('still allows only one trial per organisation', async () => {
      const { service } = build({ freeTrialUsedAt: new Date() });
      await expect(service.startFreeTrial(admin(), { planId: CONNECT_SINGLE.id } as never)).rejects.toMatchObject({
        status: 409,
      });
    });
  });

  describe('upgrading while on a trial', () => {
    it('Saveful Connect trial → Complete keeps the trial: no trial_end, no card, nothing billed', async () => {
      const { service, stripe, prisma } = build({
        orgSub: liveSub(CONNECT_SINGLE, SubscriptionStatus.TRIALING),
        stripeStatus: 'trialing',
        hasCard: false,
      });

      const result = await service.changePlan(admin(), { planId: COMPLETE_SINGLE.id } as never);

      expect(result).toMatchObject({ type: 'UPGRADED', changeType: 'UPGRADE', planId: COMPLETE_SINGLE.id });
      expect(result.message).toContain('free trial continues');
      const params = stripe.subscriptions.update.mock.calls[0][1];
      expect(params.trial_end).toBeUndefined();
      expect(params.billing_cycle_anchor).toBeUndefined();
      expect(params.proration_behavior).toBe('none');
      expect(prisma.orgSubscription.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ planId: COMPLETE_SINGLE.id }) }),
      );
    });

    it('previews that upgrade as nothing due today and the trial intact', async () => {
      const { service, stripe } = build({
        orgSub: liveSub(CONNECT_SINGLE, SubscriptionStatus.TRIALING),
        stripeStatus: 'trialing',
      });
      const preview = await service.previewPlanChange(admin(), { planId: COMPLETE_SINGLE.id } as never);
      expect(preview).toMatchObject({
        direction: 'UPGRADE',
        changeType: 'UPGRADE',
        amountDueToday: 0,
        requiresPaymentMethod: false,
        endsTrialEarly: false,
      });
      expect(stripe.invoices.createPreview).not.toHaveBeenCalled();
    });

    it('to a plan without a trial still ends the trial and needs a card', async () => {
      const { service, stripe } = build({
        orgSub: liveSub(CONNECT_SINGLE, SubscriptionStatus.TRIALING),
        stripeStatus: 'trialing',
        hasCard: false,
      });
      await expect(service.changePlan(admin(), { planId: COMPLETE_NO_TRIAL.id } as never)).rejects.toMatchObject({
        response: { error: BILLING_ERROR.PAYMENT_METHOD_REQUIRED },
      });
      expect(stripe.subscriptions.update).not.toHaveBeenCalled();
    });
  });

  describe('switching modules', () => {
    it('Make Food Count → Saveful Connect previews as a switch with nothing due', async () => {
      const { service } = build({ orgSub: liveSub(MFC_SINGLE) });
      const preview = await service.previewPlanChange(admin(), { planId: CONNECT_SINGLE.id } as never);
      expect(preview).toMatchObject({ direction: 'DOWNGRADE', changeType: 'SWITCH', amountDueToday: 0 });
    });
  });

  describe('per-site quantity', () => {
    it('charges the module multi-site plans per site at checkout', async () => {
      const { service, stripe } = build({ siteCount: 3 });
      await service.createCheckoutSession(admin(OrgType.BUSINESS_MULTI), {
        planId: CONNECT_MULTI.id,
        billingCycle: BillingCycle.MONTHLY,
      } as never);
      const lineItem = stripe.checkout.sessions.create.mock.calls[0][0].line_items[0];
      expect(lineItem.quantity).toBe(3);
      expect(lineItem.price_data.unit_amount).toBe(6900);
    });

    it('keeps the legacy Multi Site a flat fee', async () => {
      const { service, stripe } = build({
        orgSub: { ...liveSub(MULTI_SITE), quantity: 1 },
        siteCount: 4,
      });
      await service.syncSiteQuantity(ORG_ID);
      expect(stripe.subscriptions.update).not.toHaveBeenCalled();
    });

    it('syncs the quantity with proration when a per-site org adds a site', async () => {
      const { service, stripe, prisma } = build({
        orgSub: { ...liveSub(CONNECT_MULTI), quantity: 3 },
        siteCount: 4,
      });
      await service.syncSiteQuantity(ORG_ID);
      expect(stripe.subscriptions.update).toHaveBeenCalledWith('sub_1', {
        items: [{ id: 'si_1', quantity: 4 }],
        proration_behavior: 'create_prorations',
      });
      expect(prisma.orgSubscription.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { quantity: 4 } }),
      );
    });
  });
});
