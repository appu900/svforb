import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AuditArea, Prisma } from '@prisma/client';
import { PrismaService } from '../../../infra/prisma/prisma.service';
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
import { ENTERPRISE_ERROR } from '../enterprise.constants';
import { PERMISSION } from '../enterprise.permissions';
import { EnterpriseAuditService } from './enterprise-audit.service';
import { EnterpriseScopeService } from './enterprise-scope.service';

/**
 * The three reporting dimensions. They are independent of one another — a site
 * carries at most one of each, and a Cluster does not sit inside a Group.
 */
export type Dimension = 'GROUP' | 'CLUSTER' | 'TERRITORY';

const LABEL: Record<Dimension, string> = {
  GROUP: 'Group',
  CLUSTER: 'Cluster',
  TERRITORY: 'Territory',
};

export interface StructureRow {
  id: number;
  name: string;
  code: string | null;
  description: string | null;
  isActive: boolean;
  deactivatedAt: Date | null;
  createdAt: Date;
}

export interface SiteRef {
  id: number;
  name: string;
}

/**
 * Groups, Clusters and Territories: three independent ways to slice the same
 * set of sites, each managed the same way.
 *
 * Two rules run through everything here. Structures with history are never
 * deleted, only deactivated — and deactivating a structure must never take its
 * sites down with it.
 */
@Injectable()
export class EnterpriseStructureService {
  private readonly logger = new Logger(EnterpriseStructureService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: EnterpriseScopeService,
    private readonly audit: EnterpriseAuditService,
  ) {}

  // ─── Groups ────────────────────────────────────────────────────────────────

  async createGroup(caller: Jwtpayload, dto: CreateGroupDto) {
    return this.create(caller, 'GROUP', dto);
  }

  async listGroups(caller: Jwtpayload, query?: StructureListQueryDto) {
    return this.list(caller, 'GROUP', query);
  }

  async getGroup(caller: Jwtpayload, groupId: number) {
    return this.getOne(caller, 'GROUP', groupId);
  }

  async updateGroup(caller: Jwtpayload, groupId: number, dto: UpdateGroupDto) {
    return this.update(caller, 'GROUP', groupId, dto);
  }

  async deactivateGroup(caller: Jwtpayload, groupId: number) {
    return this.setActive(caller, 'GROUP', groupId, false);
  }

  async reactivateGroup(caller: Jwtpayload, groupId: number) {
    return this.setActive(caller, 'GROUP', groupId, true);
  }

  async deleteGroup(caller: Jwtpayload, groupId: number) {
    return this.remove(caller, 'GROUP', groupId);
  }

  async assignSitesToGroup(caller: Jwtpayload, groupId: number, dto: AssignSitesDto) {
    return this.assignSites(caller, 'GROUP', groupId, dto);
  }

  async unassignSiteFromGroup(caller: Jwtpayload, siteId: number) {
    return this.unassignSite(caller, 'GROUP', siteId);
  }

  // ─── Clusters ──────────────────────────────────────────────────────────────

  async createCluster(caller: Jwtpayload, dto: CreateClusterDto) {
    return this.create(caller, 'CLUSTER', dto);
  }

  async listClusters(caller: Jwtpayload, query?: StructureListQueryDto) {
    return this.list(caller, 'CLUSTER', query);
  }

  async getCluster(caller: Jwtpayload, clusterId: number) {
    return this.getOne(caller, 'CLUSTER', clusterId);
  }

  async updateCluster(caller: Jwtpayload, clusterId: number, dto: UpdateClusterDto) {
    return this.update(caller, 'CLUSTER', clusterId, dto);
  }

  async deactivateCluster(caller: Jwtpayload, clusterId: number) {
    return this.setActive(caller, 'CLUSTER', clusterId, false);
  }

  async reactivateCluster(caller: Jwtpayload, clusterId: number) {
    return this.setActive(caller, 'CLUSTER', clusterId, true);
  }

  async deleteCluster(caller: Jwtpayload, clusterId: number) {
    return this.remove(caller, 'CLUSTER', clusterId);
  }

  async assignSitesToCluster(caller: Jwtpayload, clusterId: number, dto: AssignSitesDto) {
    return this.assignSites(caller, 'CLUSTER', clusterId, dto);
  }

  async unassignSiteFromCluster(caller: Jwtpayload, siteId: number) {
    return this.unassignSite(caller, 'CLUSTER', siteId);
  }

