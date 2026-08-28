import {
  Body,
  Controller,
  Param,
  ParseIntPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PlatformAdminGuard } from '../../common/guards/platform-admin.guard';
import { SkipSubscriptionCheck } from '../subscriptions/decorators/skip-subscription-check.decorator';
import { Jwtpayload } from '../auth/interface/jwt.interface';
import {
  AssignExistingSiteAdminDto,
  CreateSiteDto,
} from './dto/sites.dto';
import { SitesService } from './service/sites.service';

@Controller('admin/enterprise')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
@SkipSubscriptionCheck()
export class AdminEnterpriseSitesController {
  constructor(private readonly sitesService: SitesService) {}

  @Post(':organisationId/sites')
  createSite(
    @Req() req: Request & { user: Jwtpayload },
    @Param('organisationId', ParseIntPipe) organisationId: number,
    @Body() dto: CreateSiteDto,
  ) {
    return this.sitesService.createSiteForOrganisation(
      req.user,
      organisationId,
      dto,
    );
  }

  @Post(':organisationId/sites/:siteId/assign-admin')
  assignExistingSiteAdmin(
    @Req() req: Request & { user: Jwtpayload },
    @Param('organisationId', ParseIntPipe) organisationId: number,
    @Param('siteId', ParseIntPipe) siteId: number,
    @Body() dto: AssignExistingSiteAdminDto,
  ) {
    return this.sitesService.assignExistingSiteAdminForOrganisation(
      req.user,
      organisationId,
      siteId,
      dto,
    );
  }
}
