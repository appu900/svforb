import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PlatformAdminGuard } from '../../common/guards/platform-admin.guard';
import { SkipSubscriptionCheck } from '../subscriptions/decorators/skip-subscription-check.decorator';
import { Jwtpayload } from '../auth/interface/jwt.interface';
import { SitesService } from './service/sites.service';

@Controller('admin/sites')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
@SkipSubscriptionCheck()
export class AdminSitesController {
  constructor(private readonly sitesService: SitesService) {}

  @Get()
  list(@Req() req: Request & { user: Jwtpayload }) {
    return this.sitesService.listAllEnterpriseSites(req.user);
  }
}
