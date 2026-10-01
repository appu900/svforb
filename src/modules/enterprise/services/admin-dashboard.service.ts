import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../infra/prisma/prisma.service';

const REPORT_TIME_ZONE = 'Australia/Sydney';
const TYPE_IDS = ['food_business', 'charity', 'farmer', 'circular'] as const;
const PATHWAY_IDS = ['people', 'livestock', 'circular', 'bioenergy'] as const;

type TypeId = (typeof TYPE_IDS)[number];
type PathwayId = (typeof PATHWAY_IDS)[number];

export type AdminDashboardQuery = {
  from?: string;
  to?: string;
  organisationId?: number;
  orgType?: string;
  pathway?: string;
  country?: string;
  role?: string;
  accountStatus?: string;
};

export type AdminDashboardSummary = {
  from: string | null;
  to: string;
  previousFrom: string | null;
  previousTo: string | null;
  organisations: number;
  sites: number;
  activeSites: number;
  sitesWithRecovery: number;
  previousSitesWithRecovery: number;
  recoveredKg: number;
  previousRecoveredKg: number;
  collections: number;
  previousCollections: number;
  pathways: { pathway: PathwayId; kg: number }[];
  types: {
    id: TypeId;
    organisations: number;
    activeOrganisations: number;
    activeSites: number;
    listings: number;
    claims: number;
    collections: number;
    recoveredKg: number;
  }[];
  operations: {
    listingsPublished: number;
    previousListingsPublished: number;
    claimRate: number;
    previousClaimRate: number;
    recoveryRate: number;
    previousRecoveryRate: number;
    collectionsCompleted: number;
    previousCollectionsCompleted: number;
  };
  attention: {
    unclaimed: number;
    unresolved: number;
    awaitingActivation: number;
    quietSites: number;
  };
  daily: { date: string; kg: number; collections: number }[];
};

type OrgRow = { org_type: string; organisations: number; active_organisations: number };
type SiteRow = { org_type: string; sites: number; active_sites: number; quiet_sites: number };
type ClaimRow = {
  day: string;
  pathway: string;
  org_type: string;
  collections: number;
  kg: number;
  unresolved: number;
  sites: number;
};
type ListingRow = {
  day: string;
  org_type: string;
  published: number;
  claims: number;
  recovered: number;
  unclaimed: number;
};

const ORG_TYPE_SQL = Prisma.sql`
  CASE
    WHEN o."organizationType"::text LIKE 'CHARITY%' THEN 'charity'
    WHEN o."organizationType"::text LIKE 'FARMER%' THEN 'farmer'
    ELSE 'food_business'
  END
`;

const CLAIM_PATHWAY_SQL = Prisma.sql`
  CASE
    WHEN COALESCE(c."recoveryPathway"::text, l."recoveryPathway"::text) = 'LIVESTOCK_FEED' THEN 'livestock'
    WHEN COALESCE(c."recoveryPathway"::text, l."recoveryPathway"::text) = 'CIRCULAR_RECOVERY' THEN 'circular'
    WHEN COALESCE(c."recoveryPathway"::text, l."recoveryPathway"::text) = 'BIOENERGY' THEN 'bioenergy'
    WHEN COALESCE(c."recoveryPathway"::text, l."recoveryPathway"::text) = 'FOOD_FOR_PEOPLE' THEN 'people'
    WHEN l."listingType"::text = 'ANIMAL' THEN 'livestock'
    ELSE 'people'
  END
`;

const LISTING_PATHWAY_SQL = Prisma.sql`
  CASE
    WHEN l."recoveryPathway"::text = 'LIVESTOCK_FEED' THEN 'livestock'
    WHEN l."recoveryPathway"::text = 'CIRCULAR_RECOVERY' THEN 'circular'
    WHEN l."recoveryPathway"::text = 'BIOENERGY' THEN 'bioenergy'
    WHEN l."recoveryPathway"::text = 'FOOD_FOR_PEOPLE' THEN 'people'
    WHEN l."listingType"::text = 'ANIMAL' THEN 'livestock'
    ELSE 'people'
  END
`;

