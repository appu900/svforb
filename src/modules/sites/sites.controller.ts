import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Jwtpayload } from '../../modules/auth/interface/jwt.interface';
import { SiteAdminOrAboveGuard } from './guards/site-admin-or-above.guard';
import { SuperAdminGuard } from './guards/super-admin.guard';
import {
  AddStaffDto,
  AssignExistingSiteAdminDto,
  AssignSiteManagerDto,
  CreateSiteDto,
  UpdateSiteDto,
} from './dto/sites.dto';
import { SitesService } from './service/sites.service';

@Controller('sites')
@UseGuards(JwtAuthGuard)
export class SitesController {
  constructor(private readonly sitesService: SitesService) {}

  /**
   * POST /sites
   * Create a new site.
   * Requires: SUPER_ADMIN + BUSINESS_MULTI + subscription site limit not reached.
   * Body: { siteName, address, postcode?, siteCode?, contact, collection, structure, latitude, longitude }
   */
  @Post()
  createSite(
    @Req() req: Request & { user: Jwtpayload },
    @Body() dto: CreateSiteDto,
  ) {
    return this.sitesService.createSite(req.user, dto);
  }

  /**
   * GET /sites/organisation
   * Fetch organisation overview.
   * SUPER_ADMIN → full org details + all sites with their managers and staff.
   * SITE_ADMIN  → their assigned site + all staff under that site.
   */
  @Get('organisation')
  @UseGuards(SiteAdminOrAboveGuard)
  getOrganisationOverview(@Req() req: Request & { user: Jwtpayload }) {
    return this.sitesService.getOrganisationOverview(req.user);
  }

  /**
   * GET /sites/:siteId/details
   * Fetch a single site's full details including managers and staff.
   * SUPER_ADMIN or the SITE_ADMIN of that specific site.
   */
  @Get(':siteId/details')
  @UseGuards(SiteAdminOrAboveGuard)
  getSiteDetails(
    @Req() req: Request & { user: Jwtpayload },
    @Param('siteId', ParseIntPipe) siteId: number,
  ) {
    return this.sitesService.getSiteDetails(req.user, siteId);
  }

  /**
   * POST /sites/:siteId/assign-manager
   * Assign a site manager (SITE_ADMIN role) to a site.
   * Requires: SUPER_ADMIN only.
   * Body: { userId }
   */
  @Post(':siteId/assign-manager')
  @UseGuards(SuperAdminGuard)
  assignSiteManager(
    @Req() req: Request & { user: Jwtpayload },
    @Param('siteId', ParseIntPipe) siteId: number,
    @Body() dto: AssignSiteManagerDto,
  ) {
    return this.sitesService.assignSiteManager(req.user, siteId, dto);
  }

  /**
   * POST /sites/:siteId/assign-admin
   * Grant Site Admin to an existing organisation member. No password.
   */
  @Post(':siteId/assign-admin')
  assignExistingSiteAdmin(
    @Req() req: Request & { user: Jwtpayload },
    @Param('siteId', ParseIntPipe) siteId: number,
    @Body() dto: AssignExistingSiteAdminDto,
  ) {
    return this.sitesService.assignExistingSiteAdmin(req.user, siteId, dto);
  }

  /**
   * POST /sites/:siteId/staff
   * Add a staff member to a site.
   * Requires: SUPER_ADMIN or SITE_ADMIN of that specific site.
   * Body: { userId }
   */
  @Post(':siteId/staff')
  @UseGuards(SiteAdminOrAboveGuard)
  addStaff(
    @Req() req: Request & { user: Jwtpayload },
    @Param('siteId', ParseIntPipe) siteId: number,
    @Body() dto: AddStaffDto,
  ) {
    return this.sitesService.addStaff(req.user, siteId, dto);
  }

  /**
   * GET /sites/:siteId/staff
   * List all staff members for a site.
   * Requires: SUPER_ADMIN or SITE_ADMIN of that specific site.
   */
  @Get(':siteId/staff')
  @UseGuards(SiteAdminOrAboveGuard)
  listStaff(
    @Req() req: Request & { user: Jwtpayload },
    @Param('siteId', ParseIntPipe) siteId: number,
  ) {
    return this.sitesService.listStaff(req.user, siteId);
  }

  /**
   * DELETE /sites/:siteId/access/:userId
   * Remove a user's access to a site.
   * Requires: SUPER_ADMIN or SITE_ADMIN of that specific site.
   * Note: Only SUPER_ADMIN can remove a site manager.
   * If the user has no remaining site accesses in the org, their account is deactivated
   * and they will be unable to log in.
   */
  /**
   * DELETE /sites/:siteId
   * Soft-delete a site. Removes all site accesses and deactivates users with no remaining access.
   * Requires: SUPER_ADMIN + BUSINESS_MULTI.
   */
  @Delete(':siteId')
  @UseGuards(SuperAdminGuard)
  deleteSite(
    @Req() req: Request & { user: Jwtpayload },
    @Param('siteId', ParseIntPipe) siteId: number,
  ) {
    return this.sitesService.deleteSite(req.user, siteId);
  }

  /**
   * PATCH /sites/:siteId
   * Edit site details. All fields are optional.
   * Requires: SUPER_ADMIN + BUSINESS_MULTI.
   */
  @Patch(':siteId')
  updateSite(
    @Req() req: Request & { user: Jwtpayload },
    @Param('siteId', ParseIntPipe) siteId: number,
    @Body() dto: UpdateSiteDto,
  ) {
    return this.sitesService.updateSite(req.user, siteId, dto);
  }

  @Delete(':siteId/access/:userId')
  @UseGuards(SiteAdminOrAboveGuard)
  removeAccess(
    @Req() req: Request & { user: Jwtpayload },
    @Param('siteId', ParseIntPipe) siteId: number,
    @Param('userId', ParseIntPipe) userId: number,
  ) {
    return this.sitesService.removeAccess(req.user, siteId, userId);
  }
}
