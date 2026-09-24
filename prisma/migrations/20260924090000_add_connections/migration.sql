-- Preferred Charity / Connections.
--
-- Additive only: creates new enums, two new tables and nullable columns on
-- existing tables. No column is dropped, renamed or retyped, and no row is
-- modified, so this is safe to apply to a live database.

-- ─── Enums ───────────────────────────────────────────────────────────────────
CREATE TYPE "ConnectionStatus"     AS ENUM ('PENDING','ACTIVE','PAUSED','DECLINED','EXPIRED','ENDED');
CREATE TYPE "ConnectionInitiator"  AS ENUM ('BUSINESS','CHARITY');
CREATE TYPE "ConnectionFrequency"  AS ENUM ('DAILY','WEEKLY','SELECT_DAYS');
CREATE TYPE "ListingReleaseReason" AS ENUM ('CHARITY_DECLINED','BUSINESS_RELEASED','AUTO_RELEASED','PARTIAL_REMAINDER');
CREATE TYPE "ConnectionDayOutcome" AS ENUM ('PROMPTED','PUBLISHED','NO_SURPLUS','COLLECTED','RELEASED','MISSED');

-- ─── Site: local timezone ────────────────────────────────────────────────────
-- Nullable: existing sites have no zone until backfilled, and the scheduler
-- refuses to guess rather than firing a prompt at the wrong hour.
ALTER TABLE "sites" ADD COLUMN "timezone" TEXT;

-- ─── Connections ─────────────────────────────────────────────────────────────
CREATE TABLE "connections" (
    "id"                  SERIAL PRIMARY KEY,
    "donorSiteId"         INTEGER NOT NULL,
    "donorOrgId"          INTEGER NOT NULL,
    "receiverSiteId"      INTEGER NOT NULL,
    "receiverOrgId"       INTEGER NOT NULL,
    "status"              "ConnectionStatus"    NOT NULL DEFAULT 'PENDING',
    "initiatedBy"         "ConnectionInitiator" NOT NULL DEFAULT 'BUSINESS',
    "frequency"           "ConnectionFrequency" NOT NULL DEFAULT 'SELECT_DAYS',
    "daysOfWeek"          INTEGER[],
    "windowStartMinutes"  INTEGER NOT NULL,
    "windowEndMinutes"    INTEGER NOT NULL,
    "leadTimeMinutes"     INTEGER NOT NULL DEFAULT 60,
    "cutoffMinutes"       INTEGER NOT NULL DEFAULT 30,
    "typicalSurplus"      TEXT,
    "notes"               TEXT,
    "invitedByUserId"     INTEGER,
    "respondedByUserId"   INTEGER,
    "respondedAt"         TIMESTAMP(3),
    "pausedAt"            TIMESTAMP(3),
    "endedAt"             TIMESTAMP(3),
    "endedByUserId"       INTEGER,
    "invitationExpiresAt" TIMESTAMP(3),
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"           TIMESTAMP(3) NOT NULL
);

CREATE INDEX "connections_donorSiteId_status_idx"    ON "connections"("donorSiteId","status");
CREATE INDEX "connections_receiverSiteId_status_idx" ON "connections"("receiverSiteId","status");
CREATE INDEX "connections_donorOrgId_idx"            ON "connections"("donorOrgId");
CREATE INDEX "connections_receiverOrgId_idx"         ON "connections"("receiverOrgId");
CREATE INDEX "connections_status_idx"                ON "connections"("status");

ALTER TABLE "connections" ADD CONSTRAINT "connections_donorSiteId_fkey"
    FOREIGN KEY ("donorSiteId") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "connections" ADD CONSTRAINT "connections_donorOrgId_fkey"
    FOREIGN KEY ("donorOrgId") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "connections" ADD CONSTRAINT "connections_receiverSiteId_fkey"
    FOREIGN KEY ("receiverSiteId") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "connections" ADD CONSTRAINT "connections_receiverOrgId_fkey"
    FOREIGN KEY ("receiverOrgId") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Connection days ─────────────────────────────────────────────────────────
CREATE TABLE "connection_days" (
    "id"            SERIAL PRIMARY KEY,
    "connectionId"  INTEGER NOT NULL,
    "scheduledDate" TIMESTAMP(3) NOT NULL,
    "windowStartAt" TIMESTAMP(3) NOT NULL,
    "windowEndAt"   TIMESTAMP(3) NOT NULL,
    "cutoffAt"      TIMESTAMP(3) NOT NULL,
    "outcome"       "ConnectionDayOutcome" NOT NULL DEFAULT 'PROMPTED',
    "promptedAt"    TIMESTAMP(3),
    "publishedAt"   TIMESTAMP(3),
    "respondedAt"   TIMESTAMP(3),
    "releasedAt"    TIMESTAMP(3),
    "listingId"     INTEGER,
    "collectedKg"   DOUBLE PRECISION,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL
);

-- Stops the five-minute prompt sweep creating a second row for the same day.
CREATE UNIQUE INDEX "connection_days_connectionId_scheduledDate_key"
    ON "connection_days"("connectionId","scheduledDate");
CREATE INDEX "connection_days_outcome_cutoffAt_idx"      ON "connection_days"("outcome","cutoffAt");
CREATE INDEX "connection_days_outcome_windowStartAt_idx" ON "connection_days"("outcome","windowStartAt");

ALTER TABLE "connection_days" ADD CONSTRAINT "connection_days_connectionId_fkey"
    FOREIGN KEY ("connectionId") REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Listing exclusivity ─────────────────────────────────────────────────────
-- All nullable, so every existing listing stays an ordinary public listing.
ALTER TABLE "food_listings" ADD COLUMN "connectionId"      INTEGER;
ALTER TABLE "food_listings" ADD COLUMN "exclusiveToOrgId"  INTEGER;
ALTER TABLE "food_listings" ADD COLUMN "exclusiveToSiteId" INTEGER;
ALTER TABLE "food_listings" ADD COLUMN "exclusiveUntil"    TIMESTAMP(3);
ALTER TABLE "food_listings" ADD COLUMN "releasedAt"        TIMESTAMP(3);
ALTER TABLE "food_listings" ADD COLUMN "releasedReason"    "ListingReleaseReason";

CREATE INDEX "food_listings_connectionId_idx" ON "food_listings"("connectionId");
CREATE INDEX "food_listings_exclusiveToOrgId_releasedAt_idx"
    ON "food_listings"("exclusiveToOrgId","releasedAt");

ALTER TABLE "food_listings" ADD CONSTRAINT "food_listings_connectionId_fkey"
    FOREIGN KEY ("connectionId") REFERENCES "connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "food_listings" ADD CONSTRAINT "food_listings_exclusiveToOrgId_fkey"
    FOREIGN KEY ("exclusiveToOrgId") REFERENCES "organisations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
