import {
  Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { ConsolidatedEnabledGuard } from '../consolidated-enabled.guard';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import {
  CancelCollectionDto, RemindSitesDto, ReopenSubmissionsDto, UpdateCollectionDto,
} from '../dto/collection.dto';
import {
  ExcludeContributionDto, PublishDto, RecordReceiptDto,
} from '../dto/receipt.dto';
import { EndScheduleDto, UpdateScheduleDto } from '../dto/schedule.dto';
import { ConsolidatedCollectionService } from '../services/consolidated-collection.service';
import { ConsolidatedPublishService } from '../services/consolidated-publish.service';
import { ConsolidatedReceiptService } from '../services/consolidated-receipt.service';
import { ConsolidatedScheduleService } from '../services/consolidated-schedule.service';
import { ConsolidatedViewService } from '../services/consolidated-view.service';

type Req = Request & { user: Jwtpayload };

/**
 * Running a collection: the dashboard, closing, reopening and cancelling.
 * Creating a schedule lives on the group, because one cannot exist without it.
 */
@Controller('consolidated')
@UseGuards(ConsolidatedEnabledGuard, JwtAuthGuard)
@ApiBearerAuth('bearer')
export class ConsolidatedCollectionsController {
  constructor(
    private readonly collections: ConsolidatedCollectionService,
    private readonly schedules: ConsolidatedScheduleService,
    private readonly receipts: ConsolidatedReceiptService,
    private readonly publishing: ConsolidatedPublishService,
    private readonly views: ConsolidatedViewService,
  ) {}

  // ─── Collections ───────────────────────────────────────────────────────────

  @Get('groups/:groupId/collections')
  listForGroup(
    @Req() req: Req,
    @Param('groupId', ParseIntPipe) groupId: number,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.collections.listForGroup(
      req.user,
      groupId,
      from ? new Date(from) : undefined,
      to ? new Date(to) : undefined,
    );
  }

  /** The event dashboard (SPEC §7.6). A site user sees only their own sites. */
  @Get('collections/:id')
  get(@Req() req: Req, @Param('id', ParseIntPipe) id: number) {
    return this.views.dashboard(req.user, id);
  }

  /** Edits this occurrence only, detaching it from its series. */
  @Patch('collections/:id')
  update(
    @Req() req: Req,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCollectionDto,
  ) {
    return this.collections.updateOccurrence(req.user, id, dto, req);
  }

  @Post('collections/:id/close')
  close(@Req() req: Req, @Param('id', ParseIntPipe) id: number) {
    return this.collections.closeSubmissions(req.user, id, req);
  }

  /** Reopens for a while longer. Never past the end of handover. */
  @Post('collections/:id/reopen')
  reopen(
    @Req() req: Req,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReopenSubmissionsDto,
  ) {
    return this.collections.reopenSubmissions(req.user, id, dto, req);
  }

  @Post('collections/:id/remind')
  remind(
    @Req() req: Req,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RemindSitesDto,
  ) {
    return this.collections.remind(req.user, id, dto.siteIds, req);
  }

  @Post('collections/:id/cancel')
  cancel(
    @Req() req: Req,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CancelCollectionDto,
  ) {
    return this.collections.cancel(req.user, id, dto, req);
  }

  // ─── Receipt at the collection point ───────────────────────────────────────

  /** Received / Not received / Adjust quantity, for one site's contribution. */
  @Post('contributions/:id/receipt')
  receipt(
    @Req() req: Req,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RecordReceiptDto,
  ) {
    return this.receipts.record(req.user, id, dto, req);
  }

  /** Drops a contribution from the collection. The record stays for the site. */
  @Post('contributions/:id/exclude')
  exclude(
    @Req() req: Req,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ExcludeContributionDto,
  ) {
    return this.receipts.exclude(req.user, id, dto, req);
  }

  // ─── Publishing ────────────────────────────────────────────────────────────

  /** What the charity would see, plus anything standing in the way. */
  @Get('collections/:id/publish-preview')
  publishPreview(@Req() req: Req, @Param('id', ParseIntPipe) id: number) {
    return this.publishing.publishPreview(req.user, id);
  }

  /** Builds the one listing a charity sees and makes it discoverable. */
  @Post('collections/:id/publish')
  publish(
    @Req() req: Req,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PublishDto,
  ) {
    return this.publishing.publish(req.user, id, dto.declaration, req);
  }

  /** Rebuilds the published listing after a change to what is included. */
  @Post('collections/:id/sync')
  sync(@Req() req: Req, @Param('id', ParseIntPipe) id: number) {
    return this.publishing.syncMaster(req.user, id, req);
  }

  // ─── Schedules ─────────────────────────────────────────────────────────────

  /** Applies to future occurrences. Detached dates are left alone. */
  @Patch('schedules/:id')
  updateSchedule(
    @Req() req: Req,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateScheduleDto,
  ) {
    return this.schedules.update(req.user, id, dto, req);
  }

  /** Stops the series from a date, cancelling anything upcoming. */
  @Post('schedules/:id/end')
  endSchedule(
    @Req() req: Req,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: EndScheduleDto,
  ) {
    return this.schedules.end(req.user, id, dto, req);
  }
}
