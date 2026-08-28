import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import { SkipSubscriptionCheck } from '../../subscriptions/decorators/skip-subscription-check.decorator';
import { UpdateEnterpriseProfileDto } from '../dto/enterprise.dto';
import { EnterpriseProfileService } from '../services/enterprise-profile.service';

/**
 * Enterprise Settings → Organisation Profile.
 *
 * Exempt from the Stripe gate: Enterprise settles offline against a contract,
 * so the subscription interceptor has no payment to check for.
 */
@Controller('enterprise/profile')
@UseGuards(JwtAuthGuard)
@SkipSubscriptionCheck()
export class EnterpriseProfileController {
  constructor(private readonly profile: EnterpriseProfileService) {}

  /** Returns editable and read-only fields separately, so the UI can lock the latter. */
  @Get()
  get(@Req() req: Request & { user: Jwtpayload }) {
    return this.profile.get(req.user);
  }

  @Patch()
  update(
    @Req() req: Request & { user: Jwtpayload },
    @Body() dto: UpdateEnterpriseProfileDto,
  ) {
    return this.profile.update(req.user, dto);
  }
}
