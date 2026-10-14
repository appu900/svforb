import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../infra/prisma/prisma.service';

const REPORT_TIME_ZONE = 'Australia/Sydney';

export type AdminConnectionsQuery = {
  from?: string;
  to?: string;
  organisationId?: number;
};

type Party = { orgId: number; orgName: string; siteId: number; siteName: string };
type Person = { name: string; email: string } | null;

export type AdminConnectionDays = {
  scheduled: number;
  collected: number;
  released: number;
  noFood: number;
  missed: number;
  open: number;
};

export type AdminConnectionRow = {
  id: number;
  status: string;
  createdAt: string;
  respondedAt: string | null;
  invitationExpiresAt: string | null;
  endedAt: string | null;
  donor: Party;
  receiver: Party;
  invitedBy: Person;
  respondedBy: Person;
  endedBy: Person;
  daysOfWeek: number[];
  windowStartMinutes: number;
  windowEndMinutes: number;
  typicalSurplus: string | null;
  typicalQuantity: string | null;
  listings: number;
  pickups: number;
  collectedKg: number;
  days: AdminConnectionDays;
};

type ImpactBucket = { listings: number; listedKg: number; pickups: number; collectedKg: number };

export type AdminConnectionsSummary = {
  from: string | null;
  to: string;
  impact: { connection: ImpactBucket; oneOff: ImpactBucket };
  connections: AdminConnectionRow[];
};

type RawConnection = {
  id: number;
  status: string;
  created_at: Date;
  responded_at: Date | null;
  invitation_expires_at: Date | null;
  ended_at: Date | null;
  donor_org_id: number;
  donor_org_name: string;
  donor_site_id: number;
  donor_site_name: string;
  receiver_org_id: number;
  receiver_org_name: string;
  receiver_site_id: number;
  receiver_site_name: string;
  invited_name: string | null;
  invited_email: string | null;
  responded_name: string | null;
  responded_email: string | null;
  ended_name: string | null;
  ended_email: string | null;
  days_of_week: number[];
  window_start_minutes: number;
  window_end_minutes: number;
  typical_surplus: string | null;
  typical_quantity: string | null;
  listings: number;
  pickups: number;
  collected_kg: number;
  days_scheduled: number;
  days_collected: number;
  days_released: number;
  days_no_food: number;
  days_missed: number;
  days_open: number;
};

const CLAIM_DAY_SQL = Prisma.sql`
  (COALESCE(c."collectedAt", c."confirmedAt", c."createdAt") AT TIME ZONE 'UTC' AT TIME ZONE 'Australia/Sydney')::date
`;

const LISTING_DAY_SQL = Prisma.sql`
  (l."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Australia/Sydney')::date
`;

const SCHEDULED_DAY_SQL = Prisma.sql`(d."scheduledDate" AT TIME ZONE 'UTC')::date`;

