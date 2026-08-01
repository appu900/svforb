import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ClaimStatus, DriverPickupStatus, OrgRole, OrgType, Prisma } from '@prisma/client';
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

  /**
   * Site staff need siteAccess. Org SUPER_ADMIN (multi-charity / multi-business head office)
   * often has no siteAccess rows but must still view impact for every org site.
   */
  private async assertCanAccessSite(caller: Jwtpayload, siteId: number) {
    const siteAccess = await this.prisma.siteAccess.findFirst({
      where: { siteId, userId: caller.sub },
      select: { id: true },
    });
    if (siteAccess) return;

    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: { organisationId: true },
    });
    if (!site) throw new NotFoundException('Site not found');

    const membership = await this.prisma.orgMemeberShip.findFirst({
      where: {
        userId: caller.sub,
        organisationId: site.organisationId,
        orgRole: OrgRole.SUPER_ADMIN,
      },
      select: { id: true },
    });
    if (membership) return;

    // JWT may already carry SUPER_ADMIN for this org (avoids extra round-trip mismatches).
    if (
      caller.orgRole === OrgRole.SUPER_ADMIN &&
      caller.orgId != null &&
      caller.orgId === site.organisationId
    ) {
      return;
    }

    throw new ForbiddenException('You do not have access to this site');
  }

  async getSiteImpact(caller: Jwtpayload, siteId: number, period: ImpactPeriod = 'week') {
    await this.assertCanAccessSite(caller, siteId);

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
    await this.assertCanAccessSite(caller, siteId);

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

  /** Org-wide impact (All sites) — includes claims not tagged to a specific site. */
  async getOrgImpact(caller: Jwtpayload, orgId: number, period: ImpactPeriod = 'week') {
    await this.assertCanAccessOrg(caller, orgId);

    const organisation = await this.prisma.organisation.findUnique({
      where: { id: orgId },
      select: { id: true, name: true, organizationType: true },
    });
    if (!organisation) throw new NotFoundException('Organisation not found');

    const mode: ImpactMode = RECEIVER_ORG_TYPES.includes(organisation.organizationType)
      ? 'RECEIVER'
      : 'DONOR';

    const site = await this.prisma.site.findFirst({
      where: { organisationId: orgId },
      orderBy: { createdAt: 'asc' },
    });
    if (!site) throw new NotFoundException('No sites found for this organisation');

    const { start, end } = this.getPeriodRange(period);
    const buckets = this.buildBuckets(period, start);

    // DONOR org aggregate: all sites' listings. RECEIVER: all claims for the org.
    const claims =
      mode === 'DONOR'
        ? await this.fetchDonorOrgClaims(orgId, start, end)
        : await this.fetchClaims(mode, null, organisation, start, end);

    return this.buildResponse(site, organisation, mode, period, start, end, claims, buckets);
  }

  async getOrgImpactByRange(
    caller: Jwtpayload,
    orgId: number,
    startDate: string,
    endDate?: string,
  ) {
    await this.assertCanAccessOrg(caller, orgId);

    const organisation = await this.prisma.organisation.findUnique({
      where: { id: orgId },
      select: { id: true, name: true, organizationType: true },
    });
    if (!organisation) throw new NotFoundException('Organisation not found');

    const mode: ImpactMode = RECEIVER_ORG_TYPES.includes(organisation.organizationType)
      ? 'RECEIVER'
      : 'DONOR';

    const site = await this.prisma.site.findFirst({
      where: { organisationId: orgId },
      orderBy: { createdAt: 'asc' },
    });
    if (!site) throw new NotFoundException('No sites found for this organisation');

    const start = new Date(startDate);
    const end = endDate ? new Date(endDate) : new Date();
    const buckets = this.buildBucketsForRange(start, end);

    const claims =
      mode === 'DONOR'
        ? await this.fetchDonorOrgClaims(orgId, start, end)
        : await this.fetchClaims(mode, null, organisation, start, end);

    return this.buildResponse(site, organisation, mode, 'range' as any, start, end, claims, buckets);
  }

  private async assertCanAccessOrg(caller: Jwtpayload, orgId: number) {
    const membership = await this.prisma.orgMemeberShip.findFirst({
      where: { userId: caller.sub, organisationId: orgId },
      select: { id: true, orgRole: true },
    });
    if (membership) return;

    const siteAccess = await this.prisma.siteAccess.findFirst({
      where: { userId: caller.sub, organisationId: orgId },
      select: { id: true },
    });
    if (siteAccess) return;

    if (caller.orgId === orgId) return;

    throw new ForbiddenException('You do not have access to this organisation');
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
    siteId: number | null,
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
      if (siteId == null) {
        return this.fetchDonorOrgClaims(organisation.id, start, end);
      }

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
      where: {
        ...collectedClaimWhere,
        claimantOrgId: organisation.id,
        // null siteId = All sites (org-wide). Otherwise only this charity/farmer site's claims.
        ...(siteId != null ? { claimantSiteId: siteId } : {}),
      },
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

  private async fetchDonorOrgClaims(
    organisationId: number,
    start: Date | null,
    end: Date,
  ): Promise<ClaimRow[]> {
    const collectedAtFilter = start ? { gte: start, lte: end } : { lte: end };
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

    const claims = await this.prisma.foodClaim.findMany({
      where: { ...collectedClaimWhere, listing: { organisationId } },
      include: {
        claimItems: { select: { qtyKg: true } },
        driverPickups: {
          where: { status: DriverPickupStatus.COLLECTED },
          orderBy: { collectedAt: 'desc' as const },
          take: 1,
          select: { collectedAt: true, updatedAt: true },
        },
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

    const organisation = await this.prisma.organisation.findUnique({
      where: { id: orgId },
      select: { organizationType: true },
    });
    if (!organisation) throw new NotFoundException('Organisation not found');

    const mode: ImpactMode = RECEIVER_ORG_TYPES.includes(organisation.organizationType)
      ? 'RECEIVER'
      : 'DONOR';

    const start = startDate ? new Date(startDate) : null;
    const end = endDate ? new Date(endDate) : new Date();
    const collectedFilter = this.buildTopFoodsCollectedFilter(start, end);

    // Donors own listings; receivers claim other orgs' listings.
    const scopeFilter =
      mode === 'RECEIVER'
        ? Prisma.sql`fc."claimantOrgId" = ${orgId}`
        : Prisma.sql`fl."organisationId" = ${orgId}`;

    const rows = await this.queryTopFoodRows(scopeFilter, collectedFilter);
    return this.buildTopFoodsResponse(
      null,
      orgId,
      start,
      end,
      rows,
      mode,
      organisation.organizationType,
    );
  }

  async getTopFoodsBySite(
    caller: Jwtpayload,
    siteId: number,
    startDate?: string,
    endDate?: string,
  ) {
    await this.assertCanAccessSite(caller, siteId);

    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: { organisationId: true },
    });
    if (!site) throw new NotFoundException('Site not found');

    const organisation = await this.prisma.organisation.findUnique({
      where: { id: site.organisationId },
      select: { id: true, organizationType: true },
    });
    if (!organisation) throw new NotFoundException('Organisation not found');

    const mode: ImpactMode = RECEIVER_ORG_TYPES.includes(organisation.organizationType)
      ? 'RECEIVER'
      : 'DONOR';

    const start = startDate ? new Date(startDate) : null;
    const end = endDate ? new Date(endDate) : new Date();
    const collectedFilter = this.buildTopFoodsCollectedFilter(start, end);

    // Receiver claims: org-wide for All sites; site-tagged for a specific site.
    const scopeFilter =
      mode === 'RECEIVER'
        ? siteId != null
          ? Prisma.sql`fc."claimantOrgId" = ${organisation.id} AND fc."claimantSiteId" = ${siteId}`
          : Prisma.sql`fc."claimantOrgId" = ${organisation.id}`
        : Prisma.sql`fl."siteId" = ${siteId}`;

    const rows = await this.queryTopFoodRows(scopeFilter, collectedFilter);
    return this.buildTopFoodsResponse(
      siteId,
      null,
      start,
      end,
      rows,
      mode,
      organisation.organizationType,
    );
  }

  private async queryTopFoodRows(
    scopeFilter: Prisma.Sql,
    collectedFilter: Prisma.Sql,
  ) {
    return this.prisma.$queryRaw<
      {
        foodName: string;
        unit: string | null;
        category: string | null;
        totalKg: number;
        peopleKg: number;
        animalKg: number;
      }[]
    >`
      SELECT
        fi.name            AS "foodName",
        fi.unit            AS "unit",
        fi.category        AS "category",
        CAST(SUM(ci."qtyKg") AS FLOAT) AS "totalKg",
        CAST(SUM(
          CASE
            WHEN fl."listingType" = 'HUMAN' THEN ci."qtyKg"
            WHEN fl."listingType" = 'BOTH'
              AND o."organizationType" IN ('CHARITY', 'CHARITY_SINGLE', 'CHARITY_MULTI')
              THEN ci."qtyKg"
            ELSE 0
          END
        ) AS FLOAT) AS "peopleKg",
        CAST(SUM(
          CASE
            WHEN fl."listingType" = 'ANIMAL' THEN ci."qtyKg"
            WHEN fl."listingType" = 'BOTH'
              AND o."organizationType" = 'FARMER_CONSUMER'
              THEN ci."qtyKg"
            ELSE 0
          END
        ) AS FLOAT) AS "animalKg"
      FROM claim_items ci
      JOIN food_items      fi ON fi.id = ci."foodItemId"
      JOIN food_claims     fc ON fc.id = ci."claimId"
      JOIN food_listings   fl ON fl.id = fc."listingId"
      JOIN organisations   o  ON o.id  = fc."claimantOrgId"
      WHERE
        ${scopeFilter}
        AND fc.status != 'CANCELLED'
        ${collectedFilter}
      GROUP BY fi.name, fi.unit, fi.category
      ORDER BY "totalKg" DESC
      LIMIT 10
    `;
  }

  private buildTopFoodsCollectedFilter(start: Date | null, end: Date) {
    return start
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
  }

  private buildTopFoodsResponse(
    siteId: number | null,
    organisationId: number | null,
    start: Date | null,
    end: Date,
    rows: {
      foodName: string;
      unit: string | null;
      category: string | null;
      totalKg: number;
      peopleKg: number;
      animalKg: number;
    }[],
    mode: ImpactMode,
    organizationType: OrgType,
  ) {
    return {
      siteId,
      organisationId,
      mode,
      rangeStart: start?.toISOString() ?? null,
      rangeEnd: end.toISOString(),
      topFoods: rows.map((row, i) => {
        const totalKg = round2(Number(row.totalKg) || 0);
        let peopleKg = round2(Number(row.peopleKg) || 0);
        let animalKg = round2(Number(row.animalKg) || 0);

        if (mode === 'RECEIVER') {
          if (CHARITY_ORG_TYPES.includes(organizationType)) {
            peopleKg = totalKg;
            animalKg = 0;
          } else {
            animalKg = totalKg;
            peopleKg = 0;
          }
        } else if (peopleKg + animalKg <= 0 && totalKg > 0) {
          peopleKg = totalKg;
          animalKg = 0;
        } else if (peopleKg + animalKg > 0 && Math.abs(peopleKg + animalKg - totalKg) > 0.05) {
          const scale = totalKg / (peopleKg + animalKg);
          peopleKg = round2(peopleKg * scale);
          animalKg = round2(totalKg - peopleKg);
        }

        const peoplePercent = totalKg > 0 ? round1((peopleKg / totalKg) * 100) : 0;
        const animalPercent = totalKg > 0 ? round1((animalKg / totalKg) * 100) : 0;

        return {
          rank: i + 1,
          foodName: row.foodName,
          unit: row.unit ?? 'kg',
          category: row.category ?? null,
          totalKg,
          peopleKg,
          animalKg,
          peoplePercent,
          animalPercent,
          co2AvoidedKg: round2(totalKg * CO2_PER_KG),
          mealsCreated: Math.round(peopleKg / MEAL_WEIGHT_KG),
          totalFoodSavedUsd: round2(totalKg * FOOD_VALUE_PER_KG_USD),
        };
      }),
    };
  }

  // ─── Partner organisations (donated to / collected from) ──────────────────────

  /**
   * Partner organisations for a whole organisation.
   *
   * For a donor this answers "who collected our food"; for a charity or farmer
   * consumer the same query answers "who did we collect from", because the scope
   * filter simply pins the other side of the claim.
   */
  async getRecipients(
    caller: Jwtpayload,
    orgId: number,
    startDate?: string,
    endDate?: string,
  ) {
    await this.assertCanAccessOrg(caller, orgId);

    const organisation = await this.prisma.organisation.findUnique({
      where: { id: orgId },
      select: { organizationType: true },
    });
    if (!organisation) throw new NotFoundException('Organisation not found');

    const mode: ImpactMode = RECEIVER_ORG_TYPES.includes(organisation.organizationType)
      ? 'RECEIVER'
      : 'DONOR';

    const start = startDate ? new Date(startDate) : null;
    const end = endDate ? new Date(endDate) : new Date();

    // Donors own the listing; receivers own the claim.
    const scopeFilter =
      mode === 'RECEIVER'
        ? Prisma.sql`fc."claimantOrgId" = ${orgId}`
        : Prisma.sql`fl."organisationId" = ${orgId}`;

    const [rows, foodRows] = await Promise.all([
      this.queryRecipientRows(scopeFilter, start, end, mode),
      this.queryRecipientFoodRows(scopeFilter, start, end, mode),
    ]);

    return this.buildRecipientsResponse(null, orgId, start, end, mode, rows, foodRows);
  }

  /** Same report scoped to a single location. */
  async getRecipientsBySite(
    caller: Jwtpayload,
    siteId: number,
    startDate?: string,
    endDate?: string,
  ) {
    await this.assertCanAccessSite(caller, siteId);

    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: { organisationId: true },
    });
    if (!site) throw new NotFoundException('Site not found');

    const organisation = await this.prisma.organisation.findUnique({
      where: { id: site.organisationId },
      select: { id: true, organizationType: true },
    });
    if (!organisation) throw new NotFoundException('Organisation not found');

    const mode: ImpactMode = RECEIVER_ORG_TYPES.includes(organisation.organizationType)
      ? 'RECEIVER'
      : 'DONOR';

    const start = startDate ? new Date(startDate) : null;
    const end = endDate ? new Date(endDate) : new Date();

    const scopeFilter =
      mode === 'RECEIVER'
        ? Prisma.sql`fc."claimantOrgId" = ${organisation.id} AND fc."claimantSiteId" = ${siteId}`
        : Prisma.sql`fl."siteId" = ${siteId}`;

    const [rows, foodRows] = await Promise.all([
      this.queryRecipientRows(scopeFilter, start, end, mode),
      this.queryRecipientFoodRows(scopeFilter, start, end, mode),
    ]);

    return this.buildRecipientsResponse(siteId, null, start, end, mode, rows, foodRows);
  }

  /**
   * One row per partner organisation. `collections` counts distinct claims
   * rather than claim items, so a single pickup of six items stays one
   * collection.
   */
  private async queryRecipientRows(
    scopeFilter: Prisma.Sql,
    start: Date | null,
    end: Date,
    mode: ImpactMode,
  ) {
    const collectedFilter = this.buildTopFoodsCollectedFilter(start, end);
    const partner = this.partnerColumn(mode);

    return this.prisma.$queryRaw<
      {
        partnerOrgId: number;
        name: string;
        organizationType: OrgType;
        logoUrl: string | null;
        collections: number;
        totalKg: number;
        peopleKg: number;
        animalKg: number;
        firstCollectionAt: Date | null;
        lastCollectionAt: Date | null;
      }[]
    >`
      SELECT
        po.id                              AS "partnerOrgId",
        po.name                            AS "name",
        po."organizationType"              AS "organizationType",
        po."logoUrl"                       AS "logoUrl",
        CAST(COUNT(DISTINCT fc.id) AS INT) AS "collections",
        CAST(SUM(ci."qtyKg") AS FLOAT)     AS "totalKg",
        CAST(SUM(
          CASE
            WHEN fl."listingType" = 'HUMAN' THEN ci."qtyKg"
            WHEN fl."listingType" = 'BOTH'
              AND co."organizationType" IN ('CHARITY', 'CHARITY_SINGLE', 'CHARITY_MULTI')
              THEN ci."qtyKg"
            ELSE 0
          END
        ) AS FLOAT) AS "peopleKg",
        CAST(SUM(
          CASE
            WHEN fl."listingType" = 'ANIMAL' THEN ci."qtyKg"
            WHEN fl."listingType" = 'BOTH'
              AND co."organizationType" = 'FARMER_CONSUMER'
              THEN ci."qtyKg"
            ELSE 0
          END
        ) AS FLOAT) AS "animalKg",
        MIN(COALESCE(fc."collectedAt", fc."updatedAt")) AS "firstCollectionAt",
        MAX(COALESCE(fc."collectedAt", fc."updatedAt")) AS "lastCollectionAt"
      FROM claim_items ci
      JOIN food_claims   fc ON fc.id = ci."claimId"
      JOIN food_listings fl ON fl.id = fc."listingId"
      JOIN organisations co ON co.id = fc."claimantOrgId"
      JOIN organisations po ON po.id = ${partner}
      WHERE
        ${scopeFilter}
        AND fc.status != 'CANCELLED'
        ${collectedFilter}
      GROUP BY po.id, po.name, po."organizationType", po."logoUrl"
      ORDER BY "totalKg" DESC
      LIMIT 50
    `;
  }

  /** Food breakdown per partner — the top slice is taken in JS to keep the SQL flat. */
  private async queryRecipientFoodRows(
    scopeFilter: Prisma.Sql,
    start: Date | null,
    end: Date,
    mode: ImpactMode,
  ) {
    const collectedFilter = this.buildTopFoodsCollectedFilter(start, end);
    const partner = this.partnerColumn(mode);

    return this.prisma.$queryRaw<
      {
        partnerOrgId: number;
        foodName: string;
        category: string | null;
        unit: string | null;
        totalKg: number;
      }[]
    >`
      SELECT
        ${partner}                     AS "partnerOrgId",
        fi.name                        AS "foodName",
        fi.category                    AS "category",
        fi.unit                        AS "unit",
        CAST(SUM(ci."qtyKg") AS FLOAT) AS "totalKg"
      FROM claim_items ci
      JOIN food_items    fi ON fi.id = ci."foodItemId"
      JOIN food_claims   fc ON fc.id = ci."claimId"
      JOIN food_listings fl ON fl.id = fc."listingId"
      WHERE
        ${scopeFilter}
        AND fc.status != 'CANCELLED'
        ${collectedFilter}
      GROUP BY ${partner}, fi.name, fi.category, fi.unit
      ORDER BY "totalKg" DESC
    `;
  }

  /** The org on the other side of the claim from the caller. */
  private partnerColumn(mode: ImpactMode): Prisma.Sql {
    return mode === 'RECEIVER'
      ? Prisma.sql`fl."organisationId"`
      : Prisma.sql`fc."claimantOrgId"`;
  }

  private buildRecipientsResponse(
    siteId: number | null,
    organisationId: number | null,
    start: Date | null,
    end: Date,
    mode: ImpactMode,
    rows: {
      partnerOrgId: number;
      name: string;
      organizationType: OrgType;
      logoUrl: string | null;
      collections: number;
      totalKg: number;
      peopleKg: number;
      animalKg: number;
      firstCollectionAt: Date | null;
      lastCollectionAt: Date | null;
    }[],
    foodRows: {
      partnerOrgId: number;
      foodName: string;
      category: string | null;
      unit: string | null;
      totalKg: number;
    }[],
  ) {
    const foodsByPartner = new Map<number, typeof foodRows>();
    for (const row of foodRows) {
      const list = foodsByPartner.get(row.partnerOrgId) ?? [];
      list.push(row);
      foodsByPartner.set(row.partnerOrgId, list);
    }

    const totalKgAll = rows.reduce((sum, row) => sum + (Number(row.totalKg) || 0), 0);

    return {
      siteId,
      organisationId,
      mode,
      rangeStart: start?.toISOString() ?? null,
      rangeEnd: end.toISOString(),
      totalRecipients: rows.length,
      totalKg: round2(totalKgAll),
      recipients: rows.map((row, i) => {
        const totalKg = round2(Number(row.totalKg) || 0);
        let peopleKg = round2(Number(row.peopleKg) || 0);
        let animalKg = round2(Number(row.animalKg) || 0);

        // Who the partner is decides the split, so an unsplit total is
        // attributed whole rather than guessed.
        if (CHARITY_ORG_TYPES.includes(row.organizationType)) {
          peopleKg = totalKg;
          animalKg = 0;
        } else if (ANIMAL_ORG_TYPES.includes(row.organizationType)) {
          animalKg = totalKg;
          peopleKg = 0;
        } else if (peopleKg + animalKg <= 0 && totalKg > 0) {
          peopleKg = totalKg;
          animalKg = 0;
        }

        return {
          rank: i + 1,
          organisationId: row.partnerOrgId,
          name: row.name,
          organizationType: row.organizationType,
          logoUrl: row.logoUrl,
          collections: Number(row.collections) || 0,
          totalKg,
          peopleKg,
          animalKg,
          sharePercent: totalKgAll > 0 ? round1((totalKg / totalKgAll) * 100) : 0,
          mealsCreated: Math.round(peopleKg / MEAL_WEIGHT_KG),
          co2AvoidedKg: round2(totalKg * CO2_PER_KG),
          totalFoodSavedUsd: round2(totalKg * FOOD_VALUE_PER_KG_USD),
          firstCollectionAt: row.firstCollectionAt?.toISOString() ?? null,
          lastCollectionAt: row.lastCollectionAt?.toISOString() ?? null,
          foods: (foodsByPartner.get(row.partnerOrgId) ?? []).slice(0, 10).map((food) => ({
            foodName: food.foodName,
            category: food.category ?? null,
            unit: food.unit ?? 'kg',
            totalKg: round2(Number(food.totalKg) || 0),
          })),
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
