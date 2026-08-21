import {
  Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import {
  AssignSitesDto, CreateClusterDto, CreateGroupDto, CreateTerritoryDto,
  UpdateClusterDto, UpdateGroupDto, UpdateTerritoryDto,
} from '../dto/enterprise.dto';
import { EnterpriseStructureService } from '../services/enterprise-structure.service';

@Controller('enterprise')
@UseGuards(JwtAuthGuard)
export class EnterpriseStructureController {
  constructor(private readonly structure: EnterpriseStructureService) {}

  /** Whole tree plus anything not yet placed. */
  @Get('structure')
  getStructure(@Req() req: Request & { user: Jwtpayload }) {
    return this.structure.getStructure(req.user);
  }

  // ─── Groups ────────────────────────────────────────────────────────────────

  @Post('groups')
  createGroup(@Req() req: Request & { user: Jwtpayload }, @Body() dto: CreateGroupDto) {
    return this.structure.createGroup(req.user, dto);
  }

  @Get('groups')
  listGroups(@Req() req: Request & { user: Jwtpayload }) {
    return this.structure.listGroups(req.user);
  }

  @Get('groups/:id')
  getGroup(@Req() req: Request & { user: Jwtpayload }, @Param('id', ParseIntPipe) id: number) {
    return this.structure.getGroup(req.user, id);
  }

  @Patch('groups/:id')
  updateGroup(
    @Req() req: Request & { user: Jwtpayload },
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateGroupDto,
  ) {
    return this.structure.updateGroup(req.user, id, dto);
  }

  @Delete('groups/:id')
  deleteGroup(@Req() req: Request & { user: Jwtpayload }, @Param('id', ParseIntPipe) id: number) {
    return this.structure.deleteGroup(req.user, id);
  }

  // ─── Clusters ──────────────────────────────────────────────────────────────

  @Post('clusters')
  createCluster(@Req() req: Request & { user: Jwtpayload }, @Body() dto: CreateClusterDto) {
    return this.structure.createCluster(req.user, dto);
  }

  @Get('clusters')
  listClusters(
    @Req() req: Request & { user: Jwtpayload },
    @Query('groupId') groupId?: string,
  ) {
    return this.structure.listClusters(req.user, groupId ? Number(groupId) : undefined);
  }

  @Get('clusters/:id')
  getCluster(@Req() req: Request & { user: Jwtpayload }, @Param('id', ParseIntPipe) id: number) {
    return this.structure.getCluster(req.user, id);
  }

  @Patch('clusters/:id')
  updateCluster(
    @Req() req: Request & { user: Jwtpayload },
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateClusterDto,
  ) {
    return this.structure.updateCluster(req.user, id, dto);
  }

  @Delete('clusters/:id')
  deleteCluster(@Req() req: Request & { user: Jwtpayload }, @Param('id', ParseIntPipe) id: number) {
    return this.structure.deleteCluster(req.user, id);
  }

  @Post('clusters/:id/sites')
  assignSitesToCluster(
    @Req() req: Request & { user: Jwtpayload },
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AssignSitesDto,
  ) {
    return this.structure.assignSitesToCluster(req.user, id, dto);
  }

  @Delete('clusters/sites/:siteId')
  unassignSiteFromCluster(
    @Req() req: Request & { user: Jwtpayload },
    @Param('siteId', ParseIntPipe) siteId: number,
  ) {
    return this.structure.unassignSiteFromCluster(req.user, siteId);
  }

  // ─── Territories ───────────────────────────────────────────────────────────

  @Post('territories')
  createTerritory(@Req() req: Request & { user: Jwtpayload }, @Body() dto: CreateTerritoryDto) {
    return this.structure.createTerritory(req.user, dto);
  }

  @Get('territories')
  listTerritories(@Req() req: Request & { user: Jwtpayload }) {
    return this.structure.listTerritories(req.user);
  }

  @Get('territories/:id')
  getTerritory(@Req() req: Request & { user: Jwtpayload }, @Param('id', ParseIntPipe) id: number) {
    return this.structure.getTerritory(req.user, id);
  }

  @Patch('territories/:id')
  updateTerritory(
    @Req() req: Request & { user: Jwtpayload },
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateTerritoryDto,
  ) {
    return this.structure.updateTerritory(req.user, id, dto);
  }

  @Delete('territories/:id')
  deleteTerritory(
    @Req() req: Request & { user: Jwtpayload },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.structure.deleteTerritory(req.user, id);
  }

  @Post('territories/:id/sites')
  assignSitesToTerritory(
    @Req() req: Request & { user: Jwtpayload },
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AssignSitesDto,
  ) {
    return this.structure.assignSitesToTerritory(req.user, id, dto);
  }

  @Delete('territories/sites/:siteId')
  unassignSiteFromTerritory(
    @Req() req: Request & { user: Jwtpayload },
    @Param('siteId', ParseIntPipe) siteId: number,
  ) {
    return this.structure.unassignSiteFromTerritory(req.user, siteId);
  }
}
