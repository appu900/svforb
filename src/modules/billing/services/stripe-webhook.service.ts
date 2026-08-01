import { Injectable, Logger } from '@nestjs/common';
import { PaymentStatus, SubscriptionStatus } from '@prisma/client';
import Stripe = require('stripe');
import { PrismaService } from '../../../infra/prisma/prisma.service';

/** Stripe subscription status -> our SubscriptionStatus. */
function mapStatus(status: Stripe.Subscription.Status): SubscriptionStatus {
  switch (status) {
    case 'trialing':
      return SubscriptionStatus.TRIALING;
    case 'active':
      return SubscriptionStatus.ACTIVE;
    case 'past_due':
    case 'unpaid':
    case 'incomplete':
      return SubscriptionStatus.PAST_DUE;
    case 'canceled':
      return SubscriptionStatus.CANCELLED;
    case 'incomplete_expired':
    case 'paused':
    default:
      return SubscriptionStatus.EXPIRED;
  }
}

function toDate(unixSeconds?: number | null): Date | null {
  return unixSeconds ? new Date(unixSeconds * 1000) : null;
}

/**
 * Billing period moved off Subscription and onto its items in recent Stripe API
 * versions (this SDK targets v2324). Read the item first, fall back to the root
 * so the handler survives either shape.
 */
function readPeriod(sub: Stripe.Subscription): { start: Date | null; end: Date | null } {
  const item = sub.items?.data?.[0] as unknown as
    | { current_period_start?: number; current_period_end?: number }
    | undefined;
  const legacy = sub as unknown as {
    current_period_start?: number;
    current_period_end?: number;
  };

  return {
    start: toDate(item?.current_period_start ?? legacy.current_period_start),
    end: toDate(item?.current_period_end ?? legacy.current_period_end),
  };
}

/** Subscription reference likewise moved under `parent.subscription_details`. */
function readInvoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const inv = invoice as unknown as {
    subscription?: string | { id: string } | null;
    parent?: { subscription_details?: { subscription?: string | { id: string } | null } };
  };

  const candidate =
    inv.parent?.subscription_details?.subscription ?? inv.subscription ?? null;

  if (!candidate) return null;
  return typeof candidate === 'string' ? candidate : candidate.id;
}

