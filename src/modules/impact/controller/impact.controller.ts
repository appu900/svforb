import { Controller, Get, Param, ParseIntPipe, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import { ImpactService } from '../services/impact.service';
import {
  ImpactQueryDto,
  ImpactRangeQueryDto,
  RecipientsQueryDto,
  TopFoodsQueryDto,
} from '../dto/impact.query.dto';
import { ApiBearerAuth } from '@nestjs/swagger';

@Controller('impact')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('bearer')
export class ImpactController {
  constructor(private readonly service: ImpactService) {}

  @Get('organisations/:orgId')
  getOrgImpact(
    @Req() req: Request & { user: Jwtpayload },
    @Param('orgId', ParseIntPipe) orgId: number,
    @Query() query: ImpactQueryDto,
  ) {
    return this.service.getOrgImpact(req.user, orgId, query.period);
  }

  @Get('organisations/:orgId/range')
  getOrgImpactByRange(
    @Req() req: Request & { user: Jwtpayload },
    @Param('orgId', ParseIntPipe) orgId: number,
    @Query() query: ImpactRangeQueryDto,
  ) {
    return this.service.getOrgImpactByRange(req.user, orgId, query.startDate, query.endDate);
  }

  @Get('sites/:siteId')
  getSiteImpact(
    @Req() req: Request & { user: Jwtpayload },
    @Param('siteId', ParseIntPipe) siteId: number,
    @Query() query: ImpactQueryDto,
  ) {
    return this.service.getSiteImpact(req.user, siteId, query.period);
  }

  @Get('sites/:siteId/range')
  getSiteImpactByRange(
    @Req() req: Request & { user: Jwtpayload },
    @Param('siteId', ParseIntPipe) siteId: number,
    @Query() query: ImpactRangeQueryDto,
  ) {
    return this.service.getSiteImpactByRange(req.user, siteId, query.startDate, query.endDate);
  }

  @Get('organisations/:orgId/top-foods')
  getTopFoods(
    @Req() req: Request & { user: Jwtpayload },
    @Param('orgId', ParseIntPipe) orgId: number,
    @Query() query: TopFoodsQueryDto,
  ) {
    return this.service.getTopFoods(req.user, orgId, query.startDate, query.endDate);
  }

  @Get('sites/:siteId/top-foods')
  getTopFoodsBySite(
    @Req() req: Request & { user: Jwtpayload },
    @Param('siteId', ParseIntPipe) siteId: number,
    @Query() query: TopFoodsQueryDto,
  ) {
    return this.service.getTopFoodsBySite(req.user, siteId, query.startDate, query.endDate);
  }

  /**
   * Partner organisations for the period: who a business donated to, how many
   * times, how much food and what kind. Receivers get the mirror report.
   */
  @Get('organisations/:orgId/recipients')
  getRecipients(
    @Req() req: Request & { user: Jwtpayload },
    @Param('orgId', ParseIntPipe) orgId: number,
    @Query() query: RecipientsQueryDto,
  ) {
    return this.service.getRecipients(req.user, orgId, query.startDate, query.endDate);
  }

  @Get('sites/:siteId/recipients')
  getRecipientsBySite(
    @Req() req: Request & { user: Jwtpayload },
    @Param('siteId', ParseIntPipe) siteId: number,
    @Query() query: RecipientsQueryDto,
  ) {
    return this.service.getRecipientsBySite(req.user, siteId, query.startDate, query.endDate);
  }
}




