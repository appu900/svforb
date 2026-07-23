import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ClaimStatus, DriverPickupStatus, OrgType, Prisma } from '@prisma/client';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import {
  ANIMAL_ORG_TYPES,
  CHARITY_ORG_TYPES,
  CO2_PER_KG,
  FOOD_VALUE_PER_KG_USD,
  ImpactMode,
  ImpactPeriod,
  MEAL_WEIGHT_KG,
  RECEIVER_ORG_TYPES,
} from '../impact.constants';

interface ChartBucket {
  label: string;
  start: Date;
  end: Date;
}

interface ClaimRow {
  collectedAt: Date;
  rating: number | null;
  qtyKg: number;
  partnerOrgId: number;
  isPeople: boolean;
  isAnimal: boolean;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

@Injectable()
export class ImpactService {
  constructor(private readonly prisma: PrismaService) {}

  async getSiteImpact(caller: Jwtpayload, siteId: number, period: ImpactPeriod = 'week') {
    const hasAccess = await this.prisma.siteAccess.findFirst({
      where: { siteId, userId: caller.sub },
    });
    if (!hasAccess) throw new ForbiddenException('You do not have access to this site');

    const site = await this.prisma.site.findUnique({ where: { id: siteId } });
    if (!site) throw new NotFoundException('Site not found');

    const organisation = await this.prisma.organisation.findUnique({
      where: { id: site.organisationId },
      select: { id: true, name: true, organizationType: true },
    });
    if (!organisation) throw new NotFoundException('Organisation not found');

    const mode: ImpactMode = RECEIVER_ORG_TYPES.includes(organisation.organizationType)
      ? 'RECEIVER'
      : 'DONOR';

    const { start, end } = this.getPeriodRange(period);
    const buckets = this.buildBuckets(period, start);
    const claims = await this.fetchClaims(mode, siteId, organisation, start, end);

    return this.buildResponse(site, organisation, mode, period, start, end, claims, buckets);
  }

  async getSiteImpactByRange(
    caller: Jwtpayload,
    siteId: number,
    startDate: string,
    endDate?: string,
  ) {
    const hasAccess = await this.prisma.siteAccess.findFirst({
      where: { siteId, userId: caller.sub },
    });
    if (!hasAccess) throw new ForbiddenException('You do not have access to this site');

    const site = await this.prisma.site.findUnique({ where: { id: siteId } });
    if (!site) throw new NotFoundException('Site not found');

    const organisation = await this.prisma.organisation.findUnique({
      where: { id: site.organisationId },
      select: { id: true, name: true, organizationType: true },
    });
    if (!organisation) throw new NotFoundException('Organisation not found');

    const mode: ImpactMode = RECEIVER_ORG_TYPES.includes(organisation.organizationType)
      ? 'RECEIVER'
      : 'DONOR';

    const start = new Date(startDate);
    const end = endDate ? new Date(endDate) : new Date();

    const claims = await this.fetchClaims(mode, siteId, organisation, start, end);
    const buckets = this.buildBucketsForRange(start, end);

    return this.buildResponse(site, organisation, mode, 'range' as any, start, end, claims, buckets);
  }

  private buildBucketsForRange(start: Date, end: Date): ChartBucket[] {
    const diffDays = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));

