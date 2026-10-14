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

export type AdminConnectionRow = {
  id: number;
  status: string;
  initiatedBy: string;
  createdAt: string;
  respondedAt: string | null;
  invitationExpiresAt: string | null;
  pausedAt: string | null;
  endedAt: string | null;
  donor: Party;
  receiver: Party;
  invitedBy: Person;
  respondedBy: Person;
  endedBy: Person;
  frequency: string;
  daysOfWeek: number[];
  windowStartMinutes: number;
  windowEndMinutes: number;
  typicalSurplus: string | null;
  typicalQuantity: string | null;
  listings: number;
  collections: number;
  collectedKg: number;
};

type ImpactBucket = { listings: number; listedKg: number; collections: number; collectedKg: number };

export type AdminConnectionsSummary = {
  from: string | null;
  to: string;
  invitations: {
    sent: number;
    accepted: number;
    declined: number;
    pending: number;
    expired: number;
    acceptanceRate: number;
    averageResponseHours: number | null;
  };
  current: { active: number; paused: number; pending: number; ended: number; declined: number; expired: number };
  impact: {
    connection: ImpactBucket & { preferredKg: number; networkKg: number };
    oneOff: ImpactBucket;
  };
  days: {
    scheduled: number;
    collected: number;
    released: number;
    noSurplus: number;
    noResponse: number;
    missed: number;
    open: number;
  };
  connections: AdminConnectionRow[];
};

type RawConnection = {
  id: number;
  status: string;
  initiated_by: string;
  created_at: Date;
  responded_at: Date | null;
  invitation_expires_at: Date | null;
  paused_at: Date | null;
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
  frequency: string;
  days_of_week: number[];
  window_start_minutes: number;
  window_end_minutes: number;
  typical_surplus: string | null;
  typical_quantity: string | null;
  listings: number;
  collections: number;
  collected_kg: number;
};

const CLAIM_DAY_SQL = Prisma.sql`
  (COALESCE(c."collectedAt", c."confirmedAt", c."createdAt") AT TIME ZONE 'UTC' AT TIME ZONE 'Australia/Sydney')::date
`;

const LISTING_DAY_SQL = Prisma.sql`
  (l."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Australia/Sydney')::date
`;

