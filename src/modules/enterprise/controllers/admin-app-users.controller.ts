import { Controller, Get, Param, ParseIntPipe, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PlatformAdminGuard } from '../../../common/guards/platform-admin.guard';
import { SkipSubscriptionCheck } from '../../subscriptions/decorators/skip-subscription-check.decorator';
import { AdminAppUsersService } from '../services/admin-app-users.service';

@Controller('admin/app-users')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
@SkipSubscriptionCheck()
@ApiBearerAuth('bearer')
export class AdminAppUsersController {
  constructor(private readonly appUsers: AdminAppUsersService) {}

  @Get()
  list() {
    return this.appUsers.list();
  }

  @Get('organisations/:organisationId')
  getOrganisation(@Param('organisationId', ParseIntPipe) organisationId: number) {
    return this.appUsers.getOrganisation(organisationId);
  }
}
