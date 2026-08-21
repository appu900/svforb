import { Injectable } from '@nestjs/common';
import { ClaimStatus, ListingStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import {
  CO2_PER_KG,
  FOOD_VALUE_PER_KG_USD,
  MEAL_WEIGHT_KG,
} from '../../impact/impact.constants';
import { ScopeType } from '../enterprise.constants';
import { EnterpriseScopeService } from './enterprise-scope.service';

/** A site counts as active when it listed something in the last 30 days. */
const ACTIVITY_WINDOW_DAYS = 30;

@Injectable()
export class EnterpriseReportingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: EnterpriseScopeService,
  ) {}

  /**
   * Impact for any scope. Because the resolver hands back a site list, this
   * runs the same aggregation whether the caller asked for one site or the
   * entire Enterprise.
   */
  async getImpact(
    caller: Jwtpayload,
    scopeType: ScopeType,
    scopeId?: number,
    startDate?: string,
    endDate?: string,
  ) {
    // Resolves *and* authorises — a caller may only ask for what their scope covers.
    const resolved = await this.scope.resolveForCaller(caller, scopeType, scopeId);

    const end = endDate ? new Date(endDate) : new Date();
    const start = startDate
      ? new Date(startDate)
      : new Date(Date.now() - ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    if (!resolved.siteIds.length) {
      return { scope: this.scopeHeader(resolved), period: { start, end }, ...this.emptyImpact() };
    }

    const claims = await this.prisma.foodClaim.findMany({
      where: {
        listing: { siteId: { in: resolved.siteIds } },
        status: ClaimStatus.COLLECTED,
        collectedAt: { gte: start, lte: end },
      },
      select: {
        claimantOrgId: true,
        claimItems: { select: { qtyKg: true } },
        listing: { select: { listingType: true } },
      },
    });

    let totalKg = 0;
    let forPeopleKg = 0;
    let forAnimalsKg = 0;
    const recipients = new Set<number>();

    for (const claim of claims) {
      const kg = claim.claimItems.reduce((sum, ci) => sum + ci.qtyKg, 0);
      totalKg += kg;
      if (claim.listing.listingType === 'ANIMAL') forAnimalsKg += kg;
      else forPeopleKg += kg;
      recipients.add(claim.claimantOrgId);
    }

    return {
      scope: this.scopeHeader(resolved),
      period: { start, end },
      siteCount: resolved.siteIds.length,
      foodDistributedKg: this.round(totalKg),
      mealsCreated: Math.round(forPeopleKg / MEAL_WEIGHT_KG),
      co2AvoidedKg: this.round(totalKg * CO2_PER_KG),
      foodSavedValue: this.round(totalKg * FOOD_VALUE_PER_KG_USD),
      collections: claims.length,
      organisationsSupported: recipients.size,
      forPeopleKg: this.round(forPeopleKg),
      forAnimalsKg: this.round(forAnimalsKg),
    };
  }

  /** Impact broken down one level below the requested scope — the drill-down. */
  async getBreakdown(
    caller: Jwtpayload,
    scopeType: ScopeType,
    scopeId?: number,
    startDate?: string,
    endDate?: string,
  ) {
    const orgId = await this.scope.assertEnterprise(caller);
    await this.scope.resolveForCaller(caller, scopeType, scopeId);

    const allChildren = await this.childScopes(orgId, scopeType, scopeId);

    // A partially-scoped caller sees only the branches they cover, rather than
    // the whole list padded with zeroes.
    const allowed = await this.scope.getAllowedSiteIds(caller);
    const children =
      allowed === null
        ? allChildren
        : await this.filterChildrenByReach(orgId, allChildren, new Set(allowed));

    const rows = await Promise.all(
      children.map(async (child) => {
        const impact = await this.getImpact(
          caller,
          child.scopeType,
          child.scopeId ?? undefined,
          startDate,
          endDate,
        );
        return {
          scopeType: child.scopeType,
          scopeId: child.scopeId,
          name: child.name,
          siteCount: impact.siteCount ?? 0,
          foodDistributedKg: impact.foodDistributedKg,
          mealsCreated: impact.mealsCreated,
          co2AvoidedKg: impact.co2AvoidedKg,
          collections: impact.collections,
        };
      }),
    );

    rows.sort((a, b) => b.foodDistributedKg - a.foodDistributedKg);
    return { parent: { scopeType, scopeId: scopeId ?? null }, rows };
  }

  /**
   * Site league table plus the four network states from the requirements:
   * active, inactive, never used, deactivated.
   */
  async getSiteRankings(
    caller: Jwtpayload,
    scopeType: ScopeType,
    scopeId?: number,
    startDate?: string,
    endDate?: string,
  ) {
    // Resolves *and* authorises — a caller may only ask for what their scope covers.
    const resolved = await this.scope.resolveForCaller(caller, scopeType, scopeId);

    const end = endDate ? new Date(endDate) : new Date();
    const start = startDate
      ? new Date(startDate)
      : new Date(Date.now() - ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const activityCutoff = new Date(Date.now() - ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    if (!resolved.siteIds.length) {
      return {
        scope: this.scopeHeader(resolved),
        period: { start, end },
        network: { total: 0, active: 0, inactive: 0, neverUsed: 0, deactivated: 0 },
        sites: [],
      };
    }

    const sites = await this.prisma.site.findMany({
      where: { id: { in: resolved.siteIds } },
      select: {
        id: true,
        organisationName: true,
        isActive: true,
        clusterSite: { select: { cluster: { select: { id: true, name: true } } } },
        territorySite: { select: { territory: { select: { id: true, name: true } } } },
      },
    });

    const [listingAgg, lastListings, collected] = await Promise.all([
      this.prisma.foodListing.groupBy({
        by: ['siteId'],
        where: {
          siteId: { in: resolved.siteIds },
          createdAt: { gte: start, lte: end },
          status: { not: ListingStatus.CANCELLED },
        },
        _count: { _all: true },
      }),
      this.prisma.foodListing.groupBy({
        by: ['siteId'],
        where: { siteId: { in: resolved.siteIds } },
        _max: { createdAt: true },
      }),
      this.prisma.foodClaim.findMany({
        where: {
          listing: { siteId: { in: resolved.siteIds } },
          status: ClaimStatus.COLLECTED,
          collectedAt: { gte: start, lte: end },
        },
        select: { listing: { select: { siteId: true } }, claimItems: { select: { qtyKg: true } } },
      }),
    ]);

    const listingCount = new Map(listingAgg.map((r) => [r.siteId, r._count._all]));
    const lastListedAt = new Map(lastListings.map((r) => [r.siteId, r._max.createdAt]));

    const kgBySite = new Map<number, number>();
    const collectionsBySite = new Map<number, number>();
    for (const c of collected) {
      const id = c.listing.siteId;
      const kg = c.claimItems.reduce((sum, ci) => sum + ci.qtyKg, 0);
      kgBySite.set(id, (kgBySite.get(id) ?? 0) + kg);
      collectionsBySite.set(id, (collectionsBySite.get(id) ?? 0) + 1);
    }

    const network = { total: sites.length, active: 0, inactive: 0, neverUsed: 0, deactivated: 0 };

    const rows = sites.map((s) => {
      const last = lastListedAt.get(s.id) ?? null;
      let state: 'ACTIVE' | 'INACTIVE' | 'NEVER_USED' | 'DEACTIVATED';

      if (!s.isActive) {
        state = 'DEACTIVATED';
        network.deactivated++;
      } else if (!last) {
        state = 'NEVER_USED';
        network.neverUsed++;
      } else if (last >= activityCutoff) {
        state = 'ACTIVE';
        network.active++;
      } else {
        state = 'INACTIVE';
        network.inactive++;
      }

      const kg = kgBySite.get(s.id) ?? 0;

      return {
        siteId: s.id,
        name: s.organisationName,
        cluster: s.clusterSite?.cluster ?? null,
        territory: s.territorySite?.territory ?? null,
        state,
        lastListedAt: last,
        listings: listingCount.get(s.id) ?? 0,
        collections: collectionsBySite.get(s.id) ?? 0,
        foodDistributedKg: this.round(kg),
        mealsCreated: Math.round(kg / MEAL_WEIGHT_KG),
        co2AvoidedKg: this.round(kg * CO2_PER_KG),
      };
    });

    rows.sort((a, b) => b.foodDistributedKg - a.foodDistributedKg);
    rows.forEach((r, i) => Object.assign(r, { rank: i + 1 }));

    return { scope: this.scopeHeader(resolved), period: { start, end }, network, sites: rows };
  }

  /** Headline tiles for the Enterprise dashboard. */
  async getDashboard(caller: Jwtpayload, startDate?: string, endDate?: string) {
    const [impact, rankings, structure] = await Promise.all([
      this.getImpact(caller, 'ENTERPRISE', undefined, startDate, endDate),
      this.getSiteRankings(caller, 'ENTERPRISE', undefined, startDate, endDate),
      this.getBreakdown(caller, 'ENTERPRISE', undefined, startDate, endDate),
    ]);

    return {
      headline: {
        foodDistributedKg: impact.foodDistributedKg,
        mealsCreated: impact.mealsCreated,
        co2AvoidedKg: impact.co2AvoidedKg,
        foodSavedValue: impact.foodSavedValue,
        collections: impact.collections,
        organisationsSupported: impact.organisationsSupported,
      },
      pathways: {
        foodForPeopleKg: impact.forPeopleKg,
        livestockFeedKg: impact.forAnimalsKg,
      },
      network: rankings.network,
      byGroup: structure.rows,
      period: impact.period,
    };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /** One level down: Enterprise -> groups, group -> clusters, cluster -> sites. */
  private async childScopes(
    orgId: number,
    scopeType: ScopeType,
    scopeId?: number,
  ): Promise<Array<{ scopeType: ScopeType; scopeId: number | null; name: string }>> {
    if (scopeType === 'ENTERPRISE') {
      const groups = await this.prisma.enterpriseGroup.findMany({
        where: { organisationId: orgId },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      });
      return groups.map((g) => ({ scopeType: 'GROUP' as ScopeType, scopeId: g.id, name: g.name }));
    }

    if (scopeType === 'GROUP' && scopeId) {
      const clusters = await this.prisma.cluster.findMany({
        where: { organisationId: orgId, groupId: scopeId },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      });
      return clusters.map((c) => ({
        scopeType: 'CLUSTER' as ScopeType,
        scopeId: c.id,
        name: c.name,
      }));
    }

    if (scopeType === 'CLUSTER' && scopeId) {
      const sites = await this.prisma.clusterSite.findMany({
        where: { clusterId: scopeId },
        select: { site: { select: { id: true, organisationName: true } } },
      });
      return sites.map((s) => ({
        scopeType: 'SITE' as ScopeType,
        scopeId: s.site.id,
        name: s.site.organisationName,
      }));
    }

    if (scopeType === 'TERRITORY' && scopeId) {
      const sites = await this.prisma.territorySite.findMany({
        where: { territoryId: scopeId },
        select: { site: { select: { id: true, organisationName: true } } },
      });
      return sites.map((s) => ({
        scopeType: 'SITE' as ScopeType,
        scopeId: s.site.id,
        name: s.site.organisationName,
      }));
    }

    return [];
  }

  /** Keeps only the child scopes whose sites the caller can actually reach. */
  private async filterChildrenByReach(
    orgId: number,
    children: Array<{ scopeType: ScopeType; scopeId: number | null; name: string }>,
    allowed: Set<number>,
  ) {
    const kept: typeof children = [];
    for (const child of children) {
      const resolved = await this.scope
        .resolve(orgId, child.scopeType, child.scopeId)
        .catch(() => null);
      if (resolved?.siteIds.some((id) => allowed.has(id))) kept.push(child);
    }
    return kept;
  }

  private scopeHeader(resolved: { scopeType: ScopeType; scopeId: number | null; label: string }) {
    return { type: resolved.scopeType, id: resolved.scopeId, name: resolved.label };
  }

  private emptyImpact() {
    return {
      siteCount: 0,
      foodDistributedKg: 0,
      mealsCreated: 0,
      co2AvoidedKg: 0,
      foodSavedValue: 0,
      collections: 0,
      organisationsSupported: 0,
      forPeopleKg: 0,
      forAnimalsKg: 0,
    };
  }

  private round(n: number): number {
    return Math.round(n * 100) / 100;
  }
}