@Injectable()
export class StripeWebhookService {
  private readonly logger = new Logger(StripeWebhookService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records the event id first and bails if it was already processed. Stripe
   * retries on any non-2xx, so without this a repeat delivery would double-write.
   */
  async handleEvent(event: Stripe.Event): Promise<{ received: true; duplicate?: true }> {
    try {
      await this.prisma.stripeWebhookEvent.create({
        data: { stripeEventId: event.id, type: event.type },
      });
    } catch {
      this.logger.log(`Duplicate Stripe event ${event.id} (${event.type}) — ignoring`);
      return { received: true, duplicate: true };
    }

    try {
      switch (event.type) {
        case 'checkout.session.completed':
          await this.onCheckoutCompleted(event.data.object);
          break;

        case 'customer.subscription.created':
        case 'customer.subscription.updated':
          await this.onSubscriptionChanged(event.data.object);
          break;

        case 'customer.subscription.deleted':
          await this.onSubscriptionDeleted(event.data.object);
          break;

        case 'invoice.paid':
        case 'invoice.payment_succeeded':
          await this.onInvoicePaid(event.data.object);
          break;

        case 'invoice.payment_failed':
          await this.onInvoiceFailed(event.data.object);
          break;

        case 'subscription_schedule.released':
        case 'subscription_schedule.completed':
        case 'subscription_schedule.canceled':
          await this.onScheduleFinished(event.data.object);
          break;

        default:
          this.logger.debug(`Unhandled Stripe event type: ${event.type}`);
      }
    } catch (err) {
      // Roll back the idempotency marker so Stripe's retry can succeed.
      await this.prisma.stripeWebhookEvent
        .delete({ where: { stripeEventId: event.id } })
        .catch(() => undefined);
      throw err;
    }

    return { received: true };
  }

  // ─── Handlers ──────────────────────────────────────────────────────────────

  private async onCheckoutCompleted(session: Stripe.Checkout.Session) {
    const orgId = Number(session.metadata?.orgId ?? session.client_reference_id);
    const planId = Number(session.metadata?.planId);

    if (!orgId || !planId) {
      this.logger.warn(`checkout.session.completed ${session.id} missing orgId/planId metadata`);
      return;
    }

    const subscriptionId =
      typeof session.subscription === 'string'
        ? session.subscription
        : session.subscription?.id;

    const customerId =
      typeof session.customer === 'string' ? session.customer : session.customer?.id;

    const billingCycle = session.metadata?.billingCycle === 'ANNUAL' ? 'ANNUAL' : 'MONTHLY';
    const isTrial = session.metadata?.isTrial === 'true';

    // A trial subscription is TRIALING until Stripe charges it; the follow-up
    // customer.subscription.* event confirms whichever it ends up being.
    const status = isTrial ? SubscriptionStatus.TRIALING : SubscriptionStatus.ACTIVE;

    await this.prisma.orgSubscription.upsert({
      where: { organisationId: orgId },
      create: {
        organisationId: orgId,
        planId,
        status,
        billingCycle,
        stripeCustomerId: customerId ?? null,
        stripeSubscriptionId: subscriptionId ?? null,
      },
      update: {
        planId,
        status,
        billingCycle,
        stripeCustomerId: customerId ?? null,
        stripeSubscriptionId: subscriptionId ?? null,
        cancelAtPeriodEnd: false,
        cancelledAt: null,
        pendingPlanId: null,
        pendingBillingCycle: null,
        pendingChangeEffectiveAt: null,
        stripeScheduleId: null,
      },
    });

    // Stamped here rather than when the session was created, so abandoning
    // Checkout does not consume the organisation's one trial.
    if (isTrial) {
      await this.prisma.organisation.update({
        where: { id: orgId },
        data: { freeTrialUsedAt: new Date() },
      });
    }

    this.logger.log(
      `Checkout completed: org=${orgId} plan=${planId} sub=${subscriptionId} trial=${isTrial}`,
    );
  }

  private async onSubscriptionChanged(sub: Stripe.Subscription) {
    const row = await this.resolveSubscriptionRow(sub);
    if (!row) return;

    const { start, end } = readPeriod(sub);
    const quantity = sub.items?.data?.[0]?.quantity ?? 1;

    // A scheduled downgrade lands as an ordinary subscription update, so the
    // pending plan is promoted once its effective date has passed.
    const pendingLanded =
      row.pendingPlanId !== null &&
      row.pendingChangeEffectiveAt !== null &&
      row.pendingChangeEffectiveAt.getTime() <= Date.now();

    await this.prisma.orgSubscription.update({
      where: { organisationId: row.organisationId },
      data: {
        status: mapStatus(sub.status),
        currentPeriodStart: start,
        currentPeriodEnd: end,
        quantity,
        cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
        trialEndsAt: toDate(sub.trial_end),
        stripeSubscriptionId: sub.id,
        stripePriceId: sub.items?.data?.[0]?.price?.id ?? null,
        ...(pendingLanded
          ? {
              planId: row.pendingPlanId!,
              billingCycle: row.pendingBillingCycle ?? row.billingCycle,
              pendingPlanId: null,
              pendingBillingCycle: null,
              pendingChangeEffectiveAt: null,
              stripeScheduleId: null,
            }
          : {}),
      },
    });

    this.logger.log(
      `Subscription ${sub.id} -> ${sub.status} (org=${row.organisationId}, qty=${quantity}, ` +
        `ends=${end?.toISOString() ?? 'n/a'}${pendingLanded ? ', pending change applied' : ''})`,
    );
  }

  /**
   * Resolves the row this event belongs to. Matching on the subscription id
   * first matters: if an organisation ever ends up with two Stripe
   * subscriptions, events from the stale one must not overwrite the live row.
   */
  private async resolveSubscriptionRow(sub: Stripe.Subscription) {
    const byId = await this.prisma.orgSubscription.findFirst({
      where: { stripeSubscriptionId: sub.id },
    });
    if (byId) return byId;

    const orgId = Number(sub.metadata?.orgId);
    if (!orgId) {
      this.logger.warn(`Subscription ${sub.id} has no resolvable organisation — skipping`);
      return null;
    }

    const byOrg = await this.prisma.orgSubscription.findUnique({
      where: { organisationId: orgId },
    });
    if (!byOrg) {
      this.logger.warn(`Subscription ${sub.id} references unknown org ${orgId} — skipping`);
      return null;
    }

    if (byOrg.stripeSubscriptionId && byOrg.stripeSubscriptionId !== sub.id) {
      this.logger.warn(
        `Ignoring event for subscription ${sub.id}: org ${orgId} is on ` +
          `${byOrg.stripeSubscriptionId}. The stale subscription should be cancelled in Stripe.`,
      );
      return null;
    }

    return byOrg;
  }

  /** The deferred change has run its course — drop the local schedule handle. */
  private async onScheduleFinished(schedule: Stripe.SubscriptionSchedule) {
    const result = await this.prisma.orgSubscription.updateMany({
      where: { stripeScheduleId: schedule.id },
      data: { stripeScheduleId: null },
    });
    this.logger.log(
      `Schedule ${schedule.id} ${schedule.status} (${result.count} row(s) cleared)`,
    );
  }

  private async onSubscriptionDeleted(sub: Stripe.Subscription) {
    const result = await this.prisma.orgSubscription.updateMany({
      where: { stripeSubscriptionId: sub.id },
      data: {
        status: SubscriptionStatus.CANCELLED,
        cancelledAt: new Date(),
        cancelAtPeriodEnd: false,
      },
    });
    this.logger.log(`Subscription ${sub.id} cancelled (${result.count} row(s) updated)`);
  }

  private async onInvoicePaid(invoice: Stripe.Invoice) {
    const orgId = await this.resolveOrgIdFromInvoice(invoice);
    if (!orgId || !invoice.id) return;

    await this.recordPayment(invoice, orgId, PaymentStatus.PAID);

    const subscriptionId = readInvoiceSubscriptionId(invoice);
    if (subscriptionId) {
      await this.prisma.orgSubscription.updateMany({
        where: { stripeSubscriptionId: subscriptionId },
        data: { status: SubscriptionStatus.ACTIVE },
      });
    }

    this.logger.log(`Invoice ${invoice.id} paid for org=${orgId}`);
  }

  private async onInvoiceFailed(invoice: Stripe.Invoice) {
    const orgId = await this.resolveOrgIdFromInvoice(invoice);
    if (!orgId || !invoice.id) return;

    await this.recordPayment(invoice, orgId, PaymentStatus.FAILED);

    const subscriptionId = readInvoiceSubscriptionId(invoice);
    if (subscriptionId) {
      await this.prisma.orgSubscription.updateMany({
        where: { stripeSubscriptionId: subscriptionId },
        data: { status: SubscriptionStatus.PAST_DUE },
      });
    }

    this.logger.warn(`Invoice ${invoice.id} payment failed for org=${orgId}`);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async resolveOrgIdFromInvoice(invoice: Stripe.Invoice): Promise<number | null> {
    const customerId =
      typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;

    if (customerId) {
      const sub = await this.prisma.orgSubscription.findFirst({
        where: { stripeCustomerId: customerId },
        select: { organisationId: true },
      });
      if (sub) return sub.organisationId;
    }

    const subscriptionId = readInvoiceSubscriptionId(invoice);
    if (subscriptionId) {
      const sub = await this.prisma.orgSubscription.findFirst({
        where: { stripeSubscriptionId: subscriptionId },
        select: { organisationId: true },
      });
      if (sub) return sub.organisationId;
    }

    this.logger.warn(`Could not resolve organisation for invoice ${invoice.id}`);
    return null;
  }

  private async recordPayment(
    invoice: Stripe.Invoice,
    organisationId: number,
    status: PaymentStatus,
  ) {
    const paymentIntent = (invoice as unknown as { payment_intent?: string | { id: string } })
      .payment_intent;

    const data = {
      organisationId,
      stripeInvoiceId: invoice.id!,
      stripePaymentIntentId:
        typeof paymentIntent === 'string' ? paymentIntent : (paymentIntent?.id ?? null),
      stripeSubscriptionId: readInvoiceSubscriptionId(invoice),
      amountCents: invoice.amount_paid || invoice.amount_due || 0,
      currency: (invoice.currency ?? 'aud').toUpperCase(),
      status,
      description: invoice.lines?.data?.[0]?.description ?? null,
      hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
      invoicePdfUrl: invoice.invoice_pdf ?? null,
      periodStart: toDate(invoice.period_start),
      periodEnd: toDate(invoice.period_end),
      paidAt: status === PaymentStatus.PAID ? new Date() : null,
    };

    await this.prisma.payment.upsert({
      where: { stripeInvoiceId: invoice.id! },
      create: data,
      update: data,
    });
  }
}
