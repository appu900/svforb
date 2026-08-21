import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OrgRole } from '@prisma/client';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import {
  AssignSitesDto,
  CreateClusterDto,
  CreateGroupDto,
  CreateTerritoryDto,
  UpdateClusterDto,
  UpdateGroupDto,
  UpdateTerritoryDto,
} from '../dto/enterprise.dto';
import { ENTERPRISE_ERROR } from '../enterprise.constants';
import { EnterpriseScopeService } from './enterprise-scope.service';

/**
 * CRUD for the Enterprise reporting structure: Group -> Cluster -> Site, plus
 * the independent Territory dimension.
 */
@Injectable()
export class EnterpriseStructureService {
  private readonly logger = new Logger(EnterpriseStructureService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: EnterpriseScopeService,
  ) {}

  // ─── Groups ────────────────────────────────────────────────────────────────

  async createGroup(caller: Jwtpayload, dto: CreateGroupDto) {
    const orgId = await this.assertAdmin(caller);

    const existing = await this.prisma.enterpriseGroup.findFirst({
      where: { organisationId: orgId, name: dto.name },
    });
    if (existing) throw new ConflictException('A group with that name already exists');

    const group = await this.prisma.enterpriseGroup.create({
      data: { organisationId: orgId, name: dto.name, code: dto.code },
    });
    this.logger.log(`Group created: id=${group.id} org=${orgId} by=${caller.sub}`);
    return group;
  }

  async listGroups(caller: Jwtpayload) {
    const orgId = await this.scope.assertEnterprise(caller);

    const groups = await this.prisma.enterpriseGroup.findMany({
      where: { organisationId: orgId },
      orderBy: { name: 'asc' },
      include: {
        clusters: {
          select: { id: true, name: true, _count: { select: { clusterSites: true } } },
        },
      },
    });

    return groups.map((g) => ({
      id: g.id,
      name: g.name,
      code: g.code,
      isActive: g.isActive,
      clusterCount: g.clusters.length,
      siteCount: g.clusters.reduce((n, c) => n + c._count.clusterSites, 0),
      clusters: g.clusters.map((c) => ({
        id: c.id,
        name: c.name,
        siteCount: c._count.clusterSites,
      })),
      createdAt: g.createdAt,
    }));
  }

  async getGroup(caller: Jwtpayload, groupId: number) {
    const orgId = await this.scope.assertEnterprise(caller);
    const group = await this.prisma.enterpriseGroup.findFirst({
      where: { id: groupId, organisationId: orgId },
      include: {
        clusters: {
          orderBy: { name: 'asc' },
          include: {
            clusterSites: {
              include: { site: { select: { id: true, organisationName: true, isActive: true } } },
            },
          },
        },
      },
    });
    if (!group) throw new NotFoundException('Group not found');

    return {
      id: group.id,
      name: group.name,
      code: group.code,
      isActive: group.isActive,
      clusters: group.clusters.map((c) => ({
        id: c.id,
        name: c.name,
        code: c.code,
        isActive: c.isActive,
        sites: c.clusterSites.map((cs) => ({
          id: cs.site.id,
          name: cs.site.organisationName,
          isActive: cs.site.isActive,
        })),
      })),
    };
  }

  async updateGroup(caller: Jwtpayload, groupId: number, dto: UpdateGroupDto) {
    const orgId = await this.assertAdmin(caller);
    await this.assertGroupInOrg(groupId, orgId);

    return this.prisma.enterpriseGroup.update({ where: { id: groupId }, data: dto });
  }

  /** Refuses while clusters still point at it, rather than orphaning them. */
  async deleteGroup(caller: Jwtpayload, groupId: number) {
    const orgId = await this.assertAdmin(caller);
    await this.assertGroupInOrg(groupId, orgId);

    const clusterCount = await this.prisma.cluster.count({ where: { groupId } });
    if (clusterCount > 0) {
      throw new ConflictException({
        error: ENTERPRISE_ERROR.GROUP_HAS_CLUSTERS,
        message: `This group still has ${clusterCount} cluster(s). Move or delete them first.`,
        clusterCount,
      });
    }

    await this.prisma.enterpriseGroup.delete({ where: { id: groupId } });
    this.logger.log(`Group deleted: id=${groupId} org=${orgId} by=${caller.sub}`);
    return { message: 'Group deleted' };
  }