  // ─── Territories ───────────────────────────────────────────────────────────

  async createTerritory(caller: Jwtpayload, dto: CreateTerritoryDto) {
    return this.create(caller, 'TERRITORY', dto);
  }

  async listTerritories(caller: Jwtpayload, query?: StructureListQueryDto) {
    return this.list(caller, 'TERRITORY', query);
  }

  async getTerritory(caller: Jwtpayload, territoryId: number) {
    return this.getOne(caller, 'TERRITORY', territoryId);
  }

  async updateTerritory(caller: Jwtpayload, territoryId: number, dto: UpdateTerritoryDto) {
    return this.update(caller, 'TERRITORY', territoryId, dto);
  }

  async deactivateTerritory(caller: Jwtpayload, territoryId: number) {
    return this.setActive(caller, 'TERRITORY', territoryId, false);
  }

  async reactivateTerritory(caller: Jwtpayload, territoryId: number) {
    return this.setActive(caller, 'TERRITORY', territoryId, true);
  }

  async deleteTerritory(caller: Jwtpayload, territoryId: number) {
    return this.remove(caller, 'TERRITORY', territoryId);
  }

  async assignSitesToTerritory(caller: Jwtpayload, territoryId: number, dto: AssignSitesDto) {
    return this.assignSites(caller, 'TERRITORY', territoryId, dto);
  }

  async unassignSiteFromTerritory(caller: Jwtpayload, siteId: number) {
    return this.unassignSite(caller, 'TERRITORY', siteId);
  }

  // ─── Shared implementation ─────────────────────────────────────────────────

  private async create(
    caller: Jwtpayload,
    dimension: Dimension,
    dto: { name: string; code?: string; description?: string },
  ) {
    const orgId = await this.scope.assertPermission(caller, PERMISSION.STRUCTURE_CREATE);

    const clash = await this.findByName(dimension, orgId, dto.name);
    if (clash) {
      throw new ConflictException(
        `A ${LABEL[dimension].toLowerCase()} named "${dto.name}" already exists.`,
      );
    }

    const data = {
      organisationId: orgId,
      name: dto.name,
      code: dto.code ?? null,
      description: dto.description ?? null,
    };

    const created =
      dimension === 'GROUP'
        ? await this.prisma.enterpriseGroup.create({ data })
        : dimension === 'CLUSTER'
          ? await this.prisma.cluster.create({ data })
          : await this.prisma.territory.create({ data });

    await this.audit.recordFor(caller, {
      organisationId: orgId,
      area: AuditArea.ORGANISATION_STRUCTURE,
      action: `${dimension.toLowerCase()}.created`,
      entityType: LABEL[dimension],
      entityId: created.id,
      entityLabel: created.name,
      newValue: { name: created.name, code: created.code },
      summary: `${LABEL[dimension]} "${created.name}" created`,
    });

    this.logger.log(
      `${LABEL[dimension]} created: id=${created.id} org=${orgId} by=${caller.sub}`,
    );
    return this.shape(created, 0);
  }

  /**
   * Deactivated structures drop out of the list by default — they stay
   * reportable but should not clutter a picker. `includeInactive` brings them
   * back for the management screen.
   */
  private async list(
    caller: Jwtpayload,
    dimension: Dimension,
    query?: StructureListQueryDto,
  ) {
    const orgId = await this.scope.assertPermission(caller, PERMISSION.STRUCTURE_VIEW);
    const visibility = await this.visibility(caller, orgId);

    const where = {
      organisationId: orgId,
      ...(query?.includeInactive ? {} : { isActive: true }),
      ...(query?.search
        ? {
            OR: [
              { name: { contains: query.search, mode: Prisma.QueryMode.insensitive } },
              { code: { contains: query.search, mode: Prisma.QueryMode.insensitive } },
            ],
          }
        : {}),
    };
    const orderBy = { name: Prisma.SortOrder.asc };

    const rows =
      dimension === 'GROUP'
        ? await this.prisma.enterpriseGroup.findMany({
            where,
            orderBy,
            include: { groupSites: { select: { siteId: true } } },
          })
        : dimension === 'CLUSTER'
          ? await this.prisma.cluster.findMany({
              where,
              orderBy,
              include: { clusterSites: { select: { siteId: true } } },
            })
          : await this.prisma.territory.findMany({
              where,
              orderBy,
              include: { territorySites: { select: { siteId: true } } },
            });

    return rows
      .map((row) => ({
        row,
        siteIds: this.siteIdsOf(dimension, row),
      }))
      .filter(({ row, siteIds }) => visibility.canSee(dimension, row.id, siteIds))
      .map(({ row, siteIds }) => this.shape(row, siteIds.length));
  }

