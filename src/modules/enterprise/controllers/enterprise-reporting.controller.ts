import { Controller, Get, Param, ParseIntPipe, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import { EnterpriseReportingService } from '../services/enterprise-reporting.service';

/**
 * Every route takes an optional startDate/endDate; omitted means the last
 * 30 days. Scope is expressed in the path rather than a query enum so the
 * URLs read the way the drill-down does.
 */
@Controller('enterprise/reports')
@UseGuards(JwtAuthGuard)
export class EnterpriseReportingController {
  constructor(private readonly reporting: EnterpriseReportingService) {}

  @Get('dashboard')
  dashboard(
    @Req() req: Request & { user: Jwtpayload },
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.reporting.getDashboard(req.user, startDate, endDate);
  }

  @Get('impact')
  enterpriseImpact(
    @Req() req: Request & { user: Jwtpayload },
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.reporting.getImpact(req.user, 'ENTERPRISE', undefined, startDate, endDate);
  }

  @Get('groups/:id/impact')
  groupImpact(
    @Req() req: Request & { user: Jwtpayload },
    @Param('id', ParseIntPipe) id: number,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.reporting.getImpact(req.user, 'GROUP', id, startDate, endDate);
  }

  @Get('clusters/:id/impact')
  clusterImpact(
    @Req() req: Request & { user: Jwtpayload },
    @Param('id', ParseIntPipe) id: number,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.reporting.getImpact(req.user, 'CLUSTER', id, startDate, endDate);
  }

  @Get('territories/:id/impact')
  territoryImpact(
    @Req() req: Request & { user: Jwtpayload },
    @Param('id', ParseIntPipe) id: number,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.reporting.getImpact(req.user, 'TERRITORY', id, startDate, endDate);
  }

  @Get('sites/:id/impact')
  siteImpact(
    @Req() req: Request & { user: Jwtpayload },
    @Param('id', ParseIntPipe) id: number,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.reporting.getImpact(req.user, 'SITE', id, startDate, endDate);
  }

  /** One level down from the Enterprise — impact per group. */
  @Get('breakdown')
  enterpriseBreakdown(
    @Req() req: Request & { user: Jwtpayload },
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.reporting.getBreakdown(req.user, 'ENTERPRISE', undefined, startDate, endDate);
  }

  @Get('groups/:id/breakdown')
  groupBreakdown(
    @Req() req: Request & { user: Jwtpayload },
    @Param('id', ParseIntPipe) id: number,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.reporting.getBreakdown(req.user, 'GROUP', id, startDate, endDate);
  }

  @Get('clusters/:id/breakdown')
  clusterBreakdown(
    @Req() req: Request & { user: Jwtpayload },
    @Param('id', ParseIntPipe) id: number,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.reporting.getBreakdown(req.user, 'CLUSTER', id, startDate, endDate);
  }

  /** Site league table plus active / inactive / never-used / deactivated counts. */
  @Get('sites/rankings')
  rankings(
    @Req() req: Request & { user: Jwtpayload },
    @Query('scopeType') scopeType?: string,
    @Query('scopeId') scopeId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.reporting.getSiteRankings(
      req.user,
      (scopeType as never) ?? 'ENTERPRISE',
      scopeId ? Number(scopeId) : undefined,
      startDate,
      endDate,
    );
  }
}
