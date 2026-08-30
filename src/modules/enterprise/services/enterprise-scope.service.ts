import { ForbiddenException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { EnterpriseRole, ScopeType as PrismaScopeType } from '@prisma/client';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import { ENTERPRISE_ERROR, ENTERPRISE_PLAN_NAME, ScopeType } from '../enterprise.constants';
import {
  EnterprisePermission,
  isUnrestricted,
  roleHasPermission,
  roleLabel,
} from '../enterprise.permissions';

export interface ResolvedScope {
  scopeType: ScopeType;
  scopeId: number | null;
  label: string;
  siteIds: number[];
}

/**
 * Turns any reporting dimension into a flat list of site ids.
 *
 * This is the hinge the whole Enterprise reporting story turns on: once a
 * scope is a `number[]`, every existing site-level query works unchanged by
 * swapping `WHERE siteId = x` for `WHERE siteId IN (...)`.
 */
@Injectable()
export class EnterpriseScopeService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * An organisation is an Enterprise when its plan is ENTERPRISE. Subscription
   * *status* is deliberately ignored — a lapsed contract still leaves the
   * hierarchy readable; writes are gated separately by the billing interceptor.
   */
  async isEnterprise(organisationId: number): Promise<boolean> {
    const sub = await this.prisma.orgSubscription.findUnique({
      where: { organisationId },
      select: { plan: { select: { name: true } } },
    });
    return sub?.plan.name === ENTERPRISE_PLAN_NAME;
  }

  /** Throws unless the caller's organisation is on the Enterprise plan. */
  async assertEnterprise(caller: Jwtpayload): Promise<number> {
    if (!caller.orgId) throw new ForbiddenException('Not part of an organisation');

    if (!(await this.isEnterprise(caller.orgId))) {
      throw new ForbiddenException({
        error: ENTERPRISE_ERROR.NOT_ENTERPRISE,
        message:
          'Enterprise features require the Enterprise plan. Contact Saveful to arrange one.',
      });
    }
    return caller.orgId;
  }

  // ─── Resolution ────────────────────────────────────────────────────────────

  /** Every site in the organisation. */
  async resolveEnterprise(orgId: number): Promise<ResolvedScope> {
    const sites = await this.prisma.site.findMany({
      where: { organisationId: orgId },
      select: { id: true },
    });
    const org = await this.prisma.organisation.findUnique({
      where: { id: orgId },
      select: { name: true },
    });
    return {
      scopeType: 'ENTERPRISE',
      scopeId: null,
      label: org?.name ?? 'Enterprise',
      siteIds: sites.map((s) => s.id),
    };
  }

  /**
   * Every site tagged into the group.
   *
   * Group, Territory and Cluster are independent Enterprise-defined dimensions,
   * so this reads GroupSite directly rather than walking a cluster tree.
   */
  async resolveGroup(orgId: number, groupId: number): Promise<ResolvedScope> {
    const group = await this.prisma.enterpriseGroup.findFirst({
      where: { id: groupId, organisationId: orgId },
      select: { name: true, groupSites: { select: { siteId: true } } },
    });
    if (!group) throw new NotFoundException('Group not found');

    return {
      scopeType: 'GROUP',
      scopeId: groupId,
      label: group.name,
      siteIds: group.groupSites.map((gs) => gs.siteId),
    };
  }

  async resolveCluster(orgId: number, clusterId: number): Promise<ResolvedScope> {
    const cluster = await this.prisma.cluster.findFirst({
      where: { id: clusterId, organisationId: orgId },
      select: { name: true, clusterSites: { select: { siteId: true } } },
    });
    if (!cluster) throw new NotFoundException('Cluster not found');

    return {
      scopeType: 'CLUSTER',
      scopeId: clusterId,
      label: cluster.name,
      siteIds: cluster.clusterSites.map((cs) => cs.siteId),
    };
  }

  async resolveTerritory(orgId: number, territoryId: number): Promise<ResolvedScope> {
    const territory = await this.prisma.territory.findFirst({
      where: { id: territoryId, organisationId: orgId },
      select: { name: true, territorySites: { select: { siteId: true } } },
    });
    if (!territory) throw new NotFoundException('Territory not found');

    return {
      scopeType: 'TERRITORY',
      scopeId: territoryId,
      label: territory.name,
      siteIds: territory.territorySites.map((ts) => ts.siteId),
    };
  }

  async resolveSite(orgId: number, siteId: number): Promise<ResolvedScope> {
    const site = await this.prisma.site.findFirst({
      where: { id: siteId, organisationId: orgId },
      select: { id: true, name: true, organisationName: true },
    });
    if (!site) throw new NotFoundException('Site not found');

    return {
      scopeType: 'SITE',
      scopeId: siteId,
      label: site.name ?? site.organisationName,
      siteIds: [site.id],
    };
  }

  /** Single entry point used by the reporting endpoints. */
  async resolve(
    orgId: number,
    scopeType: ScopeType,
    scopeId?: number | null,
  ): Promise<ResolvedScope> {
    switch (scopeType) {
      case 'ENTERPRISE':
        return this.resolveEnterprise(orgId);
      case 'GROUP':
        return this.resolveGroup(orgId, this.requireId(scopeId, 'groupId'));
      case 'CLUSTER':
        return this.resolveCluster(orgId, this.requireId(scopeId, 'clusterId'));
      case 'TERRITORY':
        return this.resolveTerritory(orgId, this.requireId(scopeId, 'territoryId'));
      case 'SITE':
        return this.resolveSite(orgId, this.requireId(scopeId, 'siteId'));
    }
  }

  /**
   * The classification to stamp on a new listing or claim, so later
   * reassignment cannot rewrite history.
   */
  async snapshotForSite(siteId: number): Promise<{
    snapshotGroupId: number | null;
    snapshotClusterId: number | null;
    snapshotTerritoryId: number | null;
  }> {
    const [groupSite, clusterSite, territorySite] = await Promise.all([
      this.prisma.groupSite.findUnique({
        where: { siteId },
        select: { groupId: true },
      }),
      this.prisma.clusterSite.findUnique({
        where: { siteId },
        select: { clusterId: true },
      }),
      this.prisma.territorySite.findUnique({
        where: { siteId },
        select: { territoryId: true },
      }),
    ]);

    return {
      snapshotGroupId: groupSite?.groupId ?? null,
      snapshotClusterId: clusterSite?.clusterId ?? null,
      snapshotTerritoryId: territorySite?.territoryId ?? null,
    };
  }

  // ─── Per-user scope enforcement ────────────────────────────────────────────

  /**
   * The caller's Enterprise role, or null when they are not a member.
   * Falls back to SUPER_ADMIN for legacy org admins so nobody is locked out.
   */
  async getEnterpriseRole(caller: Jwtpayload): Promise<EnterpriseRole | null> {
    if (!caller.orgId) return null;

    const membership = await this.prisma.orgMemeberShip.findFirst({
      where: { userId: caller.sub, organisationId: caller.orgId },
      select: { enterpriseRole: true, orgRole: true },
    });
    if (!membership) return null;

    if (membership.enterpriseRole) return membership.enterpriseRole;
    return membership.orgRole === 'SUPER_ADMIN' ? EnterpriseRole.SUPER_ADMIN : null;
  }

  /**
   * Every site the caller is allowed to see, or `null` meaning unrestricted.
   *
   * A user's reach is the union of their UserScope rows resolved down to sites,
   * which is why one subset test can police every reporting dimension at once.
   */
  async getAllowedSiteIds(caller: Jwtpayload): Promise<number[] | null> {
    const orgId = caller.orgId;
    if (!orgId) return [];

    const role = await this.getEnterpriseRole(caller);
    if (isUnrestricted(role)) return null; // whole Enterprise

    const scopes = await this.prisma.userScope.findMany({
      where: { userId: caller.sub, organisationId: orgId },
      select: { scopeType: true, scopeId: true },
    });

    // No explicit grant: fall back to the sites they operate on in the app.
    if (!scopes.length) {
      const access = await this.prisma.siteAccess.findMany({
        where: { userId: caller.sub, organisationId: orgId },
        select: { siteId: true },
      });
      return access.map((a) => a.siteId);
    }

    const allowed = new Set<number>();
    for (const s of scopes) {
      if (s.scopeType === PrismaScopeType.ENTERPRISE) return null;
      const resolved = await this.resolve(
        orgId,
        s.scopeType as ScopeType,
        s.scopeId,
      ).catch(() => null);
      resolved?.siteIds.forEach((id) => allowed.add(id));
    }
    return [...allowed];
  }

  /**
   * Allows the request only when everything it would return already sits
   * inside the caller's reach.
   */
  async assertScopeAllowed(caller: Jwtpayload, requested: ResolvedScope): Promise<void> {
    const allowed = await this.getAllowedSiteIds(caller);
    if (allowed === null) return; // unrestricted

    const allowedSet = new Set(allowed);
    const outside = requested.siteIds.filter((id) => !allowedSet.has(id));
    if (!outside.length) return;

    throw new ForbiddenException({
      statusCode: HttpStatus.FORBIDDEN,
      error: ENTERPRISE_ERROR.OUTSIDE_SCOPE,
      message: `You do not have access to all of "${requested.label}".`,
      scopeType: requested.scopeType,
      scopeId: requested.scopeId,
    });
  }

  // ─── Permission enforcement ────────────────────────────────────────────────

  /**
   * Gates a request on the role matrix, and returns the caller's organisation.
   *
   * Permission answers "may this role do this at all"; scope answers "to which
   * slice of the Enterprise". Both must pass, so a caller acting on something
   * in particular follows this with one of the reach checks below.
   */
  async assertPermission(
    caller: Jwtpayload,
    permission: EnterprisePermission,
  ): Promise<number> {
    const orgId = await this.assertEnterprise(caller);
    const role = await this.getEnterpriseRole(caller);

    if (!roleHasPermission(role, permission)) {
      throw new ForbiddenException({
        statusCode: HttpStatus.FORBIDDEN,
        error: ENTERPRISE_ERROR.MISSING_PERMISSION,
        message: role
          ? `A ${roleLabel(role)} cannot do this.`
          : 'You are not a member of this Enterprise.',
        requiredPermission: permission,
      });
    }
    return orgId;
  }

  /**
   * A structure the caller may act on: every site it currently holds has to sit
   * inside their own reach.
   *
   * An empty structure passes, deliberately — a Group Admin can rename or
   * populate a group holding nothing yet, and the moment it holds a site
   * outside their reach this stops them.
   */
  async assertStructureWithinReach(
    caller: Jwtpayload,
    orgId: number,
    scopeType: ScopeType,
    scopeId: number,
  ): Promise<ResolvedScope> {
    const resolved = await this.resolve(orgId, scopeType, scopeId);
    await this.assertScopeAllowed(caller, resolved);
    return resolved;
  }

  /** Sites the caller may pull into a structure or hand to somebody else. */
  async assertSitesWithinReach(caller: Jwtpayload, siteIds: number[]): Promise<void> {
    const allowed = await this.getAllowedSiteIds(caller);
    if (allowed === null) return; // unrestricted

    const allowedSet = new Set(allowed);
    const outside = siteIds.filter((id) => !allowedSet.has(id));
    if (!outside.length) return;

    throw new ForbiddenException({
      statusCode: HttpStatus.FORBIDDEN,
      error: ENTERPRISE_ERROR.OUTSIDE_SCOPE,
      message:
        outside.length === 1
          ? 'One of the sites you selected is outside your scope.'
          : `${outside.length} of the sites you selected are outside your scope.`,
      siteIds: outside,
    });
  }

  /** Resolve and authorise in one step — what the reporting endpoints call. */
  async resolveForCaller(
    caller: Jwtpayload,
    scopeType: ScopeType,
    scopeId?: number | null,
  ): Promise<ResolvedScope> {
    const orgId = await this.assertEnterprise(caller);
    const resolved = await this.resolve(orgId, scopeType, scopeId);
    await this.assertScopeAllowed(caller, resolved);
    return resolved;
  }

  /**
   * Turns the shared Group / Territory / Cluster / Site filter set into the
   * site ids a request may actually read.
   *
   * Filters combine rather than replace each other: naming both a Group and a
   * Territory means the sites in both. The result is then intersected with the
   * caller's own reach, so a filter can only ever narrow what they already see
   * — never widen it.
   */
  async resolveFilters(
    caller: Jwtpayload,
    filters: {
      groupId?: number;
      territoryId?: number;
      clusterId?: number;
      siteId?: number;
    },
  ): Promise<number[]> {
    const orgId = await this.assertEnterprise(caller);

    const dimensions: Array<[ScopeType, number | undefined]> = [
      ['GROUP', filters.groupId],
      ['TERRITORY', filters.territoryId],
      ['CLUSTER', filters.clusterId],
      ['SITE', filters.siteId],
    ];

    let selected: Set<number> | null = null;
    for (const [scopeType, id] of dimensions) {
      if (id === undefined) continue;
      const resolved = await this.resolve(orgId, scopeType, id);
      const ids = new Set(resolved.siteIds);
      selected = selected
        ? new Set([...selected].filter((s:any) => ids.has(s)))
        : ids;
    }

    // No filter given: the caller's whole reach.
    if (selected === null) {
      const allowed = await this.getAllowedSiteIds(caller);
      if (allowed !== null) return allowed;
      const all = await this.prisma.site.findMany({
        where: { organisationId: orgId },
        select: { id: true },
      });
      return all.map((s) => s.id);
    }

    const allowed = await this.getAllowedSiteIds(caller);
    if (allowed === null) return [...selected];

    const allowedSet = new Set(allowed);
    return [...selected].filter((id) => allowedSet.has(id));
  }

  private requireId(id: number | null | undefined, name: string): number {
    if (id === null || id === undefined || Number.isNaN(id)) {
      throw new NotFoundException(`${name} is required for this scope`);
    }
    return id;
  }
}
