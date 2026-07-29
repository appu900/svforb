import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { STRIPE_CURRENCY, STRIPE_CURRENCY_INR, StripeService } from './stripe.service';

/** Converts a major-unit amount to the smallest unit Stripe expects. */
function toCents(amount: number): number {
  return Math.round(amount * 100);
}

/**
 * INR pricing rides on the same Price object as a currency option, so India
 * checkouts reuse the existing price id rather than needing a second one.
 */
function inrOption(amountInr: number | null) {
  return amountInr === null
    ? undefined
    : { [STRIPE_CURRENCY_INR]: { unit_amount: toCents(amountInr) } };
}

/**
 * Mirrors the local plan catalogue into Stripe.
 *
 * Idempotent: a plan that already holds a Stripe product/price id is left
 * alone, so re-running only fills gaps. Enterprise is skipped — it is
 * quote-based and never charged through Checkout.
 */
@Injectable()
export class StripeCatalogueService {
  private readonly logger = new Logger(StripeCatalogueService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
  ) {}

  async syncPlans() {
    const stripe = this.stripeService.stripe;

    const plans = await this.prisma.subscriptionPlan.findMany({
      where: { isActive: true, contactSalesOnly: false },
      orderBy: { sortOrder: 'asc' },
    });

    const results: Array<Record<string, unknown>> = [];

    for (const plan of plans) {
      if (plan.priceMonthly === null && plan.priceAnnual === null) {
        results.push({ plan: plan.name, skipped: 'no pricing' });
        continue;
      }

      let productId = plan.stripeProductId;
      if (!productId) {
        const product = await stripe.products.create({
          name: `Saveful — ${plan.displayName}`,
          description: plan.description ?? undefined,
          metadata: { planId: String(plan.id), planName: plan.name },
        });
        productId = product.id;
        this.logger.log(`Created Stripe product ${productId} for ${plan.name}`);
      }

      let monthlyId = plan.stripePriceIdMonthly;
      if (!monthlyId && plan.priceMonthly !== null) {
        const price = await stripe.prices.create({
          product: productId,
          currency: STRIPE_CURRENCY,
          unit_amount: toCents(plan.priceMonthly),
          currency_options: inrOption(plan.priceMonthlyInr),
          recurring: { interval: 'month' },
          metadata: { planId: String(plan.id), cycle: 'MONTHLY' },
        });
        monthlyId = price.id;
        this.logger.log(
          `Created monthly price ${monthlyId} for ${plan.name}` +
            (plan.priceMonthlyInr !== null ? ' (AUD + INR)' : ' (AUD)'),
        );
      }

      let annualId = plan.stripePriceIdAnnual;
      if (!annualId && plan.priceAnnual !== null) {
        const price = await stripe.prices.create({
          product: productId,
          currency: STRIPE_CURRENCY,
          unit_amount: toCents(plan.priceAnnual),
          currency_options: inrOption(plan.priceAnnualInr),
          recurring: { interval: 'year' },
          metadata: { planId: String(plan.id), cycle: 'ANNUAL' },
        });
        annualId = price.id;
        this.logger.log(
          `Created annual price ${annualId} for ${plan.name}` +
            (plan.priceAnnualInr !== null ? ' (AUD + INR)' : ' (AUD)'),
        );
      }

      await this.prisma.subscriptionPlan.update({
        where: { id: plan.id },
        data: {
          stripeProductId: productId,
          stripePriceIdMonthly: monthlyId,
          stripePriceIdAnnual: annualId,
        },
      });

      results.push({
        plan: plan.name,
        productId,
        monthlyPriceId: monthlyId,
        annualPriceId: annualId,
        perSite: plan.isPerSite,
      });
    }

    return { currency: STRIPE_CURRENCY.toUpperCase(), synced: results };
  }
}