  /**
   * A scoped user opening a structure sees their slice of it — the sites they
   * can reach — rather than a 403 for a structure that also holds somebody
   * else's. They see nothing at all only when the overlap is empty, and then
   * it reads as not found rather than as a structure they are locked out of.
   */
  private async getOne(caller: Jwtpayload, dimension: Dimension, id: number) {
    const orgId = await this.scope.assertPermission(caller, PERMISSION.STRUCTURE_VIEW);
    const row = await this.requireStructure(dimension, id, orgId);

    const allSites = await this.assignedSites(dimension, id);
    const allowed = await this.scope.getAllowedSiteIds(caller);

    let sites = allSites;
    if (allowed !== null) {
      const reach = new Set(allowed);
      sites = allSites.filter((site) => reach.has(site.id));

      if (!sites.length) {
        const visibility = await this.visibility(caller, orgId);
        const visible = visibility.canSee(
          dimension,
          id,
          allSites.map((site) => site.id),
        );
        if (!visible) throw new NotFoundException(`${LABEL[dimension]} not found`);
      }
    }

    const history = await this.countHistory(dimension, id);

    return {
      ...this.shape(row, sites.length),
      sites,
      /** Total across the Enterprise, so a scoped view says what it is missing. */
      siteCountTotal: allSites.length,
      history: {
        listings: history.listings,
        claims: history.claims,
        /** False means this structure can still be deleted outright. */
        hasHistory: history.total > 0,
      },
    };
  }

  private async update(
    caller: Jwtpayload,
    dimension: Dimension,
    id: number,
    dto: { name?: string; code?: string; description?: string },
  ) {
    const orgId = await this.assertCanManage(caller, dimension, id);
    const before = await this.requireStructure(dimension, id, orgId);

    if (dto.name && dto.name !== before.name) {
      const clash = await this.findByName(dimension, orgId, dto.name);
      if (clash && clash.id !== id) {
        throw new ConflictException(
          `A ${LABEL[dimension].toLowerCase()} named "${dto.name}" already exists.`,
        );
      }
    }

    const data = {
      ...(dto.name !== undefined && { name: dto.name }),
      ...(dto.code !== undefined && { code: dto.code }),
      ...(dto.description !== undefined && { description: dto.description }),
    };
    if (!Object.keys(data).length) {
      throw new BadRequestException('Nothing to update');
    }

    const updated = await this.updateRow(dimension, id, data);

    const changed = EnterpriseAuditService.diff(
      { name: before.name, code: before.code, description: before.description },
      data,
    );
    if (changed) {
      await this.audit.recordFor(caller, {
        organisationId: orgId,
        area: AuditArea.ORGANISATION_STRUCTURE,
        action: `${dimension.toLowerCase()}.updated`,
        entityType: LABEL[dimension],
        entityId: id,
        entityLabel: updated.name,
        previousValue: changed.previous,
        newValue: changed.next,
        summary: `${LABEL[dimension]} "${before.name}" updated (${Object.keys(
          changed.next,
        ).join(', ')})`,
      });
    }

    const sites = await this.assignedSites(dimension, id);
    return this.shape(updated, sites.length);
  }

