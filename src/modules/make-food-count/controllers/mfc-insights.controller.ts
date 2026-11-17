import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import {
  MfcHomeImpactQueryDto, MfcInsightsQueryDto, MfcSourceParamDto,
} from '../dto/mfc-insights.dto';
import { MfcInsightsService } from '../services/mfc-insights.service';

type Req = Request & { user: Jwtpayload };

/**
 * What happened to the food a kitchen recorded.
 *
 * Every figure is limited to the caller's reach, and an out-of-reach filter
 * narrows the answer to nothing rather than erroring — so a filter cannot be
 * used to discover which other sites exist.
 */
@Controller('mfc')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('bearer')
@ApiTags('Make Food Count — Insights')
export class MfcInsightsController {
  constructor(private readonly insights: MfcInsightsService) {}

  /** Filter options, each site carrying its group, cluster and territory. */
  @Get('insights/filters')
  filters(@Req() req: Req) {
    return this.insights.filters(req.user);
  }

  @Get('insights')
  overview(@Req() req: Req, @Query() query: MfcInsightsQueryDto) {
    return this.insights.insights(req.user, query);
  }

  /** The same payload, narrowed to one source. */
  @Get('insights/sources/:source')
  bySource(
    @Req() req: Req,
    @Param() params: MfcSourceParamDto,
    @Query() query: MfcInsightsQueryDto,
  ) {
    return this.insights.insights(req.user, query, params.source);
  }

  /** The four numbers the app shows on the home screen. */
  @Get('home-impact')
  homeImpact(@Req() req: Req, @Query() query: MfcHomeImpactQueryDto) {
    return this.insights.homeImpact(req.user, query.siteId);
  }
}
