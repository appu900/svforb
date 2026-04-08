import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { Jwtpayload } from 'src/modules/auth/interface/jwt.interface';
import { SiteAdminOrAboveGuard } from './guards/site-admin-or-above.guard';
import { SuperAdminGuard } from './guards/super-admin.guard';
import { AddStaffDto, AssignSiteManagerDto, CreateSiteDto } from './dto/sites.dto';
import { SitesService } from './service/sites.service';




0

@Controller('sites')
@UseGuards(JwtAuthGuard)
export class SitesController {
  constructor(private readonly sitesService: SitesService) {}

  /**
   * POST /sites
   * Create a new site.
   * Requires: SUPER_ADMIN + BUSINESS_MULTI + subscription site limit not reached.
   * Body: { siteName, address, postcode, contactName, contactEmail, phoneNumber?, latitude, longitude }
   */
  @Post()
  @UseGuards(SuperAdminGuard)
  createSite(
    @Req() req: Request & { user: Jwtpayload },
    @Body() dto: CreateSiteDto,
  ) {
    return this.sitesService.createSite(req.user, dto);
  }

  /**
   * GET /sites
   * SUPER_ADMIN → all org sites.
   * SITE_ADMIN  → only their own site.
   */
  @Get()
  @UseGuards(SiteAdminOrAboveGuard)
  listSites(@Req() req: Request & { user: Jwtpayload }) {
    return this.sitesService.listSites(req.user);
  }

  /**
   * GET /sites/:siteId
   * SUPER_ADMIN or the SITE_ADMIN of that specific site.
   */
  @Get(':siteId')
  @UseGuards(SiteAdminOrAboveGuard)
  getSite(
    @Req() req: Request & { user: Jwtpayload },
    @Param('siteId', ParseIntPipe) siteId: number,
  ) {
    return this.sitesService.getSite(req.user, siteId);
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