const CLAIM_DAY_SQL = Prisma.sql`
  (COALESCE(c."collectedAt", c."confirmedAt", c."createdAt") AT TIME ZONE 'UTC' AT TIME ZONE 'Australia/Sydney')::date
`;

const LISTING_DAY_SQL = Prisma.sql`
  (l."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Australia/Sydney')::date
`;

function isDay(value?: string): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

function sydneyToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: REPORT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function addIsoDays(iso: string, days: number) {
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function inclusiveDays(from: string, to: string) {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.max(1, Math.round((end - start) / 86400000) + 1);
}

function eachDay(from: string, to: string) {
  const days: string[] = [];
  const count = inclusiveDays(from, to);
  for (let offset = 0; offset < count; offset += 1) days.push(addIsoDays(from, offset));
  return days;
}

function num(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rate(part: number, whole: number) {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

@Injectable()
export class AdminDashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(query: AdminDashboardQuery): Promise<AdminDashboardSummary> {
    const to = isDay(query.to) ? query.to : sydneyToday();
    const from = isDay(query.from) ? query.from : null;
    const currentFrom = from && from > to ? to : from;
    const currentTo = from && from > to ? from : to;
    const span = currentFrom ? inclusiveDays(currentFrom, currentTo) : 0;
    const previousTo = currentFrom ? addIsoDays(currentFrom, -1) : null;
    const previousFrom = currentFrom && previousTo ? addIsoDays(previousTo, -(span - 1)) : null;
    const scanFrom = previousFrom ?? currentFrom;

    const orgType = TYPE_IDS.includes(query.orgType as TypeId) ? query.orgType : null;
    const pathway = PATHWAY_IDS.includes(query.pathway as PathwayId) ? query.pathway : null;
    const country = query.country && query.country !== 'all' ? query.country.trim().toUpperCase() : null;
    const role =
      query.role === 'surplus_provider' || query.role === 'surplus_receiver' || query.role === 'both'
        ? query.role
        : null;
    const accountStatus =
      query.accountStatus === 'Active' || query.accountStatus === 'Prospect' || query.accountStatus === 'Suspended'
        ? query.accountStatus
        : null;

    const scoped = Prisma.sql`
      SELECT
        o.id,
        ${ORG_TYPE_SQL} AS org_type,
        ep."accountStatus" AS account_status
      FROM organisations o
      JOIN enterprise_profiles ep ON ep."organisationId" = o.id
      WHERE 1 = 1
      ${query.organisationId ? Prisma.sql`AND o.id = ${query.organisationId}` : Prisma.empty}
      ${country ? Prisma.sql`AND upper(ep.country) = ${country}` : Prisma.empty}
      ${orgType ? Prisma.sql`AND (${ORG_TYPE_SQL}) = ${orgType}` : Prisma.empty}
      ${role === 'surplus_provider' ? Prisma.sql`AND (${ORG_TYPE_SQL}) = 'food_business'` : Prisma.empty}
      ${role === 'surplus_receiver' ? Prisma.sql`AND (${ORG_TYPE_SQL}) IN ('charity', 'farmer', 'circular')` : Prisma.empty}
      ${role === 'both' ? Prisma.sql`AND (${ORG_TYPE_SQL}) = 'circular'` : Prisma.empty}
      ${accountStatus === 'Active' ? Prisma.sql`AND ep."accountStatus" = 'ACTIVE'` : Prisma.empty}
      ${accountStatus === 'Prospect' ? Prisma.sql`AND ep."accountStatus" = 'PENDING'` : Prisma.empty}
      ${accountStatus === 'Suspended' ? Prisma.sql`AND ep."accountStatus" IN ('SUSPENDED', 'CLOSED')` : Prisma.empty}
    `;

    const [orgRows, siteRows, claimRows, listingRows, awaiting, recoverySites] = await Promise.all([
      this.prisma.$queryRaw<OrgRow[]>(Prisma.sql`
        SELECT org_type,
          COUNT(*)::int AS organisations,
          COUNT(*) FILTER (WHERE account_status = 'ACTIVE')::int AS active_organisations
        FROM (${scoped}) scoped_orgs
        GROUP BY org_type
      `),
      this.prisma.$queryRaw<SiteRow[]>(Prisma.sql`
        WITH scoped_orgs AS (${scoped})
        SELECT
          so.org_type,
          COUNT(*)::int AS sites,
          COUNT(*) FILTER (WHERE s."isActive")::int AS active_sites,
          COUNT(*) FILTER (
            WHERE s."isActive"
              AND (
                s."lastActivityAt" IS NULL
                OR (s."lastActivityAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Australia/Sydney')::date
                  < ((CURRENT_TIMESTAMP AT TIME ZONE 'Australia/Sydney')::date - 29)
              )
          )::int AS quiet_sites
        FROM sites s
        JOIN scoped_orgs so ON so.id = s."organisationId"
        GROUP BY so.org_type
      `),
      this.prisma.$queryRaw<ClaimRow[]>(Prisma.sql`
        WITH scoped_orgs AS (${scoped}),
        claim_rows AS (
          SELECT
            c.id,
            c.status::text AS status,
            l."siteId" AS site_id,
            so.org_type,
            ${CLAIM_DAY_SQL} AS day,
            ${CLAIM_PATHWAY_SQL} AS pathway,
            COALESCE(NULLIF(items.kg, 0), l."totalQtyKg", 0) AS kg
          FROM food_claims c
          JOIN food_listings l ON l.id = c."listingId"
          JOIN scoped_orgs so ON so.id = l."organisationId"
          LEFT JOIN LATERAL (
            SELECT COALESCE(SUM(ci."qtyKg"), 0) AS kg
            FROM claim_items ci
            WHERE ci."claimId" = c.id
          ) items ON true
          WHERE ${CLAIM_DAY_SQL} <= ${currentTo}::date
            ${scanFrom ? Prisma.sql`AND ${CLAIM_DAY_SQL} >= ${scanFrom}::date` : Prisma.empty}
        )
        SELECT
          day::text AS day,
          pathway,
          org_type,
          COUNT(*) FILTER (WHERE status = 'COLLECTED')::int AS collections,
          COALESCE(SUM(kg) FILTER (WHERE status = 'COLLECTED'), 0)::float AS kg,
          COUNT(*) FILTER (WHERE status IN ('PENDING', 'CONFIRMED'))::int AS unresolved,
          COUNT(DISTINCT site_id) FILTER (WHERE status = 'COLLECTED')::int AS sites
        FROM claim_rows
        WHERE (${pathway}::text IS NULL OR pathway = ${pathway})
        GROUP BY day, pathway, org_type
      `),
      this.prisma.$queryRaw<ListingRow[]>(Prisma.sql`
        WITH scoped_orgs AS (${scoped}),
        listing_rows AS (
          SELECT
            l.status::text AS status,
            so.org_type,
            ${LISTING_DAY_SQL} AS day,
            ${LISTING_PATHWAY_SQL} AS pathway,
            EXISTS (
              SELECT 1 FROM food_claims c
              WHERE c."listingId" = l.id AND c.status <> 'CANCELLED'
            ) AS claimed,
            EXISTS (
              SELECT 1 FROM food_claims c
              WHERE c."listingId" = l.id AND c.status = 'COLLECTED'
            ) AS recovered
          FROM food_listings l
          JOIN scoped_orgs so ON so.id = l."organisationId"
          WHERE ${LISTING_DAY_SQL} <= ${currentTo}::date
            ${scanFrom ? Prisma.sql`AND ${LISTING_DAY_SQL} >= ${scanFrom}::date` : Prisma.empty}
        )
        SELECT
          day::text AS day,
          org_type,
          COUNT(*) FILTER (WHERE status <> 'CANCELLED')::int AS published,
          COUNT(*) FILTER (WHERE status <> 'CANCELLED' AND (claimed OR status IN ('PARTIAL', 'CLAIMED')))::int AS claims,
          COUNT(*) FILTER (WHERE status <> 'CANCELLED' AND recovered)::int AS recovered,
          COUNT(*) FILTER (WHERE status IN ('ACTIVE', 'EXPIRED'))::int AS unclaimed
        FROM listing_rows
        WHERE (${pathway}::text IS NULL OR pathway = ${pathway})
        GROUP BY day, org_type
      `),
      this.prisma.$queryRaw<Array<{ awaiting: number }>>(Prisma.sql`
        SELECT COUNT(*)::int AS awaiting
        FROM (${scoped}) scoped_orgs
        WHERE account_status = 'PENDING'
      `),
      this.prisma.$queryRaw<Array<{ current_sites: number; previous_sites: number }>>(Prisma.sql`
        WITH scoped_orgs AS (${scoped}),
        claim_rows AS (
          SELECT
            c.status::text AS status,
            l."siteId" AS site_id,
            ${CLAIM_DAY_SQL} AS day,
            ${CLAIM_PATHWAY_SQL} AS pathway
          FROM food_claims c
          JOIN food_listings l ON l.id = c."listingId"
          JOIN scoped_orgs so ON so.id = l."organisationId"
          WHERE ${CLAIM_DAY_SQL} <= ${currentTo}::date
            ${scanFrom ? Prisma.sql`AND ${CLAIM_DAY_SQL} >= ${scanFrom}::date` : Prisma.empty}
        )
        SELECT
          COUNT(DISTINCT site_id) FILTER (
            WHERE status = 'COLLECTED'
              AND day <= ${currentTo}::date
              ${currentFrom ? Prisma.sql`AND day >= ${currentFrom}::date` : Prisma.empty}
          )::int AS current_sites,
          COUNT(DISTINCT site_id) FILTER (
            WHERE status = 'COLLECTED'
              ${previousFrom && previousTo ? Prisma.sql`AND day >= ${previousFrom}::date AND day <= ${previousTo}::date` : Prisma.sql`AND false`}
          )::int AS previous_sites
        FROM claim_rows
        WHERE (${pathway}::text IS NULL OR pathway = ${pathway})
      `),
    ]);

    return this.assemble({
      currentFrom,
      currentTo,
      previousFrom,
      previousTo,
      orgRows,
      siteRows,
      claimRows,
      listingRows,
      awaiting: num(awaiting[0]?.awaiting),
      sitesWithRecovery: num(recoverySites[0]?.current_sites),
      previousSitesWithRecovery: num(recoverySites[0]?.previous_sites),
    });
  }

  private assemble(input: {
    currentFrom: string | null;
    currentTo: string;
    previousFrom: string | null;
    previousTo: string | null;
    orgRows: OrgRow[];
    siteRows: SiteRow[];
    claimRows: ClaimRow[];
    listingRows: ListingRow[];
    awaiting: number;
    sitesWithRecovery: number;
    previousSitesWithRecovery: number;
  }): AdminDashboardSummary {
    const inCurrent = (day: string) =>
      (!input.currentFrom || day >= input.currentFrom) && day <= input.currentTo;
    const inPrevious = (day: string) =>
      Boolean(input.previousFrom && input.previousTo && day >= input.previousFrom && day <= input.previousTo);

    const types = TYPE_IDS.map((id) => ({
      id,
      organisations: 0,
      activeOrganisations: 0,
      activeSites: 0,
      listings: 0,
      claims: 0,
      collections: 0,
      recoveredKg: 0,
    }));
    const typeOf = (id: string) => types.find((row) => row.id === id);

    let organisations = 0;
    let sites = 0;
    let activeSites = 0;
    let quietSites = 0;
    for (const row of input.orgRows) {
      const type = typeOf(row.org_type);
      const count = num(row.organisations);
      const active = num(row.active_organisations);
      organisations += count;
      if (type) {
        type.organisations = count;
        type.activeOrganisations = active;
      }
    }
    for (const row of input.siteRows) {
      const type = typeOf(row.org_type);
      sites += num(row.sites);
      activeSites += num(row.active_sites);
      quietSites += num(row.quiet_sites);
      if (type) type.activeSites = num(row.active_sites);
    }

    const pathwayKg = new Map<PathwayId, number>(PATHWAY_IDS.map((id) => [id, 0]));
    const daily = new Map<string, { kg: number; collections: number }>();
    let recoveredKg = 0;
    let previousRecoveredKg = 0;
    let collections = 0;
    let previousCollections = 0;
    let unresolved = 0;

    for (const row of input.claimRows) {
      const kg = num(row.kg);
      const count = num(row.collections);
      const current = inCurrent(row.day);
      const previous = inPrevious(row.day);
      if (current) {
        recoveredKg += kg;
        collections += count;
        unresolved += num(row.unresolved);
        const bucket = daily.get(row.day) ?? { kg: 0, collections: 0 };
        bucket.kg += kg;
        bucket.collections += count;
        daily.set(row.day, bucket);
        if (PATHWAY_IDS.includes(row.pathway as PathwayId)) {
          pathwayKg.set(row.pathway as PathwayId, (pathwayKg.get(row.pathway as PathwayId) ?? 0) + kg);
        }
        const type = typeOf(row.org_type);
        if (type) {
          type.collections += count;
          type.recoveredKg += kg;
        }
      }
      if (previous) {
        previousRecoveredKg += kg;
        previousCollections += count;
      }
    }

    let listingsPublished = 0;
    let previousListingsPublished = 0;
    let claimedListings = 0;
    let previousClaimedListings = 0;
    let recoveredListings = 0;
    let previousRecoveredListings = 0;
    let unclaimed = 0;
    for (const row of input.listingRows) {
      const published = num(row.published);
      const claims = num(row.claims);
      const recovered = num(row.recovered);
      if (inCurrent(row.day)) {
        listingsPublished += published;
        claimedListings += claims;
        recoveredListings += recovered;
        unclaimed += num(row.unclaimed);
        const type = typeOf(row.org_type);
        if (type) {
          type.listings += published;
          type.claims += claims;
        }
      }
      if (inPrevious(row.day)) {
        previousListingsPublished += published;
        previousClaimedListings += claims;
        previousRecoveredListings += recovered;
      }
    }

    const filledDaily =
      input.currentFrom && inclusiveDays(input.currentFrom, input.currentTo) <= 400
        ? eachDay(input.currentFrom, input.currentTo).map((date) => ({
            date,
            kg: daily.get(date)?.kg ?? 0,
            collections: daily.get(date)?.collections ?? 0,
          }))
        : [...daily.entries()]
            .filter(([date]) => inCurrent(date))
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([date, value]) => ({ date, kg: value.kg, collections: value.collections }));

    return {
      from: input.currentFrom,
      to: input.currentTo,
      previousFrom: input.previousFrom,
      previousTo: input.previousTo,
      organisations,
      sites,
      activeSites,
      sitesWithRecovery: input.sitesWithRecovery,
      previousSitesWithRecovery: input.previousSitesWithRecovery,
      recoveredKg,
      previousRecoveredKg,
      collections,
      previousCollections,
      pathways: PATHWAY_IDS.map((id) => ({ pathway: id, kg: pathwayKg.get(id) ?? 0 })),
      types,
      operations: {
        listingsPublished,
        previousListingsPublished,
        claimRate: rate(claimedListings, listingsPublished),
        previousClaimRate: rate(previousClaimedListings, previousListingsPublished),
        recoveryRate: rate(recoveredListings, listingsPublished),
        previousRecoveryRate: rate(previousRecoveredListings, previousListingsPublished),
        collectionsCompleted: collections,
        previousCollectionsCompleted: previousCollections,
      },
      attention: {
        unclaimed,
        unresolved,
        awaitingActivation: input.awaiting,
        quietSites,
      },
      daily: filledDaily,
    };
  }
}