const CLAIM_KG_SQL = Prisma.sql`
  COALESCE(
    NULLIF((SELECT COALESCE(SUM(ci."qtyKg"), 0) FROM claim_items ci WHERE ci."claimId" = c.id), 0),
    l."totalQtyKg",
    0
  )
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

function num(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function iso(value: Date | null) {
  return value ? value.toISOString() : null;
}

function person(name: string | null, email: string | null): Person {
  if (!name?.trim() && !email) return null;
  return { name: name?.trim() || email || '', email: email ?? '' };
}

@Injectable()
export class AdminConnectionsService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(query: AdminConnectionsQuery): Promise<AdminConnectionsSummary> {
    const to = isDay(query.to) ? query.to : sydneyToday();
    const from = isDay(query.from) && query.from <= to ? query.from : null;
    const orgId = query.organisationId ?? null;

    const inPeriod = (day: Prisma.Sql) =>
      Prisma.sql`${day} <= ${to}::date ${from ? Prisma.sql`AND ${day} >= ${from}::date` : Prisma.empty}`;
    const connectionScope = orgId
      ? Prisma.sql`AND (cn."donorOrgId" = ${orgId} OR cn."receiverOrgId" = ${orgId})`
      : Prisma.empty;

    const [listingRows, claimRows, connectionRows] = await Promise.all([
      this.prisma.$queryRaw<Array<{ via_connection: boolean; listings: number; listed_kg: number }>>(Prisma.sql`
        SELECT
          (l."connectionId" IS NOT NULL) AS via_connection,
          COUNT(*)::int AS listings,
          COALESCE(SUM(l."totalQtyKg"), 0)::float AS listed_kg
        FROM food_listings l
        LEFT JOIN connections cn ON cn.id = l."connectionId"
        WHERE l.status::text <> 'CANCELLED'
          AND ${inPeriod(LISTING_DAY_SQL)}
          ${orgId ? Prisma.sql`AND (l."organisationId" = ${orgId} OR cn."receiverOrgId" = ${orgId})` : Prisma.empty}
        GROUP BY via_connection
      `),
      this.prisma.$queryRaw<Array<{ via_connection: boolean; pickups: number; kg: number }>>(Prisma.sql`
        SELECT
          (l."connectionId" IS NOT NULL) AS via_connection,
          COUNT(*)::int AS pickups,
          COALESCE(SUM(${CLAIM_KG_SQL}), 0)::float AS kg
        FROM food_claims c
        JOIN food_listings l ON l.id = c."listingId"
        LEFT JOIN connections cn ON cn.id = l."connectionId"
        WHERE c.status::text = 'COLLECTED'
          AND ${inPeriod(CLAIM_DAY_SQL)}
          ${
            orgId
              ? Prisma.sql`AND (l."organisationId" = ${orgId} OR c."claimantOrgId" = ${orgId} OR cn."receiverOrgId" = ${orgId})`
              : Prisma.empty
          }
        GROUP BY via_connection
      `),
      this.prisma.$queryRaw<RawConnection[]>(Prisma.sql`
        SELECT
          cn.id,
          cn.status::text AS status,
          cn."createdAt" AS created_at,
          cn."respondedAt" AS responded_at,
          cn."invitationExpiresAt" AS invitation_expires_at,
          cn."endedAt" AS ended_at,
          cn."donorOrgId" AS donor_org_id,
          dor.name AS donor_org_name,
          cn."donorSiteId" AS donor_site_id,
          COALESCE(ds.name, ds."organisationName") AS donor_site_name,
          cn."receiverOrgId" AS receiver_org_id,
          ror.name AS receiver_org_name,
          cn."receiverSiteId" AS receiver_site_id,
          COALESCE(rs.name, rs."organisationName") AS receiver_site_name,
          concat_ws(' ', iu."firstName", iu."lastName") AS invited_name,
          iu.email AS invited_email,
          concat_ws(' ', ru."firstName", ru."lastName") AS responded_name,
          ru.email AS responded_email,
          concat_ws(' ', eu."firstName", eu."lastName") AS ended_name,
          eu.email AS ended_email,
          cn."daysOfWeek" AS days_of_week,
          cn."windowStartMinutes" AS window_start_minutes,
          cn."windowEndMinutes" AS window_end_minutes,
          cn."typicalSurplus" AS typical_surplus,
          cn."typicalQuantity" AS typical_quantity,
          COALESCE(listing_stats.listings, 0)::int AS listings,
          COALESCE(claim_stats.pickups, 0)::int AS pickups,
          COALESCE(claim_stats.collected_kg, 0)::float AS collected_kg,
          COALESCE(day_stats.scheduled, 0)::int AS days_scheduled,
          COALESCE(day_stats.collected, 0)::int AS days_collected,
          COALESCE(day_stats.released, 0)::int AS days_released,
          COALESCE(day_stats.no_food, 0)::int AS days_no_food,
          COALESCE(day_stats.missed, 0)::int AS days_missed,
          COALESCE(day_stats.open, 0)::int AS days_open
        FROM connections cn
        JOIN organisations dor ON dor.id = cn."donorOrgId"
        JOIN organisations ror ON ror.id = cn."receiverOrgId"
        JOIN sites ds ON ds.id = cn."donorSiteId"
        JOIN sites rs ON rs.id = cn."receiverSiteId"
        LEFT JOIN users iu ON iu.id = cn."invitedByUserId"
        LEFT JOIN users ru ON ru.id = cn."respondedByUserId"
        LEFT JOIN users eu ON eu.id = cn."endedByUserId"
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS listings
          FROM food_listings l
          WHERE l."connectionId" = cn.id AND l.status::text <> 'CANCELLED' AND ${inPeriod(LISTING_DAY_SQL)}
        ) listing_stats ON true
        LEFT JOIN LATERAL (
          SELECT COUNT(c.id) AS pickups, SUM(${CLAIM_KG_SQL}) AS collected_kg
          FROM food_listings l
          JOIN food_claims c ON c."listingId" = l.id
          WHERE l."connectionId" = cn.id
            AND c.status::text = 'COLLECTED'
            AND ${inPeriod(CLAIM_DAY_SQL)}
        ) claim_stats ON true
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*) AS scheduled,
            COUNT(*) FILTER (WHERE d.outcome::text = 'COLLECTED') AS collected,
            COUNT(*) FILTER (WHERE d.outcome::text = 'RELEASED') AS released,
            COUNT(*) FILTER (WHERE d.outcome::text = 'NO_SURPLUS') AS no_food,
            COUNT(*) FILTER (WHERE d.outcome::text IN ('NO_RESPONSE', 'MISSED')) AS missed,
            COUNT(*) FILTER (WHERE d.outcome::text IN ('PROMPTED', 'PUBLISHED')) AS open
          FROM connection_days d
          WHERE d."connectionId" = cn.id AND ${inPeriod(SCHEDULED_DAY_SQL)}
        ) day_stats ON true
        WHERE 1 = 1 ${connectionScope}
        ORDER BY cn."createdAt" DESC
        LIMIT 2000
      `),
    ]);

    const connection: ImpactBucket = { listings: 0, listedKg: 0, pickups: 0, collectedKg: 0 };
    const oneOff: ImpactBucket = { listings: 0, listedKg: 0, pickups: 0, collectedKg: 0 };
    for (const row of listingRows) {
      const target = row.via_connection ? connection : oneOff;
      target.listings += num(row.listings);
      target.listedKg += num(row.listed_kg);
    }
    for (const row of claimRows) {
      const target = row.via_connection ? connection : oneOff;
      target.pickups += num(row.pickups);
      target.collectedKg += num(row.kg);
    }

    return {
      from,
      to,
      impact: { connection, oneOff },
      connections: connectionRows.map((row) => ({
        id: row.id,
        status: row.status,
        createdAt: row.created_at.toISOString(),
        respondedAt: iso(row.responded_at),
        invitationExpiresAt: iso(row.invitation_expires_at),
        endedAt: iso(row.ended_at),
        donor: {
          orgId: row.donor_org_id,
          orgName: row.donor_org_name,
          siteId: row.donor_site_id,
          siteName: row.donor_site_name,
        },
        receiver: {
          orgId: row.receiver_org_id,
          orgName: row.receiver_org_name,
          siteId: row.receiver_site_id,
          siteName: row.receiver_site_name,
        },
        invitedBy: person(row.invited_name, row.invited_email),
        respondedBy: person(row.responded_name, row.responded_email),
        endedBy: person(row.ended_name, row.ended_email),
        daysOfWeek: row.days_of_week ?? [],
        windowStartMinutes: num(row.window_start_minutes),
        windowEndMinutes: num(row.window_end_minutes),
        typicalSurplus: row.typical_surplus,
        typicalQuantity: row.typical_quantity,
        listings: num(row.listings),
        pickups: num(row.pickups),
        collectedKg: num(row.collected_kg),
        days: {
          scheduled: num(row.days_scheduled),
          collected: num(row.days_collected),
          released: num(row.days_released),
          noFood: num(row.days_no_food),
          missed: num(row.days_missed),
          open: num(row.days_open),
        },
      })),
    };
  }
}