  // ─── Clusters ──────────────────────────────────────────────────────────────

  async createCluster(caller: Jwtpayload, dto: CreateClusterDto) {
    const orgId = await this.assertAdmin(caller);
    await this.assertGroupInOrg(dto.groupId, orgId);

    const existing = await this.prisma.cluster.findFirst({
      where: { organisationId: orgId, name: dto.name },
    });
    if (existing) throw new ConflictException('A cluster with that name already exists');

    const cluster = await this.prisma.cluster.create({
      data: {
        organisationId: orgId,
        groupId: dto.groupId,
        name: dto.name,
        code: dto.code,
      },
    });
    this.logger.log(`Cluster created: id=${cluster.id} group=${dto.groupId} by=${caller.sub}`);
    return cluster;
  }

  async listClusters(caller: Jwtpayload, groupId?: number) {
    const orgId = await this.scope.assertEnterprise(caller);

    const clusters = await this.prisma.cluster.findMany({
      where: { organisationId: orgId, ...(groupId ? { groupId } : {}) },
      orderBy: { name: 'asc' },
      include: {
        group: { select: { id: true, name: true } },
        _count: { select: { clusterSites: true } },
      },
    });

    return clusters.map((c) => ({
      id: c.id,
      name: c.name,
      code: c.code,
      isActive: c.isActive,
      group: c.group,
      siteCount: c._count.clusterSites,
      createdAt: c.createdAt,
    }));
  }

  async getCluster(caller: Jwtpayload, clusterId: number) {
    const orgId = await this.scope.assertEnterprise(caller);
    const cluster = await this.prisma.cluster.findFirst({
      where: { id: clusterId, organisationId: orgId },
      include: {
        group: { select: { id: true, name: true } },
        clusterSites: {
          include: {
            site: {
              select: {
                id: true,
                organisationName: true,
                address: true,
                postcode: true,
                isActive: true,
              },
            },
          },
        },
      },
    });
    if (!cluster) throw new NotFoundException('Cluster not found');

    return {
      id: cluster.id,
      name: cluster.name,
      code: cluster.code,
      isActive: cluster.isActive,
      group: cluster.group,
      sites: cluster.clusterSites.map((cs) => ({
        id: cs.site.id,
        name: cs.site.organisationName,
        address: cs.site.address,
        postcode: cs.site.postcode,
        isActive: cs.site.isActive,
        assignedAt: cs.assignedAt,
      })),
    };
  }

  async updateCluster(caller: Jwtpayload, clusterId: number, dto: UpdateClusterDto) {
    const orgId = await this.assertAdmin(caller);
    await this.assertClusterInOrg(clusterId, orgId);
    if (dto.groupId) await this.assertGroupInOrg(dto.groupId, orgId);

    return this.prisma.cluster.update({ where: { id: clusterId }, data: dto });
  }

  async deleteCluster(caller: Jwtpayload, clusterId: number) {
    const orgId = await this.assertAdmin(caller);
    await this.assertClusterInOrg(clusterId, orgId);

    // Assignments cascade; the sites themselves are untouched.
    await this.prisma.cluster.delete({ where: { id: clusterId } });
    this.logger.log(`Cluster deleted: id=${clusterId} org=${orgId} by=${caller.sub}`);
    return { message: 'Cluster deleted. Its sites are now unassigned.' };
  }

