import {
  Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Req, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import { ConnectionDailyService } from '../connection.daily.service';
import { ConnectionService } from '../connection.service';
import {
  AddDailySurplusDto, CreateConnectionDto, ReassignDayDto, SetSiteTimezoneDto, UpdateConnectionDto,
} from '../dto/connection.dto';

type Req = Request & { user: Jwtpayload };

/**
 * Preferred Charity — the business side.
 *
 * A Connection decides who is offered surplus first; the listing is what is
 * available today. Everything after the charity confirms runs through the
 * existing claim endpoints unchanged.
 */
@Controller('connections')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('bearer')
export class ConnectionController {
  constructor(
    private readonly connections: ConnectionService,
    private readonly daily: ConnectionDailyService,
  ) {}

  /** Invite a charity to collect regularly from one site. */
  @Post()
  invite(@Req() req: Req, @Body() dto: CreateConnectionDto) {
    return this.connections.invite(req.user, dto);
  }

  /** Due collections for Surplus — who is expected and the pickup window. */
  @Get('site/:siteId/today')
  listTodayForSite(@Req() req: Req, @Param('siteId', ParseIntPipe) siteId: number) {
    return this.daily.listTodayForSite(req.user, siteId);
  }

  /** IANA zone the site's wall-clock windows resolve against. */
  @Patch('site/:siteId/timezone')
  setTimezone(
    @Req() req: Req,
    @Param('siteId', ParseIntPipe) siteId: number,
    @Body() dto: SetSiteTimezoneDto,
  ) {
    return this.connections.setSiteTimezone(req.user, siteId, dto.timezone);
  }

  /** Every Connection on a site, with its running totals. */
  @Get('site/:siteId')
  listForSite(@Req() req: Req, @Param('siteId', ParseIntPipe) siteId: number) {
    return this.connections.listForSite(req.user, siteId);
  }

  @Get(':id')
  getOne(@Req() req: Req, @Param('id', ParseIntPipe) id: number) {
    return this.connections.getOne(req.user, id);
  }

  /** Edit days, window, typical surplus or notes. Status stays as it is. */
  @Patch(':id')
  update(
    @Req() req: Req,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateConnectionDto,
  ) {
    return this.connections.update(req.user, id, dto);
  }

  @Post(':id/pause')
  pause(@Req() req: Req, @Param('id', ParseIntPipe) id: number) {
    return this.connections.pause(req.user, id);
  }

  @Post(':id/resume')
  resume(@Req() req: Req, @Param('id', ParseIntPipe) id: number) {
    return this.connections.resume(req.user, id);
  }

  @Delete(':id')
  end(@Req() req: Req, @Param('id', ParseIntPipe) id: number) {
    return this.connections.end(req.user, id);
  }

  // ─── The daily loop ────────────────────────────────────────────────────────

  /** Answering today's prompt: publishes the listing to the preferred charity. */
  @Post('days/:dayId/surplus')
  addSurplus(
    @Req() req: Req,
    @Param('dayId', ParseIntPipe) dayId: number,
    @Body() dto: AddDailySurplusDto,
  ) {
    return this.daily.addDailySurplus(req.user, dayId, dto);
  }

  /** Nothing today — the charity is told rather than left waiting. */
  @Post('days/:dayId/no-surplus')
  noSurplus(@Req() req: Req, @Param('dayId', ParseIntPipe) dayId: number) {
    return this.daily.declareNoSurplus(req.user, dayId);
  }

  /** The business answering the cut-off prompt. */
  @Post('days/:dayId/release')
  release(@Req() req: Req, @Param('dayId', ParseIntPipe) dayId: number) {
    return this.daily.releaseToNetwork(req.user, dayId);
  }

  /** Move a reserved listing to another connection whose window is still open. */
  @Post('days/:dayId/reassign')
  reassign(
    @Req() req: Req,
    @Param('dayId', ParseIntPipe) dayId: number,
    @Body() dto: ReassignDayDto,
  ) {
    return this.daily.reassignToConnection(req.user, dayId, dto.toConnectionId);
  }
}

/**
 * The charity side of the same relationship.
 */
@Controller('charity/connections')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('bearer')
export class CharityConnectionController {
  constructor(
    private readonly connections: ConnectionService,
    private readonly daily: ConnectionDailyService,
  ) {}

  /** Invitations and active relationships for this charity. */
  @Get()
  list(@Req() req: Req) {
    return this.connections.listForCharity(req.user);
  }

  /** Today's reserved collections — Confirm or Can't collect. */
  @Get('today')
  listToday(@Req() req: Req) {
    return this.daily.listTodayForCharity(req.user);
  }

  @Post(':id/accept')
  accept(@Req() req: Req, @Param('id', ParseIntPipe) id: number) {
    return this.connections.accept(req.user, id);
  }

  @Post(':id/decline')
  decline(@Req() req: Req, @Param('id', ParseIntPipe) id: number) {
    return this.connections.decline(req.user, id);
  }

  @Post(':id/pause')
  pause(@Req() req: Req, @Param('id', ParseIntPipe) id: number) {
    return this.connections.pause(req.user, id);
  }

  @Delete(':id')
  end(@Req() req: Req, @Param('id', ParseIntPipe) id: number) {
    return this.connections.end(req.user, id);
  }

  /** "Can't collect today" — releases that day's surplus to the network. */
  @Post('days/:dayId/cannot-collect')
  cannotCollect(@Req() req: Req, @Param('dayId', ParseIntPipe) dayId: number) {
    return this.daily.charityCannotCollect(req.user, dayId);
  }
}
