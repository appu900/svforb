import {
  Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Req, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { ConsolidatedEnabledGuard } from '../consolidated-enabled.guard';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import {
  ChangeRequestDecisionDto, CreateContributionDto, LateDecisionDto,
  UpdateContributionDto, WithdrawContributionDto,
} from '../dto/contribution.dto';
import { ConsolidatedContributionService } from '../services/consolidated-contribution.service';

type Req = Request & { user: Jwtpayload };

/**
 * What a site puts into a collection, and the manager decisions that follow.
 *
 * A site only ever sees its own contribution — another site's row is a 404,
 * not a 403, so nothing leaks through the error.
 */
@Controller('consolidated')
@UseGuards(ConsolidatedEnabledGuard, JwtAuthGuard)
@ApiBearerAuth('bearer')
export class ConsolidatedContributionsController {
  constructor(private readonly contributions: ConsolidatedContributionService) {}

  /** Collections this site can still list food into. */
  @Get('sites/:siteId/open-collections')
  openCollections(@Req() req: Req, @Param('siteId', ParseIntPipe) siteId: number) {
    return this.contributions.openCollectionsForSite(req.user, siteId);
  }

  /** Submit this site's food. After the deadline it becomes a late request. */
  @Post('collections/:id/contributions')
  create(
    @Req() req: Req,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateContributionDto,
  ) {
    return this.contributions.create(req.user, id, dto, req);
  }

  /** Before publish this applies directly; after, it becomes a change request. */
  @Patch('contributions/:id')
  update(
    @Req() req: Req,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateContributionDto,
  ) {
    return this.contributions.update(req.user, id, dto, req);
  }

  @Post('contributions/:id/withdraw')
  withdraw(
    @Req() req: Req,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: WithdrawContributionDto,
  ) {
    return this.contributions.withdraw(req.user, id, dto, req);
  }

  /** Confirms the food physically moved. Calling it twice is a no-op. */
  @Post('contributions/:id/handover')
  handover(@Req() req: Req, @Param('id', ParseIntPipe) id: number) {
    return this.contributions.handover(req.user, id, req);
  }

  // ─── Manager decisions ─────────────────────────────────────────────────────

  @Post('contributions/:id/approve-late')
  approveLate(
    @Req() req: Req,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: LateDecisionDto,
  ) {
    return this.contributions.decideLate(req.user, id, true, dto, req);
  }

  @Post('contributions/:id/reject-late')
  rejectLate(
    @Req() req: Req,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: LateDecisionDto,
  ) {
    return this.contributions.decideLate(req.user, id, false, dto, req);
  }

  @Get('collections/:id/change-requests')
  listChangeRequests(@Req() req: Req, @Param('id', ParseIntPipe) id: number) {
    return this.contributions.listChangeRequests(req.user, id);
  }

  @Post('change-requests/:id/approve')
  approveChange(
    @Req() req: Req,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ChangeRequestDecisionDto,
  ) {
    return this.contributions.decideChangeRequest(req.user, id, true, dto, req);
  }

  @Post('change-requests/:id/reject')
  rejectChange(
    @Req() req: Req,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ChangeRequestDecisionDto,
  ) {
    return this.contributions.decideChangeRequest(req.user, id, false, dto, req);
  }
}
