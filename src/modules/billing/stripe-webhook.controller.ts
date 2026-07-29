import {
  BadRequestException,
  Controller,
  Headers,
  Logger,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { SkipSubscriptionCheck } from '../subscriptions/decorators/skip-subscription-check.decorator';
import { StripeService } from './services/stripe.service';
import { StripeWebhookService } from './services/stripe-webhook.service';

/**
 * Stripe webhook receiver.
 *
 * Deliberately unauthenticated — Stripe cannot present a JWT. Authenticity is
 * proven by the signature header instead, checked against the raw request body
 * (see `rawBody: true` in main.ts).
 */
@Controller('billing/webhook')
@SkipSubscriptionCheck()
export class StripeWebhookController {
  private readonly logger = new Logger(StripeWebhookController.name);

  constructor(
    private readonly stripeService: StripeService,
    private readonly webhookService: StripeWebhookService,
  ) {}

  @Post('stripe')
  async handleStripe(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
  ) {
    if (!signature) {
      throw new BadRequestException('Missing stripe-signature header');
    }
    if (!req.rawBody) {
      throw new BadRequestException(
        'Raw request body unavailable — the app must be created with rawBody: true',
      );
    }

    let event: ReturnType<StripeService['constructEvent']>;
    try {
      event = this.stripeService.constructEvent(req.rawBody, signature);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Rejected Stripe webhook: ${message}`);
      throw new BadRequestException(`Webhook signature verification failed: ${message}`);
    }

    return this.webhookService.handleEvent(event);
  }
}