  /** Moves sites into this cluster. A site can only be in one cluster. */
  async assignSitesToCluster(caller: Jwtpayload, clusterId: number, dto: AssignSitesDto) {
    const orgId = await this.assertAdmin(caller);
    await this.assertClusterInOrg(clusterId, orgId);
    await this.assertSitesInOrg(dto.siteIds, orgId);

    const results = await this.prisma.$transaction(
      dto.siteIds.map((siteId) =>
        this.prisma.clusterSite.upsert({
          where: { siteId },
          create: { siteId, clusterId, assignedBy: caller.sub },
          update: { clusterId, assignedBy: caller.sub, assignedAt: new Date() },
        }),
      ),
    );

    this.logger.log(
      `Assigned ${results.length} site(s) to cluster=${clusterId} by=${caller.sub}`,
    );
    return { message: `${results.length} site(s) assigned`, assigned: results.length };
  }

  async unassignSiteFromCluster(caller: Jwtpayload, siteId: number) {
    const orgId = await this.assertAdmin(caller);
    await this.assertSitesInOrg([siteId], orgId);

    const deleted = await this.prisma.clusterSite.deleteMany({ where: { siteId } });
    if (!deleted.count) throw new NotFoundException('That site is not assigned to a cluster');

    return { message: 'Site removed from its cluster' };
  }

  // ─── Territories ───────────────────────────────────────────────────────────

  async createTerritory(caller: Jwtpayload, dto: CreateTerritoryDto) {
    const orgId = await this.assertAdmin(caller);

    const existing = await this.prisma.territory.findFirst({
      where: { organisationId: orgId, name: dto.name },
    });
    if (existing) throw new ConflictException('A territory with that name already exists');

    return this.prisma.territory.create({
      data: { organisationId: orgId, name: dto.name, code: dto.code },
    });
  }

  async listTerritories(caller: Jwtpayload) {
    const orgId = await this.scope.assertEnterprise(caller);

    const territories = await this.prisma.territory.findMany({
      where: { organisationId: orgId },
      orderBy: { name: 'asc' },
      include: { _count: { select: { territorySites: true } } },
    });

    return territories.map((t) => ({
      id: t.id,
      name: t.name,
      code: t.code,
      isActive: t.isActive,
      siteCount: t._count.territorySites,
      createdAt: t.createdAt,
    }));
  }

  async getTerritory(caller: Jwtpayload, territoryId: number) {
    const orgId = await this.scope.assertEnterprise(caller);
    const territory = await this.prisma.territory.findFirst({
      where: { id: territoryId, organisationId: orgId },
      include: {
        territorySites: {
          include: {
            site: { select: { id: true, organisationName: true, isActive: true } },
          },
        },
      },
    });
    if (!territory) throw new NotFoundException('Territory not found');

    return {
      id: territory.id,
      name: territory.name,
      code: territory.code,
      isActive: territory.isActive,
      sites: territory.territorySites.map((ts) => ({
        id: ts.site.id,
        name: ts.site.organisationName,
        isActive: ts.site.isActive,
        assignedAt: ts.assignedAt,
      })),
    };
  }

  async updateTerritory(caller: Jwtpayload, territoryId: number, dto: UpdateTerritoryDto) {
    const orgId = await this.assertAdmin(caller);
    await this.assertTerritoryInOrg(territoryId, orgId);

    return this.prisma.territory.update({ where: { id: territoryId }, data: dto });
  }

  async deleteTerritory(caller: Jwtpayload, territoryId: number) {
    const orgId = await this.assertAdmin(caller);
    await this.assertTerritoryInOrg(territoryId, orgId);

    await this.prisma.territory.delete({ where: { id: territoryId } });
    return { message: 'Territory deleted. Its sites are now unmapped.' };
  }

  async assignSitesToTerritory(caller: Jwtpayload, territoryId: number, dto: AssignSitesDto) {
    const orgId = await this.assertAdmin(caller);
    await this.assertTerritoryInOrg(territoryId, orgId);
    await this.assertSitesInOrg(dto.siteIds, orgId);

    const results = await this.prisma.$transaction(
      dto.siteIds.map((siteId) =>
        this.prisma.territorySite.upsert({
          where: { siteId },
          create: { siteId, territoryId, assignedBy: caller.sub },
          update: { territoryId, assignedBy: caller.sub, assignedAt: new Date() },
        }),
      ),
    );

    return { message: `${results.length} site(s) mapped`, assigned: results.length };
  }

