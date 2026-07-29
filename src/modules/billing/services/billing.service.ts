import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BillingCycle, OrgRole, SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import { requiresBilling } from '../../subscriptions/subscription.constants';
import {
  CreateCheckoutSessionDto,
  EnterpriseEnquiryDto,
  StartTrialDto,
} from '../dto/billing.dto';
import { currencyForRegion, StripeService } from './stripe.service';

const TRIAL_DAYS = 30;

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
    private readonly config: ConfigService,
  ) {}

  // ─── Free trial (no card, handled entirely locally) ────────────────────────

  /**
   * Starts the 30-day trial. No Stripe involvement — the design collects no
   * card, so there is nothing for Stripe to hold. When the trial lapses the
   * org is blocked until it completes Checkout.
   */
  async startFreeTrial(caller: Jwtpayload, dto: StartTrialDto) {
    const org = await this.assertBillableOrgAdmin(caller);

    if (org.freeTrialUsedAt) {
      throw new ConflictException(
        'Your organisation has already used its free trial. Please choose a paid plan.',
      );
    }

    const existing = await this.prisma.orgSubscription.findUnique({
      where: { organisationId: org.id },
    });
    if (existing) {
      throw new ConflictException('Your organisation already has a subscription.');
    }

    const plan = await this.assertPurchasablePlan(dto.planId, caller);

    const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);

    const [subscription] = await this.prisma.$transaction([
      this.prisma.orgSubscription.create({
        data: {
          organisationId: org.id,
          planId: plan.id,
          status: SubscriptionStatus.TRIALING,
          billingCycle: BillingCycle.MONTHLY,
          trialEndsAt,
          quantity: await this.resolveQuantity(org.id, plan.isPerSite),
        },
      }),
      this.prisma.organisation.update({
        where: { id: org.id },
        data: { freeTrialUsedAt: new Date() },
      }),
    ]);

    this.logger.log(
      `Trial started: org=${org.id} plan=${plan.name} ends=${trialEndsAt.toISOString()}`,
    );

    return {
      message: `Your ${TRIAL_DAYS}-day free trial has started.`,
      subscription: {
        planName: plan.name,
        planDisplayName: plan.displayName,
        status: subscription.status,
        trialEndsAt,
      },
    };
  }

  // ─── Paid checkout (Stripe hosted redirect) ────────────────────────────────

  async createCheckoutSession(caller: Jwtpayload, dto: CreateCheckoutSessionDto) {
    const org = await this.assertBillableOrgAdmin(caller);
    const plan = await this.assertPurchasablePlan(dto.planId, caller);

    const priceId =
      dto.billingCycle === BillingCycle.ANNUAL
        ? plan.stripePriceIdAnnual
        : plan.stripePriceIdMonthly;

    if (!priceId) {
      throw new BadRequestException(
        `The ${plan.displayName} plan is not yet available for purchase. ` +
          'Run the Stripe catalogue sync first.',
      );
    }

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
    const appUrl = this.config.get<string>('APP_URL', 'http://localhost:3000');

    // India bills in INR, every other region in AUD. Both amounts live on the
    // same Stripe Price as currency_options, so the price id does not change.
    const currency = currencyForRegion(org.region);
    const inrConfigured = plan.priceMonthlyInr !== null || plan.priceAnnualInr !== null;
    if (currency !== 'aud' && !inrConfigured) {
      throw new BadRequestException(
        `The ${plan.displayName} plan has no ${currency.toUpperCase()} pricing configured.`,
      );
    }

    const session = await this.stripeService.stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: String(org.id),
      currency,
      line_items: [{ price: priceId, quantity }],
      success_url: `${appUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/billing/cancelled`,
      allow_promotion_codes: true,
      subscription_data: {
        metadata: {
          orgId: String(org.id),
          planId: String(plan.id),
          billingCycle: dto.billingCycle,
        },
      },
      metadata: {
        orgId: String(org.id),
        planId: String(plan.id),
        billingCycle: dto.billingCycle,
      },
    });

    this.logger.log(
      `Checkout session ${session.id} created: org=${org.id} plan=${plan.name} ` +
        `cycle=${dto.billingCycle} qty=${quantity} currency=${currency}`,
    );

    return {
      checkoutUrl: session.url,
      sessionId: session.id,
      currency: currency.toUpperCase(),
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

    const appUrl = this.config.get<string>('APP_URL', 'http://localhost:3000');
    const session = await this.stripeService.stripe.billingPortal.sessions.create({
      customer: subscription.stripeCustomerId,
      return_url: `${appUrl}/billing`,
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

    await this.stripeService.stripe.subscriptions.update(
      subscription.stripeSubscriptionId,
      { cancel_at_period_end: true },
    );

    await this.prisma.orgSubscription.update({
      where: { organisationId: org.id },
      data: { cancelAtPeriodEnd: true, cancelledAt: new Date() },
    });

    return {
      message: 'Your subscription will end at the close of the current billing period.',
      accessUntil: subscription.currentPeriodEnd,
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
}
