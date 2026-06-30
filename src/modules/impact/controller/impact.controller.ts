import { Controller, Get, Param, ParseIntPipe, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import { ImpactService } from '../services/impact.service';
import { ImpactQueryDto } from '../dto/impact.query.dto';

@Controller('impact')
@UseGuards(JwtAuthGuard)
export class ImpactController {
  constructor(private readonly service: ImpactService) {}

  @Get('sites/:siteId')
  getSiteImpact(
    @Req() req: Request & { user: Jwtpayload },
    @Param('siteId', ParseIntPipe) siteId: number,
    @Query() query: ImpactQueryDto,
  ) {
    return this.service.getSiteImpact(req.user, siteId, query.period);
  }
}