    if (diffDays <= 7) {
      // daily buckets
      const buckets: ChartBucket[] = [];
      for (let i = 0; i < diffDays; i++) {
        const bucketStart = new Date(start);
        bucketStart.setDate(start.getDate() + i);
        bucketStart.setHours(0, 0, 0, 0);
        const bucketEnd = new Date(bucketStart);
        bucketEnd.setHours(23, 59, 59, 999);
        buckets.push({
          label: bucketStart.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }),
          start: bucketStart,
          end: bucketEnd,
        });
      }
      return buckets;
    }

    if (diffDays <= 31) {
      // weekly buckets
      const buckets: ChartBucket[] = [];
      let cursor = new Date(start);
      let weekNum = 1;
      while (cursor <= end) {
        const bucketStart = new Date(cursor);
        const tentativeEnd = new Date(cursor);
        tentativeEnd.setDate(tentativeEnd.getDate() + 6);
        tentativeEnd.setHours(23, 59, 59, 999);
        const bucketEnd = tentativeEnd < end ? tentativeEnd : new Date(end);
        buckets.push({ label: `Week ${weekNum}`, start: bucketStart, end: bucketEnd });
        cursor = new Date(bucketEnd.getTime() + 1);
        weekNum++;
      }
      return buckets;
    }

    // monthly buckets
    const buckets: ChartBucket[] = [];
    const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
    while (cursor <= end) {
      const bucketStart = new Date(cursor);
      const bucketEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0, 23, 59, 59, 999);
      buckets.push({
        label: bucketStart.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }),
        start: bucketStart,
        end: bucketEnd < end ? bucketEnd : new Date(end),
      });
      cursor.setMonth(cursor.getMonth() + 1);
    }
    return buckets;
  }

  // ─── Data fetching ────────────────────────────────────────────────────────────

  private async fetchClaims(
    mode: ImpactMode,
    siteId: number,
    organisation: { id: number; organizationType: OrgType },
    start: Date | null,
    end: Date,
  ): Promise<ClaimRow[]> {
    const collectedAtFilter = start ? { gte: start, lte: end } : { lte: end };

    // Lifetime: any COLLECTED claim / driver pickup (do not require collectedAt —
    // older rows may have status COLLECTED with a null timestamp).
    // Range: prefer collectedAt in window; fall back to updatedAt when collectedAt is null.
    const collectedClaimWhere = start
      ? {
          status: { not: ClaimStatus.CANCELLED },
          OR: [
            { status: ClaimStatus.COLLECTED, collectedAt: collectedAtFilter },
            {
              status: ClaimStatus.COLLECTED,
              collectedAt: null,
              updatedAt: collectedAtFilter,
            },
            {
              driverPickups: {
                some: {
                  status: DriverPickupStatus.COLLECTED,
                  OR: [
                    { collectedAt: collectedAtFilter },
                    { collectedAt: null, updatedAt: collectedAtFilter },
                  ],
                },
              },
            },
          ],
        }
      : {
          status: { not: ClaimStatus.CANCELLED },
          OR: [
            { status: ClaimStatus.COLLECTED },
            {
              driverPickups: {
                some: { status: DriverPickupStatus.COLLECTED },
              },
            },
          ],
        };

    const claimInclude = {
      claimItems: { select: { qtyKg: true } },
      driverPickups: {
        where: { status: DriverPickupStatus.COLLECTED },
        orderBy: { collectedAt: 'desc' as const },
        take: 1,
        select: { collectedAt: true, updatedAt: true },
      },
    };

    if (mode === 'DONOR') {
      const claims = await this.prisma.foodClaim.findMany({
        where: { ...collectedClaimWhere, listing: { siteId } },
        include: {
          ...claimInclude,
          claimantOrg: { select: { id: true, organizationType: true } },
        },
      });

      return claims.map((c) => ({
        collectedAt:
          c.collectedAt ??
          c.driverPickups[0]?.collectedAt ??
          c.driverPickups[0]?.updatedAt ??
          c.updatedAt,
        rating: c.rating,
        qtyKg: c.claimItems.reduce((sum, ci) => sum + ci.qtyKg, 0),
        partnerOrgId: c.claimantOrg.id,
        isPeople: CHARITY_ORG_TYPES.includes(c.claimantOrg.organizationType),
        isAnimal: ANIMAL_ORG_TYPES.includes(c.claimantOrg.organizationType),
      }));
    }

    // RECEIVER — the claiming org is itself either people-serving or animal-serving
    const isPeopleOrg = CHARITY_ORG_TYPES.includes(organisation.organizationType);

    const claims = await this.prisma.foodClaim.findMany({
      where: { ...collectedClaimWhere, claimantOrgId: organisation.id },
      include: {
        ...claimInclude,
        listing: { select: { organisationId: true } },
      },
    });

    return claims.map((c) => ({
      collectedAt:
        c.collectedAt ??
        c.driverPickups[0]?.collectedAt ??
        c.driverPickups[0]?.updatedAt ??
        c.updatedAt,
      rating: c.rating,
      qtyKg: c.claimItems.reduce((sum, ci) => sum + ci.qtyKg, 0),
      partnerOrgId: c.listing.organisationId,
      isPeople: isPeopleOrg,
      isAnimal: !isPeopleOrg,
    }));
  }

  // ─── Top foods ────────────────────────────────────────────────────────────────

  async getTopFoods(
    caller: Jwtpayload,
    orgId: number,
    startDate?: string,
    endDate?: string,
  ) {
    const membership = await this.prisma.orgMemeberShip.findFirst({
      where: { userId: caller.sub, organisationId: orgId },
    });
    if (!membership) throw new ForbiddenException('You do not have access to this organisation');

    const start = startDate ? new Date(startDate) : null;
    const end = endDate ? new Date(endDate) : new Date();

    const collectedFilter = start
      ? Prisma.sql`AND (
          (fc.status = 'COLLECTED' AND fc."collectedAt" >= ${start} AND fc."collectedAt" <= ${end})
          OR EXISTS (
            SELECT 1 FROM driver_pickups dp
            WHERE dp."claimId" = fc.id AND dp.status = 'COLLECTED'
            AND dp."collectedAt" >= ${start} AND dp."collectedAt" <= ${end}
          )
        )`
      : Prisma.sql`AND (
          fc.status = 'COLLECTED'
          OR EXISTS (
            SELECT 1 FROM driver_pickups dp
            WHERE dp."claimId" = fc.id AND dp.status = 'COLLECTED'
          )
        )`;

    const rows = await this.prisma.$queryRaw<{
      foodName: string;
      unit: string | null;
      category: string | null;
      totalKg: number;
    }[]>`
      SELECT
        fi.name            AS "foodName",
        fi.unit            AS "unit",
        fi.category        AS "category",
        CAST(SUM(ci."qtyKg") AS FLOAT) AS "totalKg"
      FROM claim_items ci
      JOIN food_items    fi ON fi.id   = ci."foodItemId"
      JOIN food_claims   fc ON fc.id   = ci."claimId"
      JOIN food_listings fl ON fl.id   = fc."listingId"
      WHERE
        fl."organisationId" = ${orgId}
        AND fc.status != 'CANCELLED'
        ${collectedFilter}
      GROUP BY fi.name, fi.unit, fi.category
      ORDER BY "totalKg" DESC
      LIMIT 10
    `;

    return this.buildTopFoodsResponse(null, orgId, start, end, rows);
  }

  async getTopFoodsBySite(
    caller: Jwtpayload,
    siteId: number,
    startDate?: string,
    endDate?: string,
  ) {
    const hasAccess = await this.prisma.siteAccess.findFirst({
      where: { siteId, userId: caller.sub },
    });
    if (!hasAccess) throw new ForbiddenException('You do not have access to this site');

    const start = startDate ? new Date(startDate) : null;
    const end = endDate ? new Date(endDate) : new Date();

    const collectedFilter = start
      ? Prisma.sql`AND (
          (fc.status = 'COLLECTED' AND fc."collectedAt" >= ${start} AND fc."collectedAt" <= ${end})
          OR EXISTS (
            SELECT 1 FROM driver_pickups dp
            WHERE dp."claimId" = fc.id AND dp.status = 'COLLECTED'
            AND dp."collectedAt" >= ${start} AND dp."collectedAt" <= ${end}
          )
        )`
      : Prisma.sql`AND (
          fc.status = 'COLLECTED'
          OR EXISTS (
            SELECT 1 FROM driver_pickups dp
            WHERE dp."claimId" = fc.id AND dp.status = 'COLLECTED'
          )
        )`;

    const rows = await this.prisma.$queryRaw<{
      foodName: string;
      unit: string | null;
      category: string | null;
      totalKg: number;
    }[]>`
      SELECT
        fi.name            AS "foodName",
        fi.unit            AS "unit",
        fi.category        AS "category",
        CAST(SUM(ci."qtyKg") AS FLOAT) AS "totalKg"
      FROM claim_items ci
      JOIN food_items    fi ON fi.id = ci."foodItemId"
      JOIN food_claims   fc ON fc.id = ci."claimId"
      JOIN food_listings fl ON fl.id = fc."listingId"
      WHERE
        fl."siteId" = ${siteId}
        AND fc.status != 'CANCELLED'
        ${collectedFilter}
      GROUP BY fi.name, fi.unit, fi.category
      ORDER BY "totalKg" DESC
      LIMIT 10
    `;

    return this.buildTopFoodsResponse(siteId, null, start, end, rows);
  }

  private buildTopFoodsResponse(
    siteId: number | null,
    organisationId: number | null,
    start: Date | null,
    end: Date,
    rows: { foodName: string; unit: string | null; category: string | null; totalKg: number }[],
  ) {
    return {
      siteId,
      organisationId,
      rangeStart: start?.toISOString() ?? null,
      rangeEnd: end.toISOString(),
      topFoods: rows.map((row, i) => {
        const kg = round2(row.totalKg);
        return {
          rank: i + 1,
          foodName: row.foodName,
          unit: row.unit ?? 'kg',
          category: row.category ?? null,
          totalKg: kg,
          co2AvoidedKg: round2(kg * CO2_PER_KG),
          mealsCreated: Math.round(kg / MEAL_WEIGHT_KG),
          totalFoodSavedUsd: round2(kg * FOOD_VALUE_PER_KG_USD),
        };
      }),
    };
  }

  // ─── Period / bucket math ─────────────────────────────────────────────────────

  private getPeriodRange(period: ImpactPeriod): { start: Date | null; end: Date } {
    const now = new Date();
    switch (period) {
      case 'week':
        return { start: this.startOfWeek(now), end: now };
      case 'month':
        return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: now };
      case 'year':
        return { start: new Date(now.getFullYear(), 0, 1), end: now };
      case 'lifetime':
      default:
        return { start: null, end: now };
    }
  }

  private startOfWeek(d: Date): Date {
    const date = new Date(d);
    const day = date.getDay();
    const diff = (day === 0 ? -6 : 1) - day; // shift back to Monday
    date.setDate(date.getDate() + diff);
    date.setHours(0, 0, 0, 0);
    return date;
  }

  private buildBuckets(period: ImpactPeriod, start: Date | null): ChartBucket[] {
    if (!start) return []; // lifetime has no chart series

    if (period === 'week') {
      const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
      return labels.map((label, i) => {
        const bucketStart = new Date(start);
        bucketStart.setDate(start.getDate() + i);
        bucketStart.setHours(0, 0, 0, 0);
        const bucketEnd = new Date(bucketStart);
        bucketEnd.setHours(23, 59, 59, 999);
        return { label, start: bucketStart, end: bucketEnd };
      });
    }

    if (period === 'month') {
      const buckets: ChartBucket[] = [];
      const monthEnd = new Date(start.getFullYear(), start.getMonth() + 1, 0, 23, 59, 59, 999);
      let cursor = new Date(start);
      let weekNum = 1;
      while (cursor <= monthEnd) {
        const bucketStart = new Date(cursor);
        const tentativeEnd = new Date(cursor);
        tentativeEnd.setDate(tentativeEnd.getDate() + 6);
        tentativeEnd.setHours(23, 59, 59, 999);
        const bucketEnd = tentativeEnd < monthEnd ? tentativeEnd : monthEnd;
        buckets.push({ label: `Week ${weekNum}`, start: bucketStart, end: bucketEnd });
        cursor = new Date(bucketEnd.getTime() + 1);
        weekNum++;
      }
      return buckets;
    }

    // year — one bucket per calendar month
    const monthLabels = [
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
    ];
    return monthLabels.map((label, i) => ({
      label,
      start: new Date(start.getFullYear(), i, 1),
      end: new Date(start.getFullYear(), i + 1, 0, 23, 59, 59, 999),
    }));
  }

  // ─── Response shaping ─────────────────────────────────────────────────────────

  private buildResponse(
    site: { id: number },
    organisation: { id: number; name: string; organizationType: OrgType },
    mode: ImpactMode,
    period: ImpactPeriod,
    start: Date | null,
    end: Date,
    claims: ClaimRow[],
    buckets: ChartBucket[],
  ) {
    const redistributedKg = round2(claims.reduce((sum, c) => sum + c.qtyKg, 0));
    const forPeopleKg = round2(
      claims.filter((c) => c.isPeople).reduce((sum, c) => sum + c.qtyKg, 0),
    );
    const forAnimalKg = round2(
      claims.filter((c) => c.isAnimal).reduce((sum, c) => sum + c.qtyKg, 0),
    );

    const ratedClaims = claims.filter((c) => c.rating !== null);
    const ratingAvg = ratedClaims.length
      ? round1(ratedClaims.reduce((sum, c) => sum + (c.rating ?? 0), 0) / ratedClaims.length)
      : null;

    const partnersSupported = new Set(claims.map((c) => c.partnerOrgId)).size;

    const chart = buckets.map((b) => ({
      label: b.label,
      kg: round2(
        claims
          .filter((c) => c.collectedAt >= b.start && c.collectedAt <= b.end)
          .reduce((sum, c) => sum + c.qtyKg, 0),
      ),
    }));

    return {
      siteId: site.id,
      organisationId: organisation.id,
      organisationName: organisation.name,
      organizationType: organisation.organizationType,
      mode,
      period,
      rangeStart: start ? start.toISOString() : null,
      rangeEnd: end.toISOString(),
      totals: {
        redistributedKg,
        mealsCreated: Math.round(forPeopleKg / MEAL_WEIGHT_KG),
        co2AvoidedKg: round2(redistributedKg * CO2_PER_KG),
        totalFoodSavedUsd: round2(redistributedKg * FOOD_VALUE_PER_KG_USD),
        collectionsCompleted: claims.length,
        partnersSupported,
        forPeople: {
          kg: forPeopleKg,
          percent: redistributedKg > 0 ? round1((forPeopleKg / redistributedKg) * 100) : 0,
        },
        forAnimal: {
          kg: forAnimalKg,
          percent: redistributedKg > 0 ? round1((forAnimalKg / redistributedKg) * 100) : 0,
        },
        ratingAvg,
        ratingCount: ratedClaims.length,
      },
      chart,
    };
  }
}
