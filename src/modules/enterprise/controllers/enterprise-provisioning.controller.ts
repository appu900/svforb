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
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import { SkipSubscriptionCheck } from '../../subscriptions/decorators/skip-subscription-check.decorator';
import {
  InviteUserDto,
  ProvisionEnterpriseDto,
  UpdateProvisioningDto,
} from '../dto/enterprise.dto';
import { SitesService } from '../../sites/service/sites.service';
import { AuditArea } from '@prisma/client';
import { EnterpriseAuditService } from '../services/enterprise-audit.service';
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

  @Post(':organisationId/users')
  inviteUser(
    @Req() req: Request & { user: Jwtpayload },
    @Param('organisationId', ParseIntPipe) organisationId: number,
    @Body() dto: InviteUserDto,
  ) {
    return this.users.inviteUserForOrganisation(req.user, organisationId, dto);
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