  async unassignSiteFromTerritory(caller: Jwtpayload, siteId: number) {
    const orgId = await this.assertAdmin(caller);
    await this.assertSitesInOrg([siteId], orgId);

    const deleted = await this.prisma.territorySite.deleteMany({ where: { siteId } });
    if (!deleted.count) throw new NotFoundException('That site is not mapped to a territory');

    return { message: 'Site removed from its territory' };
  }

  // ─── Overview ──────────────────────────────────────────────────────────────

  /** The whole tree plus anything not yet placed — backs the admin screen. */
  async getStructure(caller: Jwtpayload) {
    const orgId = await this.scope.assertEnterprise(caller);

    const [groups, territories, sites] = await Promise.all([
      this.prisma.enterpriseGroup.findMany({
        where: { organisationId: orgId },
        orderBy: { name: 'asc' },
        include: {
          clusters: {
            orderBy: { name: 'asc' },
            include: { clusterSites: { select: { siteId: true } } },
          },
        },
      }),
      this.prisma.territory.findMany({
        where: { organisationId: orgId },
        orderBy: { name: 'asc' },
        include: { territorySites: { select: { siteId: true } } },
      }),
      this.prisma.site.findMany({
        where: { organisationId: orgId },
        select: {
          id: true,
          organisationName: true,
          isActive: true,
          clusterSite: { select: { clusterId: true } },
          territorySite: { select: { territoryId: true } },
        },
      }),
    ]);

    return {
      totalSites: sites.length,
      unassignedSites: sites
        .filter((s) => !s.clusterSite)
        .map((s) => ({ id: s.id, name: s.organisationName })),
      groups: groups.map((g) => ({
        id: g.id,
        name: g.name,
        isActive: g.isActive,
        clusters: g.clusters.map((c) => ({
          id: c.id,
          name: c.name,
          isActive: c.isActive,
          siteCount: c.clusterSites.length,
        })),
      })),
      territories: territories.map((t) => ({
        id: t.id,
        name: t.name,
        isActive: t.isActive,
        siteCount: t.territorySites.length,
      })),
    };
  }

  // ─── Guards ────────────────────────────────────────────────────────────────

  /** Structure changes are limited to org admins of an Enterprise. */
  private async assertAdmin(caller: Jwtpayload): Promise<number> {
    const orgId = await this.scope.assertEnterprise(caller);
    if (caller.orgRole !== OrgRole.SUPER_ADMIN) {
      throw new ForbiddenException('Only an organisation admin can change the structure');
    }
    return orgId;
  }

  private async assertGroupInOrg(groupId: number, orgId: number) {
    const found = await this.prisma.enterpriseGroup.findFirst({
      where: { id: groupId, organisationId: orgId },
      select: { id: true },
    });
    if (!found) throw new NotFoundException('Group not found');
  }

  private async assertClusterInOrg(clusterId: number, orgId: number) {
    const found = await this.prisma.cluster.findFirst({
      where: { id: clusterId, organisationId: orgId },
      select: { id: true },
    });
    if (!found) throw new NotFoundException('Cluster not found');
  }

  private async assertTerritoryInOrg(territoryId: number, orgId: number) {
    const found = await this.prisma.territory.findFirst({
      where: { id: territoryId, organisationId: orgId },
      select: { id: true },
    });
    if (!found) throw new NotFoundException('Territory not found');
  }

  /** Blocks assigning a site that belongs to a different organisation. */
  private async assertSitesInOrg(siteIds: number[], orgId: number) {
    if (!siteIds.length) throw new BadRequestException('No siteIds supplied');

    const count = await this.prisma.site.count({
      where: { id: { in: siteIds }, organisationId: orgId },
    });
    if (count !== siteIds.length) {
      throw new NotFoundException('One or more sites do not belong to your organisation');
    }
  }
}
