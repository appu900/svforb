import {
  Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Put, Query, Req, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import {
  MfcCreateRecordDto, MfcPatchRecordDto, MfcPutLinesDto, MfcRecordListQueryDto,
  MfcSaveRecordDto,
} from '../dto/mfc.dto';
import { MfcRecordService } from '../services/mfc-record.service';

type Req = Request & { user: Jwtpayload };

/**
 * Recording what a kitchen did not serve.
 *
 * Anything outside the caller's reach is a 404, so a filter cannot be used to
 * discover which other sites exist.
 */
@Controller('mfc/records')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('bearer')
export class MfcRecordsController {
  constructor(private readonly records: MfcRecordService) {}

  /** Idempotent on `clientRequestId` — a retried submit returns the first record. */
  @Post()
  create(@Req() req: Req, @Body() dto: MfcCreateRecordDto) {
    return this.records.create(req.user, dto);
  }

  @Get()
  list(@Req() req: Req, @Query() query: MfcRecordListQueryDto) {
    return this.records.list(req.user, query);
  }

  @Get(':id')
  get(@Req() req: Req, @Param('id', ParseIntPipe) id: number) {
    return this.records.get(req.user, id);
  }

  /** The audit trail, for the site administrator view. */
  @Get(':id/events')
  events(@Req() req: Req, @Param('id', ParseIntPipe) id: number) {
    return this.records.events(req.user, id);
  }

  @Patch(':id')
  patch(
    @Req() req: Req,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: MfcPatchRecordDto,
  ) {
    return this.records.patch(req.user, id, dto);
  }

  /** The full set of lines. Anything left out is soft-deleted. */
  @Put(':id/lines')
  putLines(
    @Req() req: Req,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: MfcPutLinesDto,
  ) {
    return this.records.putLines(req.user, id, dto);
  }

  @Post(':id/save')
  save(
    @Req() req: Req,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: MfcSaveRecordDto,
  ) {
    return this.records.save(req.user, id, dto);
  }
}
