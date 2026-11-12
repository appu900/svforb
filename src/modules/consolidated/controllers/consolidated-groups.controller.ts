import {
  Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put, Query, Req, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { ConsolidatedEnabledGuard } from '../consolidated-enabled.guard';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import {
  CollectionPointDto, CreateGroupDto, GroupListQueryDto, SetGroupMembersDto,
  SetGroupSitesDto, UpdateCollectionPointDto, UpdateGroupDto,
} from '../dto/group.dto';
import { CreateScheduleDto } from '../dto/schedule.dto';
import { ConsolidatedGroupService } from '../services/consolidated-group.service';
import { ConsolidatedScheduleService } from '../services/consolidated-schedule.service';

type Req = Request & { user: Jwtpayload };

/**
 * Setting up a collection group: which sites take part, where the food goes,
 * and who runs it. Scheduling lives under the group because a schedule has no
 * meaning without one.
 */
@Controller('consolidated/groups')
@UseGuards(ConsolidatedEnabledGuard, JwtAuthGuard)
@ApiBearerAuth('bearer')
export class ConsolidatedGroupsController {
  constructor(
    private readonly groups: ConsolidatedGroupService,
    private readonly schedules: ConsolidatedScheduleService,
  ) {}

  @Post()
  create(@Req() req: Req, @Body() dto: CreateGroupDto) {
    return this.groups.create(req.user, dto, req);
  }

  @Get()
  list(@Req() req: Req, @Query() query: GroupListQueryDto) {
    return this.groups.list(req.user, query);
  }

  /** Sites the caller could add — active, in their organisation, in reach. */
  @Get('eligible-sites')
  eligibleSites(@Req() req: Req) {
    return this.groups.eligibleSites(req.user);
  }

  /** Org members, flagged with whether they could be made a manager. */
  @Get('eligible-users')
  eligibleUsers(@Req() req: Req) {
    return this.groups.eligibleUsers(req.user);
  }

  @Get(':id')
  get(@Req() req: Req, @Param('id', ParseIntPipe) id: number) {
    return this.groups.get(req.user, id);
  }

  @Patch(':id')
  update(@Req() req: Req, @Param('id', ParseIntPipe) id: number, @Body() dto: UpdateGroupDto) {
    return this.groups.update(req.user, id, dto, req);
  }

  /** The full intended site list — anything left out is removed. */
  @Put(':id/sites')
  setSites(@Req() req: Req, @Param('id', ParseIntPipe) id: number, @Body() dto: SetGroupSitesDto) {
    return this.groups.setSites(req.user, id, dto, req);
  }

  @Put(':id/members')
  setMembers(@Req() req: Req, @Param('id', ParseIntPipe) id: number, @Body() dto: SetGroupMembersDto) {
    return this.groups.setMembers(req.user, id, dto, req);
  }

  @Post(':id/points')
  addPoint(@Req() req: Req, @Param('id', ParseIntPipe) id: number, @Body() dto: CollectionPointDto) {
    return this.groups.addPoint(req.user, id, dto, req);
  }

  @Patch(':id/points/:pointId')
  updatePoint(
    @Req() req: Req,
    @Param('id', ParseIntPipe) id: number,
    @Param('pointId', ParseIntPipe) pointId: number,
    @Body() dto: UpdateCollectionPointDto,
  ) {
    return this.groups.updatePoint(req.user, id, pointId, dto, req);
  }

  @Get(':id/schedules')
  listSchedules(@Req() req: Req, @Param('id', ParseIntPipe) id: number) {
    return this.schedules.listForGroup(req.user, id);
  }

  @Post(':id/schedules')
  createSchedule(
    @Req() req: Req,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateScheduleDto,
  ) {
    return this.schedules.create(req.user, id, dto, req);
  }

  /** Archives rather than deletes — collections already run are history. */
  @Delete(':id')
  archive(@Req() req: Req, @Param('id', ParseIntPipe) id: number) {
    return this.groups.archive(req.user, id, req);
  }
}