const CONNECTION_DAY_SQL = Prisma.sql`
  (cn."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Australia/Sydney')::date
`;

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
    const listingScope = orgId
      ? Prisma.sql`AND (l."organisationId" = ${orgId} OR c."claimantOrgId" = ${orgId})`
      : Prisma.empty;

    const [invitationRows, currentRows, listingRows, claimRows, dayRows, connectionRows] = await Promise.all([
      this.prisma.$queryRaw<
        Array<{ sent: number; accepted: number; declined: number; pending: number; expired: number; response_hours: number | null }>
      >(Prisma.sql`
        SELECT
          COUNT(*)::int AS sent,
          COUNT(*) FILTER (WHERE cn."respondedAt" IS NOT NULL AND cn.status::text <> 'DECLINED')::int AS accepted,
          COUNT(*) FILTER (WHERE cn.status::text = 'DECLINED')::int AS declined,
          COUNT(*) FILTER (WHERE cn.status::text = 'PENDING')::int AS pending,
          COUNT(*) FILTER (WHERE cn.status::text = 'EXPIRED')::int AS expired,
          AVG(EXTRACT(EPOCH FROM (cn."respondedAt" - cn."createdAt")) / 3600)
            FILTER (WHERE cn."respondedAt" IS NOT NULL)::float AS response_hours
        FROM connections cn
        WHERE ${inPeriod(CONNECTION_DAY_SQL)} ${connectionScope}
      `),
      this.prisma.$queryRaw<Array<{ status: string; count: number }>>(Prisma.sql`
        SELECT cn.status::text AS status, COUNT(*)::int AS count
        FROM connections cn
        WHERE 1 = 1 ${connectionScope}
        GROUP BY cn.status
      `),
      this.prisma.$queryRaw<Array<{ via_connection: boolean; listings: number; listed_kg: number }>>(Prisma.sql`
        SELECT
          (l."connectionId" IS NOT NULL) AS via_connection,
          COUNT(*)::int AS listings,
          COALESCE(SUM(l."totalQtyKg"), 0)::float AS listed_kg
        FROM food_listings l
        WHERE l.status::text <> 'CANCELLED'
          AND ${inPeriod(LISTING_DAY_SQL)}
          ${orgId ? Prisma.sql`AND l."organisationId" = ${orgId}` : Prisma.empty}
        GROUP BY via_connection
      `),
      this.prisma.$queryRaw<Array<{ source: string; collections: number; kg: number }>>(Prisma.sql`
        SELECT
          CASE
            WHEN l."connectionId" IS NULL THEN 'one_off'
            WHEN c."claimantOrgId" = cn."receiverOrgId" THEN 'preferred'
            ELSE 'network'
          END AS source,
          COUNT(*)::int AS collections,
          COALESCE(SUM(${CLAIM_KG_SQL}), 0)::float AS kg
        FROM food_claims c
        JOIN food_listings l ON l.id = c."listingId"
        LEFT JOIN connections cn ON cn.id = l."connectionId"
        WHERE c.status::text = 'COLLECTED'
          AND ${inPeriod(CLAIM_DAY_SQL)}
          ${listingScope}
        GROUP BY source
      `),
      this.prisma.$queryRaw<Array<{ outcome: string; count: number }>>(Prisma.sql`
        SELECT d.outcome::text AS outcome, COUNT(*)::int AS count
        FROM connection_days d
        JOIN connections cn ON cn.id = d."connectionId"
        WHERE (d."scheduledDate" AT TIME ZONE 'UTC')::date <= ${to}::date
          ${from ? Prisma.sql`AND (d."scheduledDate" AT TIME ZONE 'UTC')::date >= ${from}::date` : Prisma.empty}
          ${connectionScope}
        GROUP BY d.outcome
      `),
      this.prisma.$queryRaw<RawConnection[]>(Prisma.sql`
        SELECT
          cn.id,
          cn.status::text AS status,
          cn."initiatedBy"::text AS initiated_by,
          cn."createdAt" AS created_at,
          cn."respondedAt" AS responded_at,
          cn."invitationExpiresAt" AS invitation_expires_at,
          cn."pausedAt" AS paused_at,
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
          cn.frequency::text AS frequency,
          cn."daysOfWeek" AS days_of_week,
          cn."windowStartMinutes" AS window_start_minutes,
          cn."windowEndMinutes" AS window_end_minutes,
          cn."typicalSurplus" AS typical_surplus,
          cn."typicalQuantity" AS typical_quantity,
          COALESCE(stats.listings, 0)::int AS listings,
          COALESCE(stats.collections, 0)::int AS collections,
          COALESCE(stats.collected_kg, 0)::float AS collected_kg
        FROM connections cn
        JOIN organisations dor ON dor.id = cn."donorOrgId"
        JOIN organisations ror ON ror.id = cn."receiverOrgId"
        JOIN sites ds ON ds.id = cn."donorSiteId"
        JOIN sites rs ON rs.id = cn."receiverSiteId"
        LEFT JOIN users iu ON iu.id = cn."invitedByUserId"
        LEFT JOIN users ru ON ru.id = cn."respondedByUserId"
        LEFT JOIN users eu ON eu.id = cn."endedByUserId"
        LEFT JOIN LATERAL (
          SELECT
            (
              SELECT COUNT(*) FROM food_listings l
              WHERE l."connectionId" = cn.id AND l.status::text <> 'CANCELLED' AND ${inPeriod(LISTING_DAY_SQL)}
            ) AS listings,
            COUNT(c.id) AS collections,
            SUM(${CLAIM_KG_SQL}) AS collected_kg
          FROM food_listings l
          JOIN food_claims c ON c."listingId" = l.id
          WHERE l."connectionId" = cn.id
            AND c.status::text = 'COLLECTED'
            AND c."claimantOrgId" = cn."receiverOrgId"
            AND ${inPeriod(CLAIM_DAY_SQL)}
        ) stats ON true
        WHERE 1 = 1 ${connectionScope}
        ORDER BY cn."createdAt" DESC
        LIMIT 2000
      `),
    ]);

    const invitation = invitationRows[0];
    const sent = num(invitation?.sent);
    const accepted = num(invitation?.accepted);
    const declined = num(invitation?.declined);
    const answered = accepted + declined;

    const current = { active: 0, paused: 0, pending: 0, ended: 0, declined: 0, expired: 0 };
    for (const row of currentRows) {
      const key = row.status.toLowerCase() as keyof typeof current;
      if (key in current) current[key] = num(row.count);
    }

    const connectionBucket = { listings: 0, listedKg: 0, collections: 0, collectedKg: 0, preferredKg: 0, networkKg: 0 };
    const oneOffBucket = { listings: 0, listedKg: 0, collections: 0, collectedKg: 0 };
    for (const row of listingRows) {
      const target = row.via_connection ? connectionBucket : oneOffBucket;
      target.listings += num(row.listings);
      target.listedKg += num(row.listed_kg);
    }
    for (const row of claimRows) {
      const kg = num(row.kg);
      const count = num(row.collections);
      if (row.source === 'one_off') {
        oneOffBucket.collections += count;
        oneOffBucket.collectedKg += kg;
        continue;
      }
      connectionBucket.collections += count;
      connectionBucket.collectedKg += kg;
      if (row.source === 'preferred') connectionBucket.preferredKg += kg;
      else connectionBucket.networkKg += kg;
    }

    const outcome = new Map(dayRows.map((row) => [row.outcome, num(row.count)]));
    const days = {
      scheduled: [...outcome.values()].reduce((sum, count) => sum + count, 0),
      collected: outcome.get('COLLECTED') ?? 0,
      released: outcome.get('RELEASED') ?? 0,
      noSurplus: outcome.get('NO_SURPLUS') ?? 0,
      noResponse: outcome.get('NO_RESPONSE') ?? 0,
      missed: outcome.get('MISSED') ?? 0,
      open: (outcome.get('PROMPTED') ?? 0) + (outcome.get('PUBLISHED') ?? 0),
    };

    return {
      from,
      to,
      invitations: {
        sent,
        accepted,
        declined,
        pending: num(invitation?.pending),
        expired: num(invitation?.expired),
        acceptanceRate: answered > 0 ? Math.round((accepted / answered) * 100) : 0,
        averageResponseHours:
          invitation?.response_hours == null ? null : Math.round(num(invitation.response_hours) * 10) / 10,
      },
      current,
      impact: { connection: connectionBucket, oneOff: oneOffBucket },
      days,
      connections: connectionRows.map((row) => ({
        id: row.id,
        status: row.status,
        initiatedBy: row.initiated_by,
        createdAt: row.created_at.toISOString(),
        respondedAt: iso(row.responded_at),
        invitationExpiresAt: iso(row.invitation_expires_at),
        pausedAt: iso(row.paused_at),
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
        frequency: row.frequency,
        daysOfWeek: row.days_of_week ?? [],
        windowStartMinutes: num(row.window_start_minutes),
        windowEndMinutes: num(row.window_end_minutes),
        typicalSurplus: row.typical_surplus,
        typicalQuantity: row.typical_quantity,
        listings: num(row.listings),
        collections: num(row.collections),
        collectedKg: num(row.collected_kg),
      })),
    };
  }
}