  /**
   * Deactivation is the delete path for anything with history.
   *
   * The sites keep running and keep reporting: a deactivated structure simply
   * stops being offered as somewhere to put new sites.
   */
  private async setActive(
    caller: Jwtpayload,
    dimension: Dimension,
    id: number,
    isActive: boolean,
  ) {
    const orgId = await this.assertCanManage(caller, dimension, id);
    const before = await this.requireStructure(dimension, id, orgId);

    if (before.isActive === isActive) {
      throw new ConflictException({
        error: ENTERPRISE_ERROR.ALREADY_DEACTIVATED,
        message: `"${before.name}" is already ${isActive ? 'active' : 'deactivated'}.`,
      });
    }

    const sites = await this.assignedSites(dimension, id);
    const updated = await this.updateRow(dimension, id, {
      isActive,
      deactivatedAt: isActive ? null : new Date(),
    });

    await this.audit.recordFor(caller, {
      organisationId: orgId,
      area: AuditArea.ORGANISATION_STRUCTURE,
      action: `${dimension.toLowerCase()}.${isActive ? 'reactivated' : 'deactivated'}`,
      entityType: LABEL[dimension],
      entityId: id,
      entityLabel: before.name,
      previousValue: { isActive: before.isActive },
      newValue: { isActive },
      summary: `${LABEL[dimension]} "${before.name}" ${
        isActive ? 'reactivated' : 'deactivated'
      }${sites.length ? ` (${sites.length} site(s) unaffected)` : ''}`,
    });

    return {
      message: isActive
        ? `${LABEL[dimension]} "${before.name}" reactivated.`
        : `${LABEL[dimension]} "${before.name}" deactivated. Its ${sites.length} site(s) are unaffected and keep reporting.`,
      ...this.shape(updated, sites.length),
      /** Named to be shown as reassurance, not as a warning. */
      sitesUnaffected: sites,
    };
  }

  /**
   * Permanent deletion, only ever where nothing depends on it.
   *
   * Both refusals list what is in the way, because "cannot delete" without the
   * affected sites leaves the administrator with nowhere to go.
   */
  private async remove(caller: Jwtpayload, dimension: Dimension, id: number) {
    const orgId = await this.scope.assertPermission(caller, PERMISSION.STRUCTURE_DELETE);
    const row = await this.requireStructure(dimension, id, orgId);

    const [history, sites] = await Promise.all([
      this.countHistory(dimension, id),
      this.assignedSites(dimension, id),
    ]);

    if (history.total > 0) {
      throw new ConflictException({
        error: ENTERPRISE_ERROR.STRUCTURE_HAS_HISTORY,
        message:
          `"${row.name}" appears on ${history.total} historical record(s) and cannot be ` +
          `deleted without rewriting past reporting. Deactivate it instead — it will ` +
          `stop being offered for new sites but keep its history.`,
        listings: history.listings,
        claims: history.claims,
        sites,
      });
    }

    if (sites.length) {
      throw new ConflictException({
        error: ENTERPRISE_ERROR.STRUCTURE_HAS_SITES,
        message:
          `"${row.name}" still holds ${sites.length} site(s). Remove them first, or ` +
          `deactivate it to keep the assignments.`,
        sites,
      });
    }

    await this.deleteRow(dimension, id);

    await this.audit.recordFor(caller, {
      organisationId: orgId,
      area: AuditArea.ORGANISATION_STRUCTURE,
      action: `${dimension.toLowerCase()}.deleted`,
      entityType: LABEL[dimension],
      entityId: id,
      entityLabel: row.name,
      previousValue: { name: row.name, code: row.code },
      summary: `${LABEL[dimension]} "${row.name}" deleted (held no sites and no history)`,
    });

    this.logger.log(`${LABEL[dimension]} deleted: id=${id} org=${orgId} by=${caller.sub}`);
    return { message: `${LABEL[dimension]} "${row.name}" deleted.` };
  }

  // ─── Site assignment ───────────────────────────────────────────────────────

  /**
   * Tags sites into this structure. A site carries at most one Group, one
   * Cluster and one Territory, so assigning moves it rather than adding.
   */
  private async assignSites(
    caller: Jwtpayload,
    dimension: Dimension,
    id: number,
    dto: AssignSitesDto,
  ) {
    const orgId = await this.assertCanManage(caller, dimension, id);
    const target = await this.requireStructure(dimension, id, orgId);

    if (!target.isActive) {
      throw new ConflictException({
        error: ENTERPRISE_ERROR.ALREADY_DEACTIVATED,
        message: `"${target.name}" is deactivated and cannot take new sites. Reactivate it first.`,
      });
    }

    const siteIds = [...new Set(dto.siteIds)];
    await this.assertSitesInOrg(siteIds, orgId);
    // Nobody may pull a site they cannot see into a structure they can.
    await this.scope.assertSitesWithinReach(caller, siteIds);

    const before = await this.currentAssignments(dimension, siteIds);

    await this.prisma.$transaction(
      siteIds.map((siteId) =>
        this.upsertAssignment(dimension, id, siteId, caller.sub, orgId),
      ),
    );

    const moved = siteIds.filter((s) => {
      const prev = before.get(s);
      return prev !== undefined && prev !== id;
    });

    await this.audit.recordFor(caller, {
      organisationId: orgId,
      area: AuditArea.ORGANISATION_STRUCTURE,
      action: `${dimension.toLowerCase()}.sites_assigned`,
      entityType: LABEL[dimension],
      entityId: id,
      entityLabel: target.name,
      previousValue: { siteIds: [...before.keys()], assignments: [...before.values()] },
      newValue: { siteIds },
      summary:
        `${siteIds.length} site(s) assigned to ${LABEL[dimension].toLowerCase()} ` +
        `"${target.name}"${moved.length ? `, ${moved.length} moved from another` : ''}`,
    });

    return {
      message: `${siteIds.length} site(s) assigned to "${target.name}".`,
      assigned: siteIds.length,
      /** Sites that were in a different one of this dimension and have moved. */
      movedFromAnother: moved.length,
      sites: await this.assignedSites(dimension, id),
    };
  }

