import { Body, Controller, Delete, Get, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Jwtpayload } from '../auth/interface/jwt.interface';
import { SkipSubscriptionCheck } from '../subscriptions/decorators/skip-subscription-check.decorator';
import {
  ChangePlanDto,
  CreateCheckoutSessionDto,
  EnterpriseEnquiryDto,
  StartTrialDto,
} from './dto/billing.dto';
import { BillingService } from './services/billing.service';

/**
 * Exempt from the subscription gate by definition — every route here exists to
 * get an unsubscribed organisation onto a plan.
 */
@Controller('billing')
@UseGuards(JwtAuthGuard)
@SkipSubscriptionCheck()
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  /**
   * Starts the 30-day trial. Returns a Checkout URL — the card is captured up
   * front so the trial converts to paid on its own. Once per organisation.
   */
  @Post('trial')
  startTrial(
    @Req() req: Request & { user: Jwtpayload },
    @Body() dto: StartTrialDto,
  ) {
    return this.billing.startFreeTrial(req.user, dto);
  }

  /** Returns a Stripe-hosted Checkout URL for the client to redirect to. */
  @Post('checkout')
  createCheckout(
    @Req() req: Request & { user: Jwtpayload },
    @Body() dto: CreateCheckoutSessionDto,
  ) {
    return this.billing.createCheckoutSession(req.user, dto);
  }

  /**
   * Switches an already-subscribed org between plans. Upgrades bill the
   * difference today; downgrades take effect at the period end.
   */
  @Post('change-plan')
  changePlan(
    @Req() req: Request & { user: Jwtpayload },
    @Body() dto: ChangePlanDto,
  ) {
    return this.billing.changePlan(req.user, dto);
  }

  /** Dry run of `change-plan` — backs the confirmation dialog. */
  @Post('change-plan/preview')
  previewChangePlan(
    @Req() req: Request & { user: Jwtpayload },
    @Body() dto: ChangePlanDto,
  ) {
    return this.billing.previewPlanChange(req.user, dto);
  }

  @Delete('change-plan/pending')
  cancelPendingChange(@Req() req: Request & { user: Jwtpayload }) {
    return this.billing.cancelPendingPlanChange(req.user);
  }

  /** Stripe billing portal — card updates, invoices, self-serve cancellation. */
  @Post('portal')
  createPortal(@Req() req: Request & { user: Jwtpayload }) {
    return this.billing.createPortalSession(req.user);
  }

  @Post('cancel')
  cancel(@Req() req: Request & { user: Jwtpayload }) {
    return this.billing.cancelSubscription(req.user);
  }

  @Get('payments')
  listPayments(@Req() req: Request & { user: Jwtpayload }) {
    return this.billing.listPayments(req.user);
  }

  @Post('enterprise-enquiry')
  enterpriseEnquiry(
    @Req() req: Request & { user: Jwtpayload },
    @Body() dto: EnterpriseEnquiryDto,
  ) {
    return this.billing.submitEnterpriseEnquiry(req.user, dto);
  }
}
