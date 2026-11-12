import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { ConsolidatedEnabledGuard } from '../consolidated-enabled.guard';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import { ConsolidatedReportQueryDto } from '../dto/report.dto';
import { ConsolidatedReportService } from '../services/consolidated-report.service';

type Req = Request & { user: Jwtpayload };

/**
 * Results by site and combined.
 *
 * A manager sees every site in the groups they run; a site user passes their
 * own `siteId` and sees only their own rows.
 */
@Controller('consolidated/reports')
@UseGuards(ConsolidatedEnabledGuard, JwtAuthGuard)
@ApiBearerAuth('bearer')
export class ConsolidatedReportsController {
  constructor(private readonly reports: ConsolidatedReportService) {}

  /** Listed, verified, accepted, rejected and unavailable, per site. */
  @Get('summary')
  summary(@Req() req: Req, @Query() query: ConsolidatedReportQueryDto) {
    return this.reports.summary(req.user, query);
  }

  /** One row per collection, paged. */
  @Get('collections')
  collections(@Req() req: Req, @Query() query: ConsolidatedReportQueryDto) {
    return this.reports.collections(req.user, query);
  }
}
