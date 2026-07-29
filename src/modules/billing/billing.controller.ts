import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PlatformAdminGuard } from '../../common/guards/platform-admin.guard';
import { Jwtpayload } from '../auth/interface/jwt.interface';
import { SkipSubscriptionCheck } from '../subscriptions/decorators/skip-subscription-check.decorator';
import {
  CreateCheckoutSessionDto,
  EnterpriseEnquiryDto,
  StartTrialDto,
} from './dto/billing.dto';
import { BillingService } from './services/billing.service';
import { StripeCatalogueService } from './services/stripe-catalogue.service';

/**
 * Exempt from the subscription gate by definition — every route here exists to
 * get an unsubscribed organisation onto a plan.
 */
@Controller('billing')
@UseGuards(JwtAuthGuard)
@SkipSubscriptionCheck()
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly catalogue: StripeCatalogueService,
  ) {}

  /** Starts the 30-day trial. No card, once per organisation. */
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

  /** Creates Stripe products and prices from the local plan catalogue. */
  @Post('admin/sync-stripe-catalogue')
  @UseGuards(PlatformAdminGuard)
  syncCatalogue() {
    return this.catalogue.syncPlans();
  }
}
