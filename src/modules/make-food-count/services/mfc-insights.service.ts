import { Injectable } from '@nestjs/common';
import { ClaimKind, FoodSource, ListingStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import { CO2_PER_KG, MEAL_WEIGHT_KG } from '../../impact/impact.constants';
import { MfcInsightsQueryDto } from '../dto/mfc-insights.dto';
import { MfcAccessService } from './mfc-access.service';
import {
  bucketTotal, notRecoveredBuckets, type LineOutcome,
} from './mfc-outcomes';
import { sumKg } from './mfc-totals';

/**
 * Home impact's diverted figure counts every verified collection at the site,
 * not only food that came through Make Food Count. The client asked for the
 * broader number; flip this to narrow it (client question 16).
 */
export const HOME_IMPACT_COUNTS_ALL_COLLECTIONS = true;

const ACTIVE_LISTING: ListingStatus[] = [
  ListingStatus.ACTIVE, ListingStatus.PARTIAL, ListingStatus.CLAIMED,
];

const round = (n: number) => Number(n.toFixed(2));

type Bucket = 'day' | 'week' | 'month';

/**
 * Every Make Food Count number, for a range and a slice of the business.
 *
 * Dimensions come from each record's own snapshot ids, so moving a site to a
 * new territory never rewrites what it already reported. Dates come from
 * `recordedAt` — the service day — not from when the row happened to be
 * written.
 */
@Injectable()
export class MfcInsightsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: MfcAccessService,
  ) {}

  // ─── Filters ───────────────────────────────────────────────────────────────

  /**
   * The options the app may offer, already narrowed to reach.
   *
   * Each site carries its own group, territory and cluster so the app can
   * cascade the dropdowns without asking again.
   */
  async filters(caller: Jwtpayload) {
    await this.access.assertCanReadInsights(caller);
    const reach = await this.access.reachSiteIds(caller);

    const sites = await this.prisma.site.findMany({
      where: {
        organisationId: caller.orgId,
        isActive: true,
        ...(reach === null ? {} : { id: { in: reach } }),
      },
      select: {
        id: true, name: true, organisationName: true,
        groupSite: { select: { groupId: true } },
        clusterSite: { select: { clusterId: true } },
        territorySite: { select: { territoryId: true } },
      },
      orderBy: { organisationName: 'asc' },
    });

    const groupIds = [...new Set(sites.map((s) => s.groupSite?.groupId).filter(Boolean))] as number[];
    const clusterIds = [...new Set(sites.map((s) => s.clusterSite?.clusterId).filter(Boolean))] as number[];
    const territoryIds = [...new Set(sites.map((s) => s.territorySite?.territoryId).filter(Boolean))] as number[];

    const [groups, clusters, territories] = await Promise.all([
      groupIds.length
        ? this.prisma.enterpriseGroup.findMany({
            where: { id: { in: groupIds } }, select: { id: true, name: true } })
        : [],
      clusterIds.length
        ? this.prisma.cluster.findMany({
            where: { id: { in: clusterIds } }, select: { id: true, name: true } })
        : [],
      territoryIds.length
        ? this.prisma.territory.findMany({
            where: { id: { in: territoryIds } }, select: { id: true, name: true } })
        : [],
    ]);

    return {
      groups,
      // Only offered when the organisation actually uses them.
      clusters,
      territories,
      sites: sites.map((s) => ({
        id: s.id,
        name: s.name ?? s.organisationName,
        groupId: s.groupSite?.groupId ?? null,
        clusterId: s.clusterSite?.clusterId ?? null,
        territoryId: s.territorySite?.territoryId ?? null,
      })),
    };
  }

  // ─── Insights ──────────────────────────────────────────────────────────────

  async insights(caller: Jwtpayload, query: MfcInsightsQueryDto, source?: FoodSource) {
    await this.access.assertCanReadInsights(caller);
    const where = await this.recordWhere(caller, query);

    // An out-of-reach filter narrows to nothing rather than erroring, so a
    // filter cannot be used to probe for sites the caller cannot see.
    if (where === null) return this.emptyInsights(query, source);

    const lines = await this.loadLines(where, source);
    if (lines.length === 0) return this.emptyInsights(query, source);

    const outcomes = lines.map((l) => l.outcome);
    const recordedKg = round(outcomes.reduce((s, o) => s + o.qtyKg, 0));
    const collectedKg = round(outcomes.reduce((s, o) => s + o.collectedKg, 0));
    const listedKg = round(outcomes.reduce((s, o) => s + o.listedKg, 0));
    const claimedKg = round(outcomes.reduce((s, o) => s + o.claimedKg, 0));
    const buckets = notRecoveredBuckets(outcomes);

    const byPathway = new Map<string, number>();
    const byCategory = new Map<string, number>();
    const bySite = new Map<number, { recordedKg: number; recoveredKg: number }>();
    const bySource = new Map<FoodSource, { recordedKg: number; recoveredKg: number }>();
    const trend = new Map<string, { recordedKg: number; recoveredKg: number }>();
    const bucketOf = this.bucketSize(new Date(query.from), new Date(query.to));

    for (const line of lines) {
      const { outcome } = line;
      for (const [pathway, kg] of line.byPathway) {
        byPathway.set(pathway, (byPathway.get(pathway) ?? 0) + kg);
      }
      byCategory.set(line.category,
        (byCategory.get(line.category) ?? 0) + outcome.collectedKg);

      const site = bySite.get(line.siteId) ?? { recordedKg: 0, recoveredKg: 0 };
      site.recordedKg += outcome.qtyKg;
      site.recoveredKg += outcome.collectedKg;
      bySite.set(line.siteId, site);

      const src = bySource.get(line.source) ?? { recordedKg: 0, recoveredKg: 0 };
      src.recordedKg += outcome.qtyKg;
      src.recoveredKg += outcome.collectedKg;
      bySource.set(line.source, src);

      const key = this.bucketKey(line.recordedAt, bucketOf);
      const t = trend.get(key) ?? { recordedKg: 0, recoveredKg: 0 };
      t.recordedKg += outcome.qtyKg;
      t.recoveredKg += outcome.collectedKg;
      trend.set(key, t);
    }

    const siteNames = await this.siteNames([...bySite.keys()]);

    return {
      filtersApplied: { ...query, ...(source ? { source } : {}) },
      isDemo: false,
      overview: {
        recordedKg,
        recoveredKg: collectedKg,
        notRecoveredKg: round(recordedKg - collectedKg),
        estimatedMeals: Math.round(collectedKg / MEAL_WEIGHT_KG),
        estimatedCo2Kg: round(collectedKg * CO2_PER_KG),
      },
      destinations: [...byPathway.entries()]
        .map(([pathway, kg]) => ({
          pathway,
          kg: round(kg),
          shareOfRecovered: collectedKg > 0 ? round((kg / collectedKg) * 100) : 0,
        }))
        .sort((a, b) => b.kg - a.kg),
      bySource: [...bySource.entries()].map(([s, t]) => ({
        source: s,
        recordedKg: round(t.recordedKg),
        recoveredKg: round(t.recoveredKg),
        notRecoveredKg: round(t.recordedKg - t.recoveredKg),
      })),
      whatHappened: { recordedKg, listedKg, claimedKg, collectedKg, notRecovered: buckets },
      redistributed: {
        byCategory: [...byCategory.entries()]
          .map(([category, kg]) => ({ category, kg: round(kg) }))
          .filter((c) => c.kg > 0)
          .sort((a, b) => b.kg - a.kg),
        bySite: [...bySite.entries()]
          .map(([id, t]) => ({
            siteId: id,
            siteName: siteNames.get(id) ?? `Site ${id}`,
            recordedKg: round(t.recordedKg),
            recoveredKg: round(t.recoveredKg),
          }))
          .sort((a, b) => b.recoveredKg - a.recoveredKg),
        trend: [...trend.entries()]
          .map(([bucketStart, t]) => ({
            bucketStart,
            recordedKg: round(t.recordedKg),
            recoveredKg: round(t.recoveredKg),
          }))
          .sort((a, b) => a.bucketStart.localeCompare(b.bucketStart)),
      },
    };
  }

  // ─── Home impact ───────────────────────────────────────────────────────────

  async homeImpact(caller: Jwtpayload, siteId?: number) {
    await this.access.assertCanReadInsights(caller);
    const siteIds = await this.access.resolveSiteFilter(
      caller, siteId ? [siteId] : undefined,
    );
    if (siteIds !== null && siteIds.length === 0) {
      return { recordedKg: 0, divertedKg: 0, collections: 0, co2AvoidedKg: 0 };
    }

    const siteFilter = siteIds === null ? {} : { siteId: { in: siteIds } };

    const [lines, claims] = await Promise.all([
      this.prisma.foodRecordLine.findMany({
        where: { deletedAt: null, record: { organisationId: caller.orgId, ...siteFilter } },
        select: { qtyKg: true },
      }),
      this.prisma.claimItem.findMany({
        where: {
          claim: {
            status: 'COLLECTED',
            claimKind: { not: ClaimKind.CONSOLIDATED_MASTER },
            listing: { organisationId: caller.orgId, ...siteFilter },
            ...(HOME_IMPACT_COUNTS_ALL_COLLECTIONS
              ? {}
              : { listing: { foodRecordLinks: { some: {} } } }),
          },
        },
        select: { qtyKg: true, claimId: true },
      }),
    ]);

    const divertedKg = sumKg(claims.map((c) => c.qtyKg));
    return {
      recordedKg: sumKg(lines.map((l) => l.qtyKg)),
      divertedKg,
      collections: new Set(claims.map((c) => c.claimId)).size,
      co2AvoidedKg: round(divertedKg * CO2_PER_KG),
    };
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /** Null means the filters resolved to nothing the caller may see. */
  private async recordWhere(
    caller: Jwtpayload, query: MfcInsightsQueryDto,
  ): Promise<Prisma.FoodRecordWhereInput | null> {
    const siteIds = await this.access.resolveSiteFilter(
      caller, query.siteId ? [query.siteId] : undefined,
    );
    if (siteIds !== null && siteIds.length === 0) return null;

    return {
      organisationId: caller.orgId,
      ...(siteIds === null ? {} : { siteId: { in: siteIds } }),
      // Snapshot ids, so a site that moved keeps its history where it happened.
      ...(query.groupId ? { snapshotGroupId: query.groupId } : {}),
      ...(query.clusterId ? { snapshotClusterId: query.clusterId } : {}),
      ...(query.territoryId ? { snapshotTerritoryId: query.territoryId } : {}),
      recordedAt: { gte: new Date(query.from), lte: new Date(query.to) },
    };
  }

  /**
   * Every line in range with what happened to it.
   *
   * Four joins in one query rather than a query per record — the whole payload
   * is built from this single read.
   */
  private async loadLines(where: Prisma.FoodRecordWhereInput, source?: FoodSource) {
    const rows = await this.prisma.foodRecordLine.findMany({
      where: { deletedAt: null, record: where, ...(source ? { source } : {}) },
      select: {
        id: true, source: true, category: true, qtyKg: true,
        record: { select: { siteId: true, recordedAt: true } },
        links: {
          select: {
            listedQtyKg: true,
            listing: { select: { status: true, recoveryPathway: true } },
            foodItem: {
              select: {
                claimItems: {
                  select: {
                    qtyKg: true,
                    claim: { select: { status: true, claimKind: true, recoveryPathway: true } },
                  },
                },
              },
            },
          },
        },
      },
    });

    return rows.map((row) => {
      const outcome: LineOutcome = {
        qtyKg: Number(row.qtyKg),
        listedKg: 0, activeListedKg: 0, claimedKg: 0, collectedKg: 0, listingStatuses: [],
      };
      const byPathway: [string, number][] = [];

      for (const link of row.links) {
        const listed = Number(link.listedQtyKg);
        if (link.listing.status !== ListingStatus.CANCELLED) outcome.listedKg += listed;
        if (ACTIVE_LISTING.includes(link.listing.status)) outcome.activeListedKg += listed;
        outcome.listingStatuses.push(link.listing.status);

        for (const item of link.foodItem.claimItems) {
          // The consolidated master is a presentation layer over the per-site
          // allocations; counting both would double the weight.
          if (item.claim.claimKind === ClaimKind.CONSOLIDATED_MASTER) continue;
          if (item.claim.status === 'CANCELLED') continue;

          outcome.claimedKg += item.qtyKg;
          if (item.claim.status === 'COLLECTED') {
            outcome.collectedKg += item.qtyKg;
            byPathway.push([
              item.claim.recoveryPathway ?? link.listing.recoveryPathway ?? 'FOOD_FOR_PEOPLE',
              item.qtyKg,
            ]);
          }
        }
      }

      outcome.listingStatuses = [...new Set(outcome.listingStatuses)];
      return {
        lineId: row.id,
        source: row.source,
        category: row.category,
        siteId: row.record.siteId,
        recordedAt: row.record.recordedAt,
        outcome,
        byPathway,
      };
    });
  }

  private async siteNames(ids: number[]) {
    if (!ids.length) return new Map<number, string>();
    const sites = await this.prisma.site.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, organisationName: true },
    });
    return new Map(sites.map((s) => [s.id, s.name ?? s.organisationName]));
  }

  /** Day up to a month, week up to six months, month beyond that. */
  private bucketSize(from: Date, to: Date): Bucket {
    const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000));
    if (days <= 31) return 'day';
    if (days <= 186) return 'week';
    return 'month';
  }

  private bucketKey(at: Date, bucket: Bucket): string {
    const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
    if (bucket === 'month') return `${d.toISOString().slice(0, 7)}-01`;
    if (bucket === 'week') {
      // ISO weeks start on Monday.
      const weekday = (d.getUTCDay() + 6) % 7;
      d.setUTCDate(d.getUTCDate() - weekday);
    }
    return d.toISOString().slice(0, 10);
  }

  private emptyInsights(query: MfcInsightsQueryDto, source?: FoodSource) {
    const zero = { recordedKg: 0, recoveredKg: 0, notRecoveredKg: 0, estimatedMeals: 0, estimatedCo2Kg: 0 };
    return {
      filtersApplied: { ...query, ...(source ? { source } : {}) },
      isDemo: false,
      overview: zero,
      destinations: [],
      bySource: [],
      whatHappened: {
        recordedKg: 0, listedKg: 0, claimedKg: 0, collectedKg: 0,
        notRecovered: notRecoveredBuckets([]),
      },
      redistributed: { byCategory: [], bySite: [], trend: [] },
    };
  }

  /** Exposed for the invariant test: the buckets must explain every kilogram. */
  static bucketsBalance(outcomes: LineOutcome[]): boolean {
    const recorded = outcomes.reduce((s, o) => s + o.qtyKg, 0);
    const collected = outcomes.reduce((s, o) => s + o.collectedKg, 0);
    return Math.abs(bucketTotal(notRecoveredBuckets(outcomes)) - round(recorded - collected)) < 0.011;
  }
}
