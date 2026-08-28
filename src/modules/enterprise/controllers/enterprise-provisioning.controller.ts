import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PlatformAdminGuard } from '../../../common/guards/platform-admin.guard';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import { SkipSubscriptionCheck } from '../../subscriptions/decorators/skip-subscription-check.decorator';
import {
  ProvisionEnterpriseDto,
  UpdateProvisioningDto,
} from '../dto/enterprise.dto';
import { EnterpriseProvisioningService } from '../services/enterprise-provisioning.service';

/**
 * The Saveful administration environment, scoped separately from the
 * customer-facing Enterprise Portal. Enterprise customers cannot self-create an
 * Enterprise account, so nothing here is reachable by them.
 */
@Controller('admin/enterprise')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
@SkipSubscriptionCheck()
export class EnterpriseProvisioningController {
  constructor(private readonly provisioning: EnterpriseProvisioningService) {}

  /** Creates the Enterprise and invites its first Super Admin. */
  @Post('provision')
  provision(
    @Req() req: Request & { user: Jwtpayload },
    @Body() dto: ProvisionEnterpriseDto,
  ) {
    return this.provisioning.provision(req.user, dto);
  }

  @Get()
  list() {
    return this.provisioning.list();
  }

  @Get(':organisationId')
  getOne(@Param('organisationId', ParseIntPipe) organisationId: number) {
    return this.provisioning.getOne(organisationId);
  }

  /** Account status, country, timezone, currency and units. */
  @Patch(':organisationId/provisioning')
  updateProvisioning(
    @Req() req: Request & { user: Jwtpayload },
    @Param('organisationId', ParseIntPipe) organisationId: number,
    @Body() dto: UpdateProvisioningDto,
  ) {
    return this.provisioning.updateProvisioning(req.user, organisationId, dto);
  }
}
