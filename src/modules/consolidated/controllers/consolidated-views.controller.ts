import {
  Controller, Get, Param, ParseIntPipe, Query, Req, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { ConsolidatedEnabledGuard } from '../consolidated-enabled.guard';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import { CollectionListQueryDto } from '../dto/collection.dto';
import { ConsolidatedContributionService } from '../services/consolidated-contribution.service';
import { ConsolidatedViewService } from '../services/consolidated-view.service';

type Req = Request & { user: Jwtpayload };

/**
 * Read endpoints from SPEC §7.3–7.5 that the screens are built on. Writes stay
 * in their own controllers; this one only ever reads.
 */
@Controller('consolidated')
@UseGuards(ConsolidatedEnabledGuard, JwtAuthGuard)
@ApiBearerAuth('bearer')
export class ConsolidatedViewsController {
  constructor(
    private readonly views: ConsolidatedViewService,
    private readonly contributions: ConsolidatedContributionService,
  ) {}

  /** Every collection the caller runs or receives for, by tab. */
  @Get('collections')
  list(@Req() req: Req, @Query() query: CollectionListQueryDto) {
    return this.views.listCollections(req.user, query);
  }

  @Get('collections/:id/audit')
  audit(@Req() req: Req, @Param('id', ParseIntPipe) id: number) {
    return this.views.audit(req.user, id);
  }

  @Get('schedules/:id')
  schedule(@Req() req: Req, @Param('id', ParseIntPipe) id: number) {
    return this.views.schedule(req.user, id);
  }

  @Get('contributions/by-listing/:listingId')
  contributionByListing(@Req() req: Req, @Param('listingId', ParseIntPipe) listingId: number) {
    return this.views.contributionByListing(req.user, listingId);
  }

  @Get('contributions/:id')
  contribution(@Req() req: Req, @Param('id', ParseIntPipe) id: number) {
    return this.views.contribution(req.user, id);
  }

  /** SPEC spelling of `GET /collections/:id/change-requests`. */
  @Get('change-requests')
  changeRequests(@Req() req: Req, @Query('collectionId', ParseIntPipe) collectionId: number) {
    return this.contributions.listChangeRequests(req.user, collectionId);
  }
}