  private async unassignSite(caller: Jwtpayload, dimension: Dimension, siteId: number) {
    const orgId = await this.scope.assertPermission(caller, PERMISSION.STRUCTURE_MANAGE);
    await this.assertSitesInOrg([siteId], orgId);
    await this.scope.assertSitesWithinReach(caller, [siteId]);

    const current = (await this.currentAssignments(dimension, [siteId])).get(siteId);
    if (current === undefined) {
      throw new NotFoundException(
        `That site is not assigned to a ${LABEL[dimension].toLowerCase()}.`,
      );
    }
    await this.scope.assertStructureWithinReach(caller, orgId, dimension, current);

    await this.deleteAssignment(dimension, siteId);

    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: { name: true, organisationName: true },
    });
    const siteName = site?.name ?? site?.organisationName ?? `Site ${siteId}`;

    await this.audit.recordFor(caller, {
      organisationId: orgId,
      area: AuditArea.ORGANISATION_STRUCTURE,
      action: `${dimension.toLowerCase()}.site_unassigned`,
      entityType: 'Site',
      entityId: siteId,
      entityLabel: siteName,
      previousValue: { [`${dimension.toLowerCase()}Id`]: current },
      newValue: { [`${dimension.toLowerCase()}Id`]: null },
      summary: `${siteName} removed from its ${LABEL[dimension].toLowerCase()}`,
    });

    return { message: `${siteName} removed from its ${LABEL[dimension].toLowerCase()}.` };
  }

  // ─── Overview ──────────────────────────────────────────────────────────────

  /** All three dimensions side by side, plus what is not yet placed in each. */
  async getStructure(caller: Jwtpayload) {
    const orgId = await this.scope.assertPermission(caller, PERMISSION.STRUCTURE_VIEW);
    return this.getStructureForOrganisation(orgId);
  }

  async getStructureForOrganisation(organisationId: number) {
    const [groups, clusters, territories, sites] = await Promise.all([
      this.prisma.enterpriseGroup.findMany({
        where: { organisationId },
        orderBy: { name: 'asc' },
        include: { groupSites: { select: { siteId: true } } },
      }),
      this.prisma.cluster.findMany({
        where: { organisationId },
        orderBy: { name: 'asc' },
        include: { clusterSites: { select: { siteId: true } } },
      }),
      this.prisma.territory.findMany({
        where: { organisationId },
        orderBy: { name: 'asc' },
        include: { territorySites: { select: { siteId: true } } },
      }),
      this.prisma.site.findMany({
        where: { organisationId },
        select: {
          id: true,
          name: true,
          organisationName: true,
          isActive: true,
          groupSite: { select: { groupId: true } },
          clusterSite: { select: { clusterId: true } },
          territorySite: { select: { territoryId: true } },
        },
      }),
    ]);

    const named = (s: (typeof sites)[number]): SiteRef => ({
      id: s.id,
      name: s.name ?? s.organisationName,
    });

    const summarise = (rows: Array<StructureRow & { count: number }>) =>
      rows.map((r) => this.shape(r, r.count));

    return {
      totalSites: sites.length,
      groups: summarise(groups.map((g) => ({ ...g, count: g.groupSites.length }))),
      clusters: summarise(clusters.map((c) => ({ ...c, count: c.clusterSites.length }))),
      territories: summarise(
        territories.map((t) => ({ ...t, count: t.territorySites.length })),
      ),
      // Independent dimensions, so a site can be unplaced in one and placed in
      // the others — each list stands on its own.
      unplaced: {
        groups: sites.filter((s) => !s.groupSite).map(named),
        clusters: sites.filter((s) => !s.clusterSite).map(named),
        territories: sites.filter((s) => !s.territorySite).map(named),
      },
    };
  }

  // ─── Guards ────────────────────────────────────────────────────────────────

  /**
   * Role plus scope: the permission says the caller manages structures at all,
   * the reach check says they manage *this* one.
   */
  private async assertCanManage(
    caller: Jwtpayload,
    dimension: Dimension,
    id: number,
  ): Promise<number> {
    const orgId = await this.scope.assertPermission(caller, PERMISSION.STRUCTURE_MANAGE);
    await this.requireStructure(dimension, id, orgId);
    await this.scope.assertStructureWithinReach(caller, orgId, dimension, id);
    return orgId;
  }

  private async assertSitesInOrg(siteIds: number[], orgId: number) {
    if (!siteIds.length) throw new BadRequestException('No siteIds supplied');

    const count = await this.prisma.site.count({
      where: { id: { in: siteIds }, organisationId: orgId },
    });
    if (count !== siteIds.length) {
      throw new NotFoundException('One or more sites do not belong to your organisation');
    }
  }

  /**
   * What a caller may see in a listing: everything, or only structures holding
   * a site they can reach — plus any structure named directly in their own
   * scope grants, which covers one they have been given but not yet filled.
   */
  private async visibility(caller: Jwtpayload, orgId: number) {
    const allowed = await this.scope.getAllowedSiteIds(caller);
    if (allowed === null) return { canSee: () => true };

    const allowedSites = new Set(allowed);
    const grants = await this.prisma.userScope.findMany({
      where: { userId: caller.sub, organisationId: orgId },
      select: { scopeType: true, scopeId: true },
    });
    const granted = new Set(grants.map((g) => `${g.scopeType}:${g.scopeId ?? ''}`));

    return {
      canSee: (dimension: Dimension, id: number, siteIds: number[]) =>
        granted.has(`${dimension}:${id}`) ||
        siteIds.some((siteId) => allowedSites.has(siteId)),
    };
  }

  // ─── Per-dimension plumbing ────────────────────────────────────────────────

  private async requireStructure(
    dimension: Dimension,
    id: number,
    orgId: number,
  ): Promise<StructureRow> {
    const where = { id, organisationId: orgId };
    const found =
      dimension === 'GROUP'
        ? await this.prisma.enterpriseGroup.findFirst({ where })
        : dimension === 'CLUSTER'
          ? await this.prisma.cluster.findFirst({ where })
          : await this.prisma.territory.findFirst({ where });

    if (!found) throw new NotFoundException(`${LABEL[dimension]} not found`);
    return found;
  }

  private async findByName(dimension: Dimension, orgId: number, name: string) {
    const where = { organisationId: orgId, name };
    return dimension === 'GROUP'
      ? this.prisma.enterpriseGroup.findFirst({ where, select: { id: true } })
      : dimension === 'CLUSTER'
        ? this.prisma.cluster.findFirst({ where, select: { id: true } })
        : this.prisma.territory.findFirst({ where, select: { id: true } });
  }

  private async updateRow(
    dimension: Dimension,
    id: number,
    data: {
      name?: string;
      code?: string | null;
      description?: string | null;
      isActive?: boolean;
      deactivatedAt?: Date | null;
    },
  ): Promise<StructureRow> {
    return dimension === 'GROUP'
      ? this.prisma.enterpriseGroup.update({ where: { id }, data })
      : dimension === 'CLUSTER'
        ? this.prisma.cluster.update({ where: { id }, data })
        : this.prisma.territory.update({ where: { id }, data });
  }

  private async deleteRow(dimension: Dimension, id: number) {
    if (dimension === 'GROUP') {
      await this.prisma.enterpriseGroup.delete({ where: { id } });
    } else if (dimension === 'CLUSTER') {
      await this.prisma.cluster.delete({ where: { id } });
    } else {
      await this.prisma.territory.delete({ where: { id } });
    }
  }

  /** Every site currently tagged into this structure. */
  private async assignedSites(dimension: Dimension, id: number): Promise<SiteRef[]> {
    const select = {
      site: { select: { id: true, name: true, organisationName: true } },
    };
    const rows =
      dimension === 'GROUP'
        ? await this.prisma.groupSite.findMany({ where: { groupId: id }, select })
        : dimension === 'CLUSTER'
          ? await this.prisma.clusterSite.findMany({ where: { clusterId: id }, select })
          : await this.prisma.territorySite.findMany({
              where: { territoryId: id },
              select,
            });

    return rows
      .map((r) => ({ id: r.site.id, name: r.site.name ?? r.site.organisationName }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** siteId -> the structure of this dimension it currently sits in. */
  private async currentAssignments(
    dimension: Dimension,
    siteIds: number[],
  ): Promise<Map<number, number>> {
    const where = { siteId: { in: siteIds } };
    const map = new Map<number, number>();

    if (dimension === 'GROUP') {
      const rows = await this.prisma.groupSite.findMany({
        where,
        select: { siteId: true, groupId: true },
      });
      rows.forEach((r) => map.set(r.siteId, r.groupId));
    } else if (dimension === 'CLUSTER') {
      const rows = await this.prisma.clusterSite.findMany({
        where,
        select: { siteId: true, clusterId: true },
      });
      rows.forEach((r) => map.set(r.siteId, r.clusterId));
    } else {
      const rows = await this.prisma.territorySite.findMany({
        where,
        select: { siteId: true, territoryId: true },
      });
      rows.forEach((r) => map.set(r.siteId, r.territoryId));
    }
    return map;
  }

  private upsertAssignment(
    dimension: Dimension,
    id: number,
    siteId: number,
    actorId: number,
    orgId: number,
  ) {
    const stamp = { assignedBy: actorId, assignedAt: new Date() };

    if (dimension === 'GROUP') {
      return this.prisma.groupSite.upsert({
        where: { siteId },
        // organisationId is denormalised onto GroupSite, so it is set on create
        // and left alone on update — a site never changes organisation.
        create: { siteId, groupId: id, organisationId: orgId, assignedBy: actorId },
        update: { groupId: id, ...stamp },
      });
    }
    if (dimension === 'CLUSTER') {
      return this.prisma.clusterSite.upsert({
        where: { siteId },
        create: { siteId, clusterId: id, assignedBy: actorId },
        update: { clusterId: id, ...stamp },
      });
    }
    return this.prisma.territorySite.upsert({
      where: { siteId },
      create: { siteId, territoryId: id, assignedBy: actorId },
      update: { territoryId: id, ...stamp },
    });
  }

  private async deleteAssignment(dimension: Dimension, siteId: number) {
    if (dimension === 'GROUP') {
      await this.prisma.groupSite.deleteMany({ where: { siteId } });
    } else if (dimension === 'CLUSTER') {
      await this.prisma.clusterSite.deleteMany({ where: { siteId } });
    } else {
      await this.prisma.territorySite.deleteMany({ where: { siteId } });
    }
  }

  /**
   * Listings and claims stamped with this structure at the time they happened.
   * Non-zero means deleting it would rewrite past reporting.
   */
  private async countHistory(dimension: Dimension, id: number) {
    const where =
      dimension === 'GROUP'
        ? { snapshotGroupId: id }
        : dimension === 'CLUSTER'
          ? { snapshotClusterId: id }
          : { snapshotTerritoryId: id };

    const [listings, claims] = await Promise.all([
      this.prisma.foodListing.count({ where }),
      this.prisma.foodClaim.count({ where }),
    ]);
    return { listings, claims, total: listings + claims };
  }

  private siteIdsOf(dimension: Dimension, row: unknown): number[] {
    const r = row as {
      groupSites?: Array<{ siteId: number }>;
      clusterSites?: Array<{ siteId: number }>;
      territorySites?: Array<{ siteId: number }>;
    };
    const rows =
      dimension === 'GROUP'
        ? r.groupSites
        : dimension === 'CLUSTER'
          ? r.clusterSites
          : r.territorySites;
    return (rows ?? []).map((x) => x.siteId);
  }

  /** One response shape for all three dimensions, so the tabs can share a component. */
  private shape(row: StructureRow, siteCount: number) {
    return {
      id: row.id,
      name: row.name,
      code: row.code,
      description: row.description,
      isActive: row.isActive,
      deactivatedAt: row.deactivatedAt,
      siteCount,
      createdAt: row.createdAt,
    };
  }
}
