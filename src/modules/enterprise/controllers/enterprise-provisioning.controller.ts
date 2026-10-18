import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request } from 'express';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PlatformAdminGuard } from '../../../common/guards/platform-admin.guard';
import { InvalidatesCache } from '../../../infra/http-cache/http-cache.decorators';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import { SkipSubscriptionCheck } from '../../subscriptions/decorators/skip-subscription-check.decorator';
import {
  InviteSiteUserDto,
  InviteUserDto,
  ProvisionEnterpriseDto,
  SetMemberRoleDto,
  UpdateProvisioningDto,
} from '../dto/enterprise.dto';
import { SitesService } from '../../sites/service/sites.service';
import { AuditArea } from '@prisma/client';
import { EnterpriseAuditService } from '../services/enterprise-audit.service';
import { AdminConnectionsService } from '../services/admin-connections.service';
import { AdminDashboardService } from '../services/admin-dashboard.service';
import { EnterpriseProvisioningService } from '../services/enterprise-provisioning.service';
import { EnterpriseStructureService } from '../services/enterprise-structure.service';
import { EnterpriseUserService } from '../services/enterprise-user.service';
import { ApiBearerAuth } from '@nestjs/swagger';

/**
 * The Saveful administration environment, scoped separately from the
 * customer-facing Enterprise Portal. Enterprise customers cannot self-create an
 * Enterprise account, so nothing here is reachable by them.
 */
@Controller('admin/enterprise')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
@SkipSubscriptionCheck()
@ApiBearerAuth('bearer')
export class EnterpriseProvisioningController {
  constructor(
    private readonly provisioning: EnterpriseProvisioningService,
    private readonly structure: EnterpriseStructureService,
    private readonly users: EnterpriseUserService,
    private readonly sites: SitesService,
    private readonly audit: EnterpriseAuditService,
    private readonly dashboardSummary: AdminDashboardService,
    private readonly connectionsSummary: AdminConnectionsService,
  ) {}

  /** Creates the Enterprise and invites its first Super Admin. */
  @Post('provision')
  @UseInterceptors(FileInterceptor('logo'))
  provision(
    @Req() req: Request & { user: Jwtpayload },
    @Body() dto: ProvisionEnterpriseDto,
    @UploadedFile() logo?: Express.Multer.File,
  ) {
    return this.provisioning.provision(req.user, dto, logo);
  }

  @Post('logo')
  @UseInterceptors(FileInterceptor('logo'))
  uploadLogo(@UploadedFile() logo?: Express.Multer.File) {
    return this.provisioning.uploadLogo(logo);
  }

  @Get()
  list() {
    return this.provisioning.list();
  }

  @Get('sites')
  listSites(@Req() req: Request & { user: Jwtpayload }) {
    return this.sites.listAllEnterpriseSites(req.user);
  }

  @Get('users')
  listAllUsers() {
    return this.provisioning.listAllMembers();
  }

  @Get('dashboard')
  dashboard(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('organisationId', new ParseIntPipe({ optional: true })) organisationId?: number,
    @Query('orgType') orgType?: string,
    @Query('pathway') pathway?: string,
    @Query('country') country?: string,
    @Query('role') role?: string,
    @Query('accountStatus') accountStatus?: string,
  ) {
    return this.dashboardSummary.summary({ from, to, organisationId, orgType, pathway, country, role, accountStatus });
  }

  @Get('connections')
  connections(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('organisationId', new ParseIntPipe({ optional: true })) organisationId?: number,
  ) {
    return this.connectionsSummary.summary({ from, to, organisationId });
  }

  @Get('audit')
  listAudit(
    @Query('page', new ParseIntPipe({ optional: true })) page = 1,
    @Query('limit', new ParseIntPipe({ optional: true })) limit = 100,
    @Query('search') search?: string,
    @Query('area') area?: AuditArea,
    @Query('organisationId', new ParseIntPipe({ optional: true })) organisationId?: number,
  ) {
    const take = Math.min(200, Math.max(1, limit));
    return this.audit.listAll({
      skip: (Math.max(1, page) - 1) * take,
      take,
      search,
      area,
      organisationId,
    });
  }

  @Get(':organisationId/structure')
  getStructure(@Param('organisationId', ParseIntPipe) organisationId: number) {
    return this.structure.getStructureForOrganisation(organisationId);
  }

  @Get(':organisationId/users')
  listUsers(@Param('organisationId', ParseIntPipe) organisationId: number) {
    return this.provisioning.listMembers(organisationId);
  }

  @Get(':organisationId/audit')
  listOrganisationAudit(
    @Param('organisationId', ParseIntPipe) organisationId: number,
    @Query('page', new ParseIntPipe({ optional: true })) page = 1,
    @Query('limit', new ParseIntPipe({ optional: true })) limit = 100,
    @Query('search') search?: string,
    @Query('area') area?: AuditArea,
  ) {
    const take = Math.min(200, Math.max(1, limit));
    return this.audit.listAll({
      organisationId,
      skip: (Math.max(1, page) - 1) * take,
      take,
      search,
      area,
    });
  }

  @Post(':organisationId/sites/:siteId/users')
  inviteSiteUser(
    @Req() req: Request & { user: Jwtpayload },
    @Param('organisationId', ParseIntPipe) organisationId: number,
    @Param('siteId', ParseIntPipe) siteId: number,
    @Body() dto: InviteSiteUserDto,
  ) {
    return this.users.inviteSiteUser(req.user, siteId, dto, organisationId);
  }

  @Post(':organisationId/users')
  inviteUser(
    @Req() req: Request & { user: Jwtpayload },
    @Param('organisationId', ParseIntPipe) organisationId: number,
    @Body() dto: InviteUserDto,
  ) {
    return this.users.inviteUserForOrganisation(req.user, organisationId, dto);
  }

  @Patch(':organisationId/users/:userId/role')
  @InvalidatesCache('structure', 'identity')
  setUserRole(
    @Req() req: Request & { user: Jwtpayload },
    @Param('organisationId', ParseIntPipe) organisationId: number,
    @Param('userId', ParseIntPipe) userId: number,
    @Body() dto: SetMemberRoleDto,
  ) {
    return this.users.setRoleForOrganisation(req.user, organisationId, userId, dto.role);
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
