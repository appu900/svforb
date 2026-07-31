import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Region } from '@prisma/client';
// The Stripe SDK uses `export =`, and this project sets
// allowSyntheticDefaultImports without esModuleInterop — so a default import
// compiles to `stripe_1.default`, which is undefined at runtime. Import the
// CommonJS export directly instead.
import Stripe = require('stripe');

/** Base currency — used for every region without its own pricing. */
export const STRIPE_CURRENCY = 'aud';

/** Additional currency offered on the same Stripe Price via currency_options. */
export const STRIPE_CURRENCY_INR = 'inr';

/**
 * Billing currency for an organisation's region. India bills in INR; every
 * other region (AU, US, or unset) falls back to the base AUD pricing.
 */
export function currencyForRegion(region?: Region | null): string {
  return region === Region.IN ? STRIPE_CURRENCY_INR : STRIPE_CURRENCY;
}

/**
 * Thin wrapper over the Stripe SDK.
 *
 * The client is created lazily so the app still boots when Stripe keys are
 * absent (local dev, CI) — only the billing endpoints fail, and they fail with
 * a clear message rather than a crash at startup.
 */
@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private client: Stripe | null = null;

  constructor(private readonly config: ConfigService) {}

  get isConfigured(): boolean {
    return !!this.config.get<string>('STRIPE_SECRET_KEY');
  }

  get stripe(): Stripe {
    if (!this.client) {
      const key = this.config.get<string>('STRIPE_SECRET_KEY');
      if (!key) {
        throw new ServiceUnavailableException(
          'Payments are not configured. STRIPE_SECRET_KEY is missing.',
        );
      }
      this.client = new Stripe(key);
      this.logger.log('Stripe client initialised');
    }
    return this.client;
  }

  /** Verifies the webhook signature against the raw request body. */
  constructEvent(rawBody: Buffer, signature: string): Stripe.Event {
    const secret = this.config.get<string>('STRIPE_WEBHOOK_SECRET');
    if (!secret) {
      throw new ServiceUnavailableException(
        'Webhooks are not configured. STRIPE_WEBHOOK_SECRET is missing.',
      );
    }
    return this.stripe.webhooks.constructEvent(rawBody, signature, secret);
  }

  /** Reuses an existing customer when we already hold its id. */
  async ensureCustomer(params: {
    existingCustomerId?: string | null;
    orgId: number;
    orgName: string;
    email: string;
  }): Promise<string> {
    if (params.existingCustomerId) {
      try {
        const existing = await this.stripe.customers.retrieve(params.existingCustomerId);
        if (!existing.deleted) return existing.id;
      } catch {
        this.logger.warn(
          `Stripe customer ${params.existingCustomerId} not retrievable — creating a new one`,
        );
      }
    }

    const customer = await this.stripe.customers.create({
      name: params.orgName,
      email: params.email,
      metadata: { orgId: String(params.orgId) },
    });
    return customer.id;
  }
}
