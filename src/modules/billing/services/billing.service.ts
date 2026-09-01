import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BillingCycle,
  OrgRole,
  Region,
  SubscriptionPlan,
  SubscriptionStatus,
} from '@prisma/client';
import Stripe = require('stripe');
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import {
  BILLING_ERROR,
  LIVE_STATUSES,
  requiresBilling,
} from '../../subscriptions/subscription.constants';
import {
  ChangePlanDto,
  CreateCheckoutSessionDto,
  EnterpriseEnquiryDto,
  StartTrialDto,
} from '../dto/billing.dto';
import { currencyForRegion, STRIPE_CURRENCY_INR, StripeService } from './stripe.service';

const TRIAL_DAYS = 30;

/** Immediate and prorated, or deferred to the period end. */
type ChangeDirection = 'UPGRADE' | 'DOWNGRADE';

/**
 * Billing period moved off Subscription and onto its items in recent Stripe API
 * versions. Read the item first, fall back to the root so either shape works.
 */
function readItemPeriodEnd(sub: Stripe.Subscription): Date | null {
  const item = sub.items?.data?.[0] as unknown as
    | { current_period_end?: number }
    | undefined;
  const legacy = sub as unknown as { current_period_end?: number };
  const seconds = item?.current_period_end ?? legacy.current_period_end;
  return seconds ? new Date(seconds * 1000) : null;
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
    private readonly config: ConfigService,
  ) {}

  // ─── Free trial (no card required up front) ────────────────────────────────

  /**
   * Starts the 30-day trial through Stripe Checkout without collecting a card.
   * Card details are collected later when the trial ends / when they subscribe.
   *
   * `freeTrialUsedAt` is stamped by the webhook rather than here, so abandoning
   * the Checkout page does not burn the org's one trial.
   */
  async startFreeTrial(caller: Jwtpayload, dto: StartTrialDto) {
    const org = await this.assertBillableOrgAdmin(caller);

    if (org.freeTrialUsedAt) {
      throw new ConflictException(
        'Your organisation has already used its free trial. Please choose a paid plan.',
      );
    }

    const plan = await this.assertPurchasablePlan(dto.planId, caller);
    await this.assertNoLiveSubscription(org.id);

    const session = await this.buildCheckoutSession({
      caller,
      org,
      plan,
      billingCycle: dto.billingCycle ?? BillingCycle.MONTHLY,
      trialDays: TRIAL_DAYS,
    });

    return {
      ...session,
      trialDays: TRIAL_DAYS,
      message:
        `Your free trial lasts ${TRIAL_DAYS} days — no card needed to start. ` +
        'Add a payment method before the trial ends to keep your plan active.',
    };
  }

  // ─── Paid checkout (Stripe hosted redirect) ────────────────────────────────

  async createCheckoutSession(caller: Jwtpayload, dto: CreateCheckoutSessionDto) {
    const org = await this.assertBillableOrgAdmin(caller);
    const plan = await this.assertPurchasablePlan(dto.planId, caller);

    // Without this an org with a live plan would end up with a second Stripe
    // subscription billing alongside the first.
    await this.assertNoLiveSubscription(org.id);

    return this.buildCheckoutSession({
      caller,
      org,
      plan,
      billingCycle: dto.billingCycle,
    });
  }

  private async buildCheckoutSession(params: {
    caller: Jwtpayload;
    org: { id: number; name: string; region: Region | null };
    plan: SubscriptionPlan;
    billingCycle: BillingCycle;
    trialDays?: number;
  }) {
    const { caller, org, plan, billingCycle, trialDays } = params;

    const subscription = await this.prisma.orgSubscription.findUnique({
      where: { organisationId: org.id },
    });

    const owner = await this.prisma.user.findUnique({
      where: { id: caller.sub },
      select: { email: true },
    });

    const customerId = await this.stripeService.ensureCustomer({
      existingCustomerId: subscription?.stripeCustomerId,
      orgId: org.id,
      orgName: org.name,
      email: owner?.email ?? caller.email,
    });

    const quantity = await this.resolveQuantity(org.id, plan.isPerSite);
    const priceData = await this.buildRecurringPriceData(plan, org.region, billingCycle);
    const appUrl = this.websiteOrigin();

    const metadata = {
      orgId: String(org.id),
      planId: String(plan.id),
      billingCycle,
      isTrial: trialDays ? 'true' : 'false',
    };

    const session = await this.stripeService.stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: String(org.id),
      line_items: [{ quantity, price_data: priceData }],
      success_url: `${appUrl}/business/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/business/billing/cancelled`,
      allow_promotion_codes: true,
      // Trials start without a card; paid checkout still requires one.
      payment_method_collection: trialDays ? 'if_required' : 'always',
      subscription_data: {
        ...(trialDays ? { trial_period_days: trialDays } : {}),
        metadata,
      },
      metadata,
    });

    this.logger.log(
      `Checkout session ${session.id} created: org=${org.id} plan=${plan.name} ` +
        `cycle=${billingCycle} qty=${quantity} currency=${priceData.currency} ` +
        `trialDays=${trialDays ?? 0}`,
    );

    return {
      checkoutUrl: session.url,
      sessionId: session.id,
      currency: priceData.currency.toUpperCase(),
    };
  }

  // ─── Plan switching ────────────────────────────────────────────────────────

  /**
   * Upgrades apply immediately and are prorated — Stripe credits the unused
   * remainder of the old plan, charges the new one in full, and restarts the
   * billing cycle today. Downgrades are deferred to the period end via a
   * Subscription Schedule, so the org keeps what it already paid for.
   */
  async changePlan(caller: Jwtpayload, dto: ChangePlanDto) {
    const org = await this.assertBillableOrgAdmin(caller);
    const sub = await this.requireStripeSubscription(org.id);
    const newPlan = await this.assertPurchasablePlan(dto.planId, caller);

    const targetCycle = dto.billingCycle ?? sub.billingCycle;
    const direction = this.resolveDirection(
      sub.plan,
      newPlan,
      sub.billingCycle,
      targetCycle,
      org.region,
    );

    if (!direction) {
      throw new ConflictException({
        statusCode: HttpStatus.CONFLICT,
        error: BILLING_ERROR.ALREADY_ON_PLAN,
        message: `You are already on ${newPlan.displayName} billed ${targetCycle.toLowerCase()}.`,
      });
    }

    const quantity = await this.resolveQuantity(org.id, newPlan.isPerSite);
    const priceData = await this.buildRecurringPriceData(newPlan, org.region, targetCycle);

    // Any decision supersedes a downgrade the org scheduled earlier.
    await this.releaseSchedule(sub.organisationId, sub.stripeScheduleId);

    return direction === 'UPGRADE'
      ? this.applyImmediateChange(sub, newPlan, targetCycle, priceData, quantity)
      : this.scheduleChangeAtPeriodEnd(sub, newPlan, targetCycle, priceData, quantity);
  }

  /** What the org would be charged today if it confirmed the change. */
  async previewPlanChange(caller: Jwtpayload, dto: ChangePlanDto) {
    const org = await this.assertBillableOrgAdmin(caller);
    const sub = await this.requireStripeSubscription(org.id);
    const newPlan = await this.assertPurchasablePlan(dto.planId, caller);

    const targetCycle = dto.billingCycle ?? sub.billingCycle;
    const direction = this.resolveDirection(
      sub.plan,
      newPlan,
      sub.billingCycle,
      targetCycle,
      org.region,
    );

    if (!direction) {
      throw new ConflictException({
        statusCode: HttpStatus.CONFLICT,
        error: BILLING_ERROR.ALREADY_ON_PLAN,
        message: `You are already on ${newPlan.displayName} billed ${targetCycle.toLowerCase()}.`,
      });
    }

    const quantity = await this.resolveQuantity(org.id, newPlan.isPerSite);
    const priceData = await this.buildRecurringPriceData(newPlan, org.region, targetCycle);
    const recurringAmount = ((priceData.unit_amount ?? 0) * quantity) / 100;
    const currency = priceData.currency.toUpperCase();

    // A downgrade bills nothing now — the whole point is that it waits.
    if (direction === 'DOWNGRADE') {
      return {
        direction,
        currency,
        amountDueToday: 0,
        recurringAmount,
        effectiveAt: sub.currentPeriodEnd,
        nextBillingDate: sub.currentPeriodEnd,
        planDisplayName: newPlan.displayName,
        billingCycle: targetCycle,
      };
    }

    const stripeSub = await this.stripeService.stripe.subscriptions.retrieve(
      sub.stripeSubscriptionId,
    );
    const itemId = stripeSub.items?.data?.[0]?.id;
    if (!itemId) {
      throw new BadRequestException('Your subscription has no billable item.');
    }

    // Same timing rules as applyImmediateChange: ending a trial already
    // anchors the first paid period to today, so billing_cycle_anchor would
    // conflict with the still-open trial_end.
    const isTrialing = stripeSub.status === 'trialing';
    const subscriptionDetails: Stripe.InvoiceCreatePreviewParams.SubscriptionDetails =
      isTrialing
        ? {
            items: [{ id: itemId, price_data: priceData, quantity }],
            trial_end: 'now',
            proration_behavior: 'none',
          }
        : {
            items: [{ id: itemId, price_data: priceData, quantity }],
            billing_cycle_anchor: 'now',
            proration_behavior: 'create_prorations',
          };

    let preview: Stripe.Invoice;
    try {
      preview = await this.stripeService.stripe.invoices.createPreview({
        customer: sub.stripeCustomerId ?? undefined,
        subscription: sub.stripeSubscriptionId,
        subscription_details: subscriptionDetails,
      });
    } catch (err) {
      this.throwFriendlyStripeError(err, 'Could not preview this plan change.');
    }

    return {
      direction,
      currency: (preview.currency ?? priceData.currency).toUpperCase(),
      amountDueToday: (preview.amount_due ?? 0) / 100,
      recurringAmount,
      effectiveAt: new Date(),
      nextBillingDate: preview.period_end ? new Date(preview.period_end * 1000) : null,
      planDisplayName: newPlan.displayName,
      billingCycle: targetCycle,
    };
  }

  /** Drops a scheduled downgrade so the org stays on its current plan. */
  async cancelPendingPlanChange(caller: Jwtpayload) {
    const org = await this.assertBillableOrgAdmin(caller);

    const sub = await this.prisma.orgSubscription.findUnique({
      where: { organisationId: org.id },
      include: { plan: true },
    });
    if (!sub?.pendingPlanId) {
      throw new NotFoundException('There is no scheduled plan change to cancel.');
    }

    await this.releaseSchedule(sub.organisationId, sub.stripeScheduleId);

    return {
      message: `Your plan change was cancelled. You stay on ${sub.plan.displayName}.`,
    };
  }

  private async applyImmediateChange(
    sub: { organisationId: number; stripeSubscriptionId: string },
    newPlan: SubscriptionPlan,
    billingCycle: BillingCycle,
    priceData: Stripe.SubscriptionUpdateParams.Item.PriceData,
    quantity: number,
  ) {
    const stripeSub = await this.stripeService.stripe.subscriptions.retrieve(
      sub.stripeSubscriptionId,
    );
    const itemId = stripeSub.items?.data?.[0]?.id;
    if (!itemId) {
      throw new BadRequestException('Your subscription has no billable item to change.');
    }

    // Ending a trial anchors the first paid period to today on its own, so
    // setting billing_cycle_anchor as well would conflict.
    const timing: Stripe.SubscriptionUpdateParams =
      stripeSub.status === 'trialing'
        ? { trial_end: 'now', proration_behavior: 'none' }
        : { billing_cycle_anchor: 'now', proration_behavior: 'always_invoice' };

    let updated: Stripe.Subscription;
    try {
      updated = await this.stripeService.stripe.subscriptions.update(
        sub.stripeSubscriptionId,
        {
          items: [{ id: itemId, price_data: priceData, quantity }],
          ...timing,
          metadata: {
            orgId: String(sub.organisationId),
            planId: String(newPlan.id),
            billingCycle,
          },
        },
      );
    } catch (err) {
      this.throwFriendlyStripeError(err, 'Could not upgrade your plan right now.');
    }

    // Written now rather than waiting on the webhook so the client can render
    // the new plan the moment it refetches.
    await this.prisma.orgSubscription.update({
      where: { organisationId: sub.organisationId },
      data: {
        planId: newPlan.id,
        billingCycle,
        quantity,
        pendingPlanId: null,
        pendingBillingCycle: null,
        pendingChangeEffectiveAt: null,
      },
    });

    const periodEnd = readItemPeriodEnd(updated);
    this.logger.log(
      `Plan upgraded immediately: org=${sub.organisationId} plan=${newPlan.name} ` +
        `cycle=${billingCycle} qty=${quantity}`,
    );

    return {
      type: 'UPGRADED' as const,
      planId: newPlan.id,
      planDisplayName: newPlan.displayName,
      billingCycle,
      effectiveAt: new Date(),
      nextBillingDate: periodEnd,
      message: `You're now on ${newPlan.displayName}. Your new billing cycle starts today.`,
    };
  }

  private async scheduleChangeAtPeriodEnd(
    sub: { organisationId: number; stripeSubscriptionId: string },
    newPlan: SubscriptionPlan,
    billingCycle: BillingCycle,
    priceData: Stripe.SubscriptionUpdateParams.Item.PriceData,
    quantity: number,
  ) {
    const stripe = this.stripeService.stripe;

    let schedule: Stripe.SubscriptionSchedule;
    try {
      schedule = await stripe.subscriptionSchedules.create({
        from_subscription: sub.stripeSubscriptionId,
      });
    } catch (err) {
      this.throwFriendlyStripeError(err, 'Could not schedule this plan change.');
    }

    const currentPhase = schedule.phases?.[0];
    if (!currentPhase?.end_date) {
      throw new BadRequestException(
        'Your subscription has no billing period end, so a change cannot be scheduled.',
      );
    }

    // Phase one replays what the org already paid for; phase two swaps the
    // price in the moment that period closes. `release` hands the subscription
    // back to normal renewal afterwards.
    let updated: Stripe.SubscriptionSchedule;
    try {
      updated = await stripe.subscriptionSchedules.update(schedule.id, {
        end_behavior: 'release',
        phases: [
          {
            items: currentPhase.items.map((item) => ({
              price: typeof item.price === 'string' ? item.price : item.price.id,
              quantity: item.quantity ?? 1,
            })),
            start_date: currentPhase.start_date,
            end_date: currentPhase.end_date,
            proration_behavior: 'none',
          },
          {
            items: [{ price_data: priceData, quantity }],
            // One period on the new price, after which the schedule releases and
            // the subscription renews normally.
            duration: { interval: priceData.recurring.interval, interval_count: 1 },
            proration_behavior: 'none',
            metadata: {
              orgId: String(sub.organisationId),
              planId: String(newPlan.id),
              billingCycle,
            },
          },
        ],
      });
    } catch (err) {
      this.throwFriendlyStripeError(err, 'Could not schedule this plan change.');
    }

    const effectiveAt = new Date(currentPhase.end_date * 1000);

    await this.prisma.orgSubscription.update({
      where: { organisationId: sub.organisationId },
      data: {
        pendingPlanId: newPlan.id,
        pendingBillingCycle: billingCycle,
        pendingChangeEffectiveAt: effectiveAt,
        stripeScheduleId: updated.id,
      },
    });

    this.logger.log(
      `Plan downgrade scheduled: org=${sub.organisationId} plan=${newPlan.name} ` +
        `effective=${effectiveAt.toISOString()} schedule=${updated.id}`,
    );

    return {
      type: 'SCHEDULED' as const,
      planId: newPlan.id,
      planDisplayName: newPlan.displayName,
      billingCycle,
      effectiveAt,
      nextBillingDate: effectiveAt,
      message:
        `You'll move to ${newPlan.displayName} on ` +
        `${effectiveAt.toDateString()}. Nothing is charged today.`,
    };
  }

  /** Stripe-hosted billing portal for card updates, invoices and cancellation. */
  async createPortalSession(caller: Jwtpayload) {
    const org = await this.assertBillableOrgAdmin(caller);

    const subscription = await this.prisma.orgSubscription.findUnique({
      where: { organisationId: org.id },
    });
    if (!subscription?.stripeCustomerId) {
      throw new NotFoundException('No billing account found for your organisation.');
    }

    const appUrl = this.websiteOrigin();
    const session = await this.stripeService.stripe.billingPortal.sessions.create({
      customer: subscription.stripeCustomerId,
      return_url: `${appUrl}/business/plans`,
    });

    return { portalUrl: session.url };
  }

  /** Cancels at period end so the org keeps access until it has paid through. */
  async cancelSubscription(caller: Jwtpayload) {
    const org = await this.assertBillableOrgAdmin(caller);

    const subscription = await this.prisma.orgSubscription.findUnique({
      where: { organisationId: org.id },
    });
    if (!subscription) {
      throw new NotFoundException('No subscription to cancel.');
    }

    // A scheduled downgrade would otherwise keep the subscription alive past
    // the cancellation date.
    await this.releaseSchedule(org.id, subscription.stripeScheduleId);

    // A local trial has no Stripe object behind it.
    if (!subscription.stripeSubscriptionId) {
      await this.prisma.orgSubscription.update({
        where: { organisationId: org.id },
        data: {
          status: SubscriptionStatus.CANCELLED,
          cancelledAt: new Date(),
          cancelAtPeriodEnd: false,
        },
      });
      return { message: 'Your trial has been cancelled.' };
    }

    try {
      await this.stripeService.stripe.subscriptions.update(
        subscription.stripeSubscriptionId,
        { cancel_at_period_end: true },
      );
    } catch (err) {
      this.throwFriendlyStripeError(err, 'Could not cancel your plan right now.');
    }

    await this.prisma.orgSubscription.update({
      where: { organisationId: org.id },
      data: { cancelAtPeriodEnd: true, cancelledAt: new Date() },
    });

    return {
      message: 'Your subscription will end at the close of the current billing period.',
      accessUntil: subscription.currentPeriodEnd,
    };
  }

  /**
   * Undoes a scheduled cancellation while the paid period is still running.
   * Cancelling only flags the subscription, so nothing has to be rebuilt — the
   * flag is simply cleared and billing resumes on its original date.
   */
  async resumeSubscription(caller: Jwtpayload) {
    const org = await this.assertBillableOrgAdmin(caller);

    const subscription = await this.prisma.orgSubscription.findUnique({
      where: { organisationId: org.id },
      include: { plan: { select: { displayName: true } } },
    });
    if (!subscription) {
      throw new NotFoundException('No subscription to resume.');
    }
    if (!subscription.cancelAtPeriodEnd) {
      throw new ConflictException('Your subscription is not scheduled to cancel.');
    }

    // A cancelled local trial has no Stripe object to revive; it must be
    // repurchased through Checkout.
    if (!subscription.stripeSubscriptionId) {
      throw new ConflictException(
        'This subscription cannot be resumed. Please choose a plan to start again.',
      );
    }

    try {
      await this.stripeService.stripe.subscriptions.update(
        subscription.stripeSubscriptionId,
        { cancel_at_period_end: false },
      );
    } catch (err) {
      this.throwFriendlyStripeError(err, 'Could not resume your plan right now.');
    }

    await this.prisma.orgSubscription.update({
      where: { organisationId: org.id },
      data: { cancelAtPeriodEnd: false, cancelledAt: null },
    });

    this.logger.log(`Subscription resumed: org=${org.id}`);

    return {
      message: `Your ${subscription.plan.displayName} plan will continue as normal.`,
      nextBillingDate: subscription.currentPeriodEnd,
    };
  }

  // ─── Billing history ───────────────────────────────────────────────────────
  async listPayments(caller: Jwtpayload) {
    if (!caller.orgId) throw new ForbiddenException('Not part of an organisation');

    const payments = await this.prisma.payment.findMany({
      where: { organisationId: caller.orgId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return payments.map((p) => ({
      id: p.id,
      amount: p.amountCents / 100,
      currency: p.currency,
      status: p.status,
      description: p.description,
      invoiceUrl: p.hostedInvoiceUrl,
      invoicePdf: p.invoicePdfUrl,
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      paidAt: p.paidAt,
      createdAt: p.createdAt,
    }));
  }

  // ─── Enterprise (no checkout — sales lead) ─────────────────────────────────

  async submitEnterpriseEnquiry(caller: Jwtpayload, dto: EnterpriseEnquiryDto) {
    const enquiry = await this.prisma.enterpriseEnquiry.create({
      data: {
        organisationId: caller.orgId ?? null,
        firstName: dto.firstName,
        lastName: dto.lastName,
        businessName: dto.businessName,
        businessType: dto.businessType,
        mobile: dto.mobile,
        locationBand: dto.locationBand,
        contactWindow: dto.contactWindow,
        message: dto.message,
      },
    });

    this.logger.log(
      `Enterprise enquiry ${enquiry.id} from org=${caller.orgId ?? 'n/a'} (${dto.businessName})`,
    );

    return {
      message: "Thanks! We've received your request.",
      detail: 'A Saveful Enterprise Specialist will contact you within one business day.',
      enquiryId: enquiry.id,
    };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /** Per-site plans bill on the number of locations the org actually has. */
  private async resolveQuantity(orgId: number, isPerSite: boolean): Promise<number> {
    if (!isPerSite) return 1;
    const siteCount = await this.prisma.site.count({ where: { organisationId: orgId } });
    return Math.max(1, siteCount);
  }

  /**
   * Pushes the real site count onto a per-site subscription. Called after a
   * site is added; billing must never be the reason a site fails to save, so
   * every failure is logged rather than thrown.
   */
  async syncSiteQuantity(orgId: number): Promise<void> {
    try {
      const sub = await this.prisma.orgSubscription.findUnique({
        where: { organisationId: orgId },
        include: { plan: { select: { isPerSite: true } } },
      });

      if (!sub?.plan.isPerSite) return;
      if (!sub.stripeSubscriptionId) return;
      if (!LIVE_STATUSES.includes(sub.status)) return;

      const quantity = await this.resolveQuantity(orgId, true);
      if (quantity === sub.quantity) return;

      const itemId = await this.currentItemId(sub.stripeSubscriptionId);
      await this.stripeService.stripe.subscriptions.update(sub.stripeSubscriptionId, {
        items: [{ id: itemId, quantity }],
        proration_behavior: 'create_prorations',
      });

      await this.prisma.orgSubscription.update({
        where: { organisationId: orgId },
        data: { quantity },
      });

      this.logger.log(`Per-site quantity synced: org=${orgId} qty=${quantity}`);
    } catch (err) {
      this.logger.error(
        `Failed to sync per-site quantity for org=${orgId}: ${(err as Error).message}`,
      );
    }
  }

  /** Region-aware price for a plan and cycle, in the shape Stripe wants. */
  private async buildRecurringPriceData(
    plan: SubscriptionPlan,
    region: Region | null,
    billingCycle: BillingCycle,
  ): Promise<Stripe.SubscriptionUpdateParams.Item.PriceData> {
    const currency = currencyForRegion(region);
    const isInr = currency === STRIPE_CURRENCY_INR;
    const isAnnual = billingCycle === BillingCycle.ANNUAL;

    const amount = isAnnual
      ? (isInr ? plan.priceAnnualInr : plan.priceAnnual)
      : (isInr ? plan.priceMonthlyInr : plan.priceMonthly);

    if (amount === null || amount === undefined) {
      throw new BadRequestException(
        `The ${plan.displayName} plan has no ${currency.toUpperCase()} ` +
          `${billingCycle.toLowerCase()} price configured.`,
      );
    }

    return {
      currency,
      product: await this.ensureStripeProduct(plan),
      unit_amount: Math.round(amount * 100),
      recurring: { interval: isAnnual ? 'year' : 'month' },
    };
  }

  /**
   * Subscription items can only reference a real Product, so each plan gets one
   * on first use and the id is cached on the plan row.
   */
  private async ensureStripeProduct(plan: SubscriptionPlan): Promise<string> {
    if (plan.stripeProductId) {
      try {
        const existing = await this.stripeService.stripe.products.retrieve(
          plan.stripeProductId,
        );
        if (!existing.deleted) return existing.id;
      } catch {
        this.logger.warn(
          `Stripe product ${plan.stripeProductId} not retrievable — recreating for ${plan.name}`,
        );
      }
    }

    const product = await this.stripeService.stripe.products.create({
      name: `Saveful — ${plan.displayName}`,
      metadata: { planId: String(plan.id), planName: plan.name },
    });

    await this.prisma.subscriptionPlan.update({
      where: { id: plan.id },
      data: { stripeProductId: product.id },
    });

    return product.id;
  }

  /**
   * Tier is compared on the monthly list price so the answer does not depend on
   * which cycle either side is billed at. When the tier is unchanged, moving to
   * annual is a prepayment (immediate) and moving to monthly is a step down.
   */
  private resolveDirection(
    currentPlan: SubscriptionPlan,
    newPlan: SubscriptionPlan,
    currentCycle: BillingCycle,
    newCycle: BillingCycle,
    region: Region | null,
  ): ChangeDirection | null {
    const tierDelta = this.tierAmount(newPlan, region) - this.tierAmount(currentPlan, region);
    if (tierDelta > 0) return 'UPGRADE';
    if (tierDelta < 0) return 'DOWNGRADE';

    if (currentCycle === newCycle) return null;
    return newCycle === BillingCycle.ANNUAL ? 'UPGRADE' : 'DOWNGRADE';
  }

  private tierAmount(plan: SubscriptionPlan, region: Region | null): number {
    const isInr = currencyForRegion(region) === STRIPE_CURRENCY_INR;
    return (isInr ? plan.priceMonthlyInr : plan.priceMonthly) ?? 0;
  }

  private async currentItemId(stripeSubscriptionId: string): Promise<string> {
    const sub = await this.stripeService.stripe.subscriptions.retrieve(stripeSubscriptionId);
    const itemId = sub.items?.data?.[0]?.id;
    if (!itemId) {
      throw new BadRequestException('Your subscription has no billable item.');
    }
    return itemId;
  }

  /**
   * Stripe's own error copy is full of parameter names and unix timestamps —
   * never safe to show a business owner. Log the raw message, then surface a
   * short sentence they can act on.
   */
  private throwFriendlyStripeError(err: unknown, fallback: string): never {
    const stripeMessage =
      err && typeof err === 'object' && 'message' in err
        ? String((err as { message?: unknown }).message ?? '')
        : '';
    this.logger.error(`Stripe billing failure: ${stripeMessage || String(err)}`);

    const lower = stripeMessage.toLowerCase();
    if (lower.includes('trial') && lower.includes('billing_cycle_anchor')) {
      throw new BadRequestException(
        'We could not change your plan while your free trial is still active. Please try again, or contact support if this keeps happening.',
      );
    }
    if (lower.includes('card') || lower.includes('payment') || lower.includes('insufficient')) {
      throw new BadRequestException(
        'Your card could not be charged. Please update your payment method and try again.',
      );
    }
    if (lower.includes('no such subscription') || lower.includes('resource_missing')) {
      throw new BadRequestException(
        'We could not find your subscription. Please contact support or choose a plan again.',
      );
    }

    throw new BadRequestException(fallback);
  }

  /** Releases a Stripe schedule (if any) and clears the local pending change. */
  private async releaseSchedule(orgId: number, scheduleId: string | null): Promise<void> {
    if (scheduleId) {
      try {
        await this.stripeService.stripe.subscriptionSchedules.release(scheduleId);
      } catch (err) {
        // Already released or completed — the local cleanup below still applies.
        this.logger.warn(
          `Could not release schedule ${scheduleId}: ${(err as Error).message}`,
        );
      }
    }

    await this.prisma.orgSubscription.update({
      where: { organisationId: orgId },
      data: {
        pendingPlanId: null,
        pendingBillingCycle: null,
        pendingChangeEffectiveAt: null,
        stripeScheduleId: null,
      },
    });
  }

  /**
   * Blocks a second Checkout while a Stripe subscription is already live. Rows
   * left by the old card-free trial have no Stripe object behind them, so they
   * are allowed through — Checkout is how they convert.
   */
  private async assertNoLiveSubscription(orgId: number): Promise<void> {
    const sub = await this.prisma.orgSubscription.findUnique({
      where: { organisationId: orgId },
      include: { plan: { select: { displayName: true } } },
    });

    if (!sub?.stripeSubscriptionId) return;
    if (!LIVE_STATUSES.includes(sub.status)) return;

    throw new ConflictException({
      statusCode: HttpStatus.CONFLICT,
      error: BILLING_ERROR.PLAN_CHANGE_REQUIRED,
      message:
        `Your organisation is already on ${sub.plan.displayName}. ` +
        'Switch plans instead of starting a new subscription.',
      currentPlanId: sub.planId,
      status: sub.status,
    });
  }

  private async requireStripeSubscription(orgId: number) {
    const sub = await this.prisma.orgSubscription.findUnique({
      where: { organisationId: orgId },
      include: { plan: true },
    });

    if (!sub || !LIVE_STATUSES.includes(sub.status) || !sub.stripeSubscriptionId) {
      throw new ConflictException({
        statusCode: HttpStatus.CONFLICT,
        error: BILLING_ERROR.NO_ACTIVE_SUBSCRIPTION,
        message: 'You have no active subscription to change. Please choose a plan.',
      });
    }

    return { ...sub, stripeSubscriptionId: sub.stripeSubscriptionId };
  }

  private async assertBillableOrgAdmin(caller: Jwtpayload) {
    if (!caller.orgId) throw new ForbiddenException('Not part of an organisation');

    if (!requiresBilling(caller.orgType)) {
      throw new ForbiddenException(
        'Your organisation has free lifetime access — no subscription is required.',
      );
    }

    if (caller.orgRole !== OrgRole.SUPER_ADMIN) {
      throw new ForbiddenException('Only an organisation admin can manage billing.');
    }

    const org = await this.prisma.organisation.findUnique({
      where: { id: caller.orgId },
    });
    if (!org) throw new NotFoundException('Organisation not found');
    return org;
  }

  private async assertPurchasablePlan(planId: number, caller: Jwtpayload) {
    const plan = await this.prisma.subscriptionPlan.findUnique({ where: { id: planId } });
    if (!plan || !plan.isActive) throw new NotFoundException('Plan not found');

    if (plan.contactSalesOnly) {
      throw new BadRequestException(
        'The Enterprise plan is quote-based. Please submit an enterprise enquiry instead.',
      );
    }

    if (caller.orgType && !plan.applicableOrgTypes.includes(caller.orgType)) {
      throw new ForbiddenException('That plan is not available for your organisation type.');
    }

    return plan;
  }

  /** Checkout and portal return to the website, not the API host. */
  private websiteOrigin() {
    const frontend = this.config.get<string>('FRONTEND_URL')?.trim().replace(/\/$/, '');
    const app = this.config.get<string>('APP_URL', 'http://localhost:3000').replace(/\/$/, '');
    return frontend || app;
  }
}
