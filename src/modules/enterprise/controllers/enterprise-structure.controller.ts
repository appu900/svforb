import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import {
  AssignSitesDto,
  CreateClusterDto,
  CreateGroupDto,
  CreateTerritoryDto,
  StructureListQueryDto,
  UpdateClusterDto,
  UpdateGroupDto,
  UpdateTerritoryDto,
} from '../dto/enterprise.dto';
import { EnterpriseStructureService } from '../services/enterprise-structure.service';
import { ApiBearerAuth } from '@nestjs/swagger';

type Req = Request & { user: Jwtpayload };

/**
 * Organisation Structure.
 *
 * Groups, Clusters and Territories are three independent dimensions and get
 * identical treatment here — the same routes, in the same shapes, so the
 * screen can render them as tabs over one component.
 *
 * Every route is gated on role *and* scope inside the service: holding the
 * permission is not enough to touch a structure outside your own reach.
 */
@Controller('enterprise')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('bearer')
export class EnterpriseStructureController {
  constructor(private readonly structure: EnterpriseStructureService) {}

  /** All three dimensions side by side, plus what is unplaced in each. */
  @Get('structure')
  getStructure(@Req() req: Req) {
    return this.structure.getStructure(req.user);
  }

  // ─── Groups ────────────────────────────────────────────────────────────────

  @Post('groups')
  createGroup(@Req() req: Req, @Body() dto: CreateGroupDto) {
    return this.structure.createGroup(req.user, dto);
  }

  @Get('groups')
  listGroups(@Req() req: Req, @Query() query: StructureListQueryDto) {
    return this.structure.listGroups(req.user, query);
  }

  @Get('groups/:id')
  getGroup(@Req() req: Req, @Param('id', ParseIntPipe) id: number) {
    return this.structure.getGroup(req.user, id);
  }

  @Patch('groups/:id')
  updateGroup(
    @Req() req: Req,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateGroupDto,
  ) {
    return this.structure.updateGroup(req.user, id, dto);
  }

  /** Retires a group without touching the sites in it. */
  @Post('groups/:id/deactivate')
  deactivateGroup(@Req() req: Req, @Param('id', ParseIntPipe) id: number) {
    return this.structure.deactivateGroup(req.user, id);
  }

  @Post('groups/:id/reactivate')
  reactivateGroup(@Req() req: Req, @Param('id', ParseIntPipe) id: number) {
    return this.structure.reactivateGroup(req.user, id);
  }

  /** Refused where history or sites exist — deactivate those instead. */
  @Delete('groups/:id')
  deleteGroup(@Req() req: Req, @Param('id', ParseIntPipe) id: number) {
    return this.structure.deleteGroup(req.user, id);
  }

  @Post('groups/:id/sites')
  assignSitesToGroup(
    @Req() req: Req,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AssignSitesDto,
  ) {
    return this.structure.assignSitesToGroup(req.user, id, dto);
  }

  @Delete('groups/sites/:siteId')
  unassignSiteFromGroup(@Req() req: Req, @Param('siteId', ParseIntPipe) siteId: number) {
    return this.structure.unassignSiteFromGroup(req.user, siteId);
  }

  // ─── Clusters ──────────────────────────────────────────────────────────────

  @Post('clusters')
  createCluster(@Req() req: Req, @Body() dto: CreateClusterDto) {
    return this.structure.createCluster(req.user, dto);
  }

  @Get('clusters')
  listClusters(@Req() req: Req, @Query() query: StructureListQueryDto) {
    return this.structure.listClusters(req.user, query);
  }

  @Get('clusters/:id')
  getCluster(@Req() req: Req, @Param('id', ParseIntPipe) id: number) {
    return this.structure.getCluster(req.user, id);
  }

  @Patch('clusters/:id')
  updateCluster(
    @Req() req: Req,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateClusterDto,
  ) {
    return this.structure.updateCluster(req.user, id, dto);
  }

  @Post('clusters/:id/deactivate')
  deactivateCluster(@Req() req: Req, @Param('id', ParseIntPipe) id: number) {
    return this.structure.deactivateCluster(req.user, id);
  }

  @Post('clusters/:id/reactivate')
  reactivateCluster(@Req() req: Req, @Param('id', ParseIntPipe) id: number) {
    return this.structure.reactivateCluster(req.user, id);
  }

  @Delete('clusters/:id')
  deleteCluster(@Req() req: Req, @Param('id', ParseIntPipe) id: number) {
    return this.structure.deleteCluster(req.user, id);
  }

  @Post('clusters/:id/sites')
  assignSitesToCluster(
    @Req() req: Req,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AssignSitesDto,
  ) {
    return this.structure.assignSitesToCluster(req.user, id, dto);
  }

  @Delete('clusters/sites/:siteId')
  unassignSiteFromCluster(@Req() req: Req, @Param('siteId', ParseIntPipe) siteId: number) {
    return this.structure.unassignSiteFromCluster(req.user, siteId);
  }

  // ─── Territories ───────────────────────────────────────────────────────────

  @Post('territories')
  createTerritory(@Req() req: Req, @Body() dto: CreateTerritoryDto) {
    return this.structure.createTerritory(req.user, dto);
  }

  @Get('territories')
  listTerritories(@Req() req: Req, @Query() query: StructureListQueryDto) {
    return this.structure.listTerritories(req.user, query);
  }

  @Get('territories/:id')
  getTerritory(@Req() req: Req, @Param('id', ParseIntPipe) id: number) {
    return this.structure.getTerritory(req.user, id);
  }

  @Patch('territories/:id')
  updateTerritory(
    @Req() req: Req,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateTerritoryDto,
  ) {
    return this.structure.updateTerritory(req.user, id, dto);
  }

  @Post('territories/:id/deactivate')
  deactivateTerritory(@Req() req: Req, @Param('id', ParseIntPipe) id: number) {
    return this.structure.deactivateTerritory(req.user, id);
  }

  @Post('territories/:id/reactivate')
  reactivateTerritory(@Req() req: Req, @Param('id', ParseIntPipe) id: number) {
    return this.structure.reactivateTerritory(req.user, id);
  }

  @Delete('territories/:id')
  deleteTerritory(@Req() req: Req, @Param('id', ParseIntPipe) id: number) {
    return this.structure.deleteTerritory(req.user, id);
  }

  @Post('territories/:id/sites')
  assignSitesToTerritory(
    @Req() req: Req,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AssignSitesDto,
  ) {
    return this.structure.assignSitesToTerritory(req.user, id, dto);
  }

  @Delete('territories/sites/:siteId')
  unassignSiteFromTerritory(
    @Req() req: Req,
    @Param('siteId', ParseIntPipe) siteId: number,
  ) {
    return this.structure.unassignSiteFromTerritory(req.user, siteId);
  }
}
