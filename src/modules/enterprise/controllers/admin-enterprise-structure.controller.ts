import {
  Body,
  Controller,
  Delete,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PlatformAdminGuard } from '../../../common/guards/platform-admin.guard';
import { SkipSubscriptionCheck } from '../../subscriptions/decorators/skip-subscription-check.decorator';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import {
  CreateClusterDto,
  CreateGroupDto,
  CreateTerritoryDto,
  UpdateClusterDto,
  UpdateGroupDto,
  UpdateTerritoryDto,
} from '../dto/enterprise.dto';
import {
  Dimension,
  EnterpriseStructureService,
} from '../services/enterprise-structure.service';
import { ApiBearerAuth } from '@nestjs/swagger';

type Req = Request & { user: Jwtpayload };

@Controller('admin/enterprise')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
@SkipSubscriptionCheck()
@ApiBearerAuth('bearer')
export class AdminEnterpriseStructureController {
  constructor(private readonly structure: EnterpriseStructureService) {}

  @Post(':organisationId/groups')
  createGroup(
    @Req() req: Req,
    @Param('organisationId', ParseIntPipe) organisationId: number,
    @Body() dto: CreateGroupDto,
  ) {
    return this.mutate(req.user, organisationId, 'GROUP', dto);
  }

  @Patch(':organisationId/groups/:id')
  updateGroup(
    @Req() req: Req,
    @Param('organisationId', ParseIntPipe) organisationId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateGroupDto,
  ) {
    return this.structure.updateForOrganisation(req.user, organisationId, 'GROUP', id, dto);
  }

  @Post(':organisationId/groups/:id/deactivate')
  deactivateGroup(
    @Req() req: Req,
    @Param('organisationId', ParseIntPipe) organisationId: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.structure.setActiveForOrganisation(req.user, organisationId, 'GROUP', id, false);
  }

  @Post(':organisationId/groups/:id/reactivate')
  reactivateGroup(
    @Req() req: Req,
    @Param('organisationId', ParseIntPipe) organisationId: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.structure.setActiveForOrganisation(req.user, organisationId, 'GROUP', id, true);
  }

  @Delete(':organisationId/groups/:id')
  deleteGroup(
    @Req() req: Req,
    @Param('organisationId', ParseIntPipe) organisationId: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.structure.removeForOrganisation(req.user, organisationId, 'GROUP', id);
  }

  @Post(':organisationId/clusters')
  createCluster(
    @Req() req: Req,
    @Param('organisationId', ParseIntPipe) organisationId: number,
    @Body() dto: CreateClusterDto,
  ) {
    return this.mutate(req.user, organisationId, 'CLUSTER', dto);
  }

  @Patch(':organisationId/clusters/:id')
  updateCluster(
    @Req() req: Req,
    @Param('organisationId', ParseIntPipe) organisationId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateClusterDto,
  ) {
    return this.structure.updateForOrganisation(req.user, organisationId, 'CLUSTER', id, dto);
  }

  @Post(':organisationId/clusters/:id/deactivate')
  deactivateCluster(
    @Req() req: Req,
    @Param('organisationId', ParseIntPipe) organisationId: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.structure.setActiveForOrganisation(req.user, organisationId, 'CLUSTER', id, false);
  }

  @Post(':organisationId/clusters/:id/reactivate')
  reactivateCluster(
    @Req() req: Req,
    @Param('organisationId', ParseIntPipe) organisationId: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.structure.setActiveForOrganisation(req.user, organisationId, 'CLUSTER', id, true);
  }

  @Delete(':organisationId/clusters/:id')
  deleteCluster(
    @Req() req: Req,
    @Param('organisationId', ParseIntPipe) organisationId: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.structure.removeForOrganisation(req.user, organisationId, 'CLUSTER', id);
  }

  @Post(':organisationId/territories')
  createTerritory(
    @Req() req: Req,
    @Param('organisationId', ParseIntPipe) organisationId: number,
    @Body() dto: CreateTerritoryDto,
  ) {
    return this.mutate(req.user, organisationId, 'TERRITORY', dto);
  }

  @Patch(':organisationId/territories/:id')
  updateTerritory(
    @Req() req: Req,
    @Param('organisationId', ParseIntPipe) organisationId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateTerritoryDto,
  ) {
    return this.structure.updateForOrganisation(req.user, organisationId, 'TERRITORY', id, dto);
  }

  @Post(':organisationId/territories/:id/deactivate')
  deactivateTerritory(
    @Req() req: Req,
    @Param('organisationId', ParseIntPipe) organisationId: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.structure.setActiveForOrganisation(req.user, organisationId, 'TERRITORY', id, false);
  }

  @Post(':organisationId/territories/:id/reactivate')
  reactivateTerritory(
    @Req() req: Req,
    @Param('organisationId', ParseIntPipe) organisationId: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.structure.setActiveForOrganisation(req.user, organisationId, 'TERRITORY', id, true);
  }

  @Delete(':organisationId/territories/:id')
  deleteTerritory(
    @Req() req: Req,
    @Param('organisationId', ParseIntPipe) organisationId: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.structure.removeForOrganisation(req.user, organisationId, 'TERRITORY', id);
  }

  private mutate(
    caller: Jwtpayload,
    organisationId: number,
    dimension: Dimension,
    dto: { name: string; code?: string; description?: string },
  ) {
    return this.structure.createForOrganisation(caller, organisationId, dimension, dto);
  }
}
