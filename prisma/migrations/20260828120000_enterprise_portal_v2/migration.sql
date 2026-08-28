-- CreateEnum
CREATE TYPE "RecoveryPathway" AS ENUM ('FOOD_FOR_PEOPLE', 'LIVESTOCK_FEED', 'CIRCULAR_RECOVERY', 'BIOENERGY');

-- CreateEnum
CREATE TYPE "MeasurementUnit" AS ENUM ('METRIC', 'IMPERIAL');

-- CreateEnum
CREATE TYPE "EnterpriseAccountStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "AuditArea" AS ENUM ('SITES', 'USERS', 'ORGANISATION_STRUCTURE', 'ENTERPRISE_SETTINGS', 'NOTIFICATIONS', 'AUTH');

-- CreateEnum
CREATE TYPE "ReportFormat" AS ENUM ('PDF', 'EXCEL');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'NO_DATA');

-- CreateEnum
CREATE TYPE "SiteImportStatus" AS ENUM ('VALIDATING', 'AWAITING_CONFIRMATION', 'IMPORTING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SiteImportRowStatus" AS ENUM ('READY', 'NEEDS_ATTENTION', 'IMPORTED', 'SKIPPED');

-- AlterEnum
ALTER TYPE "EnterpriseRole" ADD VALUE 'ENTERPRISE_ADMIN';

-- DropForeignKey
ALTER TABLE "clusters" DROP CONSTRAINT "clusters_groupId_fkey";

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "termsAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "termsVersion" TEXT,
ADD COLUMN     "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "twoFactorSecret" TEXT;

-- AlterTable
ALTER TABLE "sites" ADD COLUMN     "activatedAt" TIMESTAMP(3),
ADD COLUMN     "collectionDays" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "collectionEndTime" TEXT,
ADD COLUMN     "collectionInstructions" TEXT,
ADD COLUMN     "collectionStartTime" TEXT,
ADD COLUMN     "deactivatedAt" TIMESTAMP(3),
ADD COLUMN     "lastActivityAt" TIMESTAMP(3),
ADD COLUMN     "name" TEXT,
ADD COLUMN     "siteCode" TEXT;

-- AlterTable
ALTER TABLE "food_listings" ADD COLUMN     "recoveryPathway" "RecoveryPathway";

-- AlterTable
ALTER TABLE "food_claims" ADD COLUMN     "recoveryPathway" "RecoveryPathway";

-- AlterTable
ALTER TABLE "enterprise_groups" ADD COLUMN     "deactivatedAt" TIMESTAMP(3),
ADD COLUMN     "description" TEXT;

-- AlterTable
ALTER TABLE "clusters" ADD COLUMN     "deactivatedAt" TIMESTAMP(3),
ADD COLUMN     "description" TEXT,
ALTER COLUMN "groupId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "territories" ADD COLUMN     "deactivatedAt" TIMESTAMP(3),
ADD COLUMN     "description" TEXT;

-- CreateTable
CREATE TABLE "group_sites" (
    "id" SERIAL NOT NULL,
    "groupId" INTEGER NOT NULL,
    "siteId" INTEGER NOT NULL,
    "organisationId" INTEGER NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedBy" INTEGER NOT NULL,

    CONSTRAINT "group_sites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enterprise_profiles" (
    "id" SERIAL NOT NULL,
    "organisationId" INTEGER NOT NULL,
    "enterpriseId" TEXT NOT NULL,
    "accountStatus" "EnterpriseAccountStatus" NOT NULL DEFAULT 'PENDING',
    "country" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'AUD',
    "measurementUnit" "MeasurementUnit" NOT NULL DEFAULT 'METRIC',
    "primaryContactName" TEXT,
    "primaryContactEmail" TEXT,
    "primaryContactPhone" TEXT,
    "logoUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "enterprise_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enterprise_invitations" (
    "id" SERIAL NOT NULL,
    "organisationId" INTEGER NOT NULL,
    "email" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "mobile" TEXT,
    "enterpriseRole" "EnterpriseRole" NOT NULL,
    "siteAdminForSiteId" INTEGER,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "invitedBy" INTEGER NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "acceptedUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "enterprise_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enterprise_invitation_scopes" (
    "id" SERIAL NOT NULL,
    "invitationId" INTEGER NOT NULL,
    "scopeType" "ScopeType" NOT NULL,
    "scopeId" INTEGER,

    CONSTRAINT "enterprise_invitation_scopes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" SERIAL NOT NULL,
    "organisationId" INTEGER NOT NULL,
    "actorUserId" INTEGER,
    "actorName" TEXT NOT NULL,
    "actorEmail" TEXT NOT NULL,
    "area" "AuditArea" NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" INTEGER,
    "entityLabel" TEXT,
    "previousValue" JSONB,
    "newValue" JSONB,
    "summary" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enterprise_notification_settings" (
    "id" SERIAL NOT NULL,
    "organisationId" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "thresholdDays" INTEGER,
    "renotifyAfterDays" INTEGER DEFAULT 7,
    "updatedBy" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "enterprise_notification_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_notification_preferences" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "organisationId" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_alert_states" (
    "id" SERIAL NOT NULL,
    "siteId" INTEGER NOT NULL,
    "alertKey" TEXT NOT NULL,
    "firstDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastNotifiedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "site_alert_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enterprise_reports" (
    "id" SERIAL NOT NULL,
    "organisationId" INTEGER NOT NULL,
    "requestedBy" INTEGER NOT NULL,
    "scopeType" "ScopeType" NOT NULL,
    "scopeIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "sections" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "format" "ReportFormat" NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'QUEUED',
    "fileUrl" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "enterprise_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_import_jobs" (
    "id" SERIAL NOT NULL,
    "organisationId" INTEGER NOT NULL,
    "uploadedBy" INTEGER NOT NULL,
    "fileName" TEXT NOT NULL,
    "status" "SiteImportStatus" NOT NULL DEFAULT 'VALIDATING',
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "readyRows" INTEGER NOT NULL DEFAULT 0,
    "errorRows" INTEGER NOT NULL DEFAULT 0,
    "importedRows" INTEGER NOT NULL DEFAULT 0,
    "invitationRows" INTEGER NOT NULL DEFAULT 0,
    "errorFileUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "importedAt" TIMESTAMP(3),

    CONSTRAINT "site_import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_import_rows" (
    "id" SERIAL NOT NULL,
    "jobId" INTEGER NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "status" "SiteImportRowStatus" NOT NULL DEFAULT 'NEEDS_ATTENTION',
    "rawData" JSONB NOT NULL,
    "issues" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "siteId" INTEGER,

    CONSTRAINT "site_import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "impact_factors" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "pathway" "RecoveryPathway",
    "value" DOUBLE PRECISION NOT NULL,
    "unit" TEXT,
    "notes" TEXT,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "impact_factors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "group_sites_siteId_key" ON "group_sites"("siteId");

-- CreateIndex
CREATE INDEX "group_sites_groupId_idx" ON "group_sites"("groupId");

-- CreateIndex
CREATE INDEX "group_sites_organisationId_idx" ON "group_sites"("organisationId");

-- CreateIndex
CREATE UNIQUE INDEX "enterprise_profiles_organisationId_key" ON "enterprise_profiles"("organisationId");

-- CreateIndex
CREATE UNIQUE INDEX "enterprise_profiles_enterpriseId_key" ON "enterprise_profiles"("enterpriseId");

-- CreateIndex
CREATE UNIQUE INDEX "enterprise_invitations_tokenHash_key" ON "enterprise_invitations"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "enterprise_invitations_acceptedUserId_key" ON "enterprise_invitations"("acceptedUserId");

-- CreateIndex
CREATE INDEX "enterprise_invitations_organisationId_status_idx" ON "enterprise_invitations"("organisationId", "status");

-- CreateIndex
CREATE INDEX "enterprise_invitations_email_idx" ON "enterprise_invitations"("email");

-- CreateIndex
CREATE INDEX "enterprise_invitations_status_expiresAt_idx" ON "enterprise_invitations"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "enterprise_invitation_scopes_invitationId_idx" ON "enterprise_invitation_scopes"("invitationId");

-- CreateIndex
CREATE UNIQUE INDEX "enterprise_invitation_scopes_invitationId_scopeType_scopeId_key" ON "enterprise_invitation_scopes"("invitationId", "scopeType", "scopeId");

-- CreateIndex
CREATE INDEX "audit_logs_organisationId_createdAt_idx" ON "audit_logs"("organisationId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_organisationId_area_createdAt_idx" ON "audit_logs"("organisationId", "area", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_actorUserId_idx" ON "audit_logs"("actorUserId");

-- CreateIndex
CREATE UNIQUE INDEX "enterprise_notification_settings_organisationId_key_key" ON "enterprise_notification_settings"("organisationId", "key");

-- CreateIndex
CREATE INDEX "user_notification_preferences_organisationId_key_idx" ON "user_notification_preferences"("organisationId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "user_notification_preferences_userId_organisationId_key_key" ON "user_notification_preferences"("userId", "organisationId", "key");

-- CreateIndex
CREATE INDEX "site_alert_states_alertKey_resolvedAt_idx" ON "site_alert_states"("alertKey", "resolvedAt");

-- CreateIndex
CREATE UNIQUE INDEX "site_alert_states_siteId_alertKey_key" ON "site_alert_states"("siteId", "alertKey");

-- CreateIndex
CREATE INDEX "enterprise_reports_organisationId_createdAt_idx" ON "enterprise_reports"("organisationId", "createdAt");

-- CreateIndex
CREATE INDEX "enterprise_reports_status_idx" ON "enterprise_reports"("status");

-- CreateIndex
CREATE INDEX "site_import_jobs_organisationId_createdAt_idx" ON "site_import_jobs"("organisationId", "createdAt");

-- CreateIndex
CREATE INDEX "site_import_rows_jobId_status_idx" ON "site_import_rows"("jobId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "site_import_rows_jobId_rowNumber_key" ON "site_import_rows"("jobId", "rowNumber");

-- CreateIndex
CREATE INDEX "impact_factors_key_effectiveFrom_idx" ON "impact_factors"("key", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "impact_factors_key_pathway_effectiveFrom_key" ON "impact_factors"("key", "pathway", "effectiveFrom");

-- CreateIndex
CREATE INDEX "sites_organisationId_isActive_idx" ON "sites"("organisationId", "isActive");

-- CreateIndex
CREATE INDEX "sites_lastActivityAt_idx" ON "sites"("lastActivityAt");

-- CreateIndex
CREATE UNIQUE INDEX "sites_organisationId_siteCode_key" ON "sites"("organisationId", "siteCode");

-- AddForeignKey
ALTER TABLE "clusters" ADD CONSTRAINT "clusters_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "enterprise_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_sites" ADD CONSTRAINT "group_sites_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "enterprise_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_sites" ADD CONSTRAINT "group_sites_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_sites" ADD CONSTRAINT "group_sites_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enterprise_profiles" ADD CONSTRAINT "enterprise_profiles_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enterprise_invitations" ADD CONSTRAINT "enterprise_invitations_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enterprise_invitations" ADD CONSTRAINT "enterprise_invitations_invitedBy_fkey" FOREIGN KEY ("invitedBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enterprise_invitations" ADD CONSTRAINT "enterprise_invitations_acceptedUserId_fkey" FOREIGN KEY ("acceptedUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enterprise_invitation_scopes" ADD CONSTRAINT "enterprise_invitation_scopes_invitationId_fkey" FOREIGN KEY ("invitationId") REFERENCES "enterprise_invitations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enterprise_notification_settings" ADD CONSTRAINT "enterprise_notification_settings_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_notification_preferences" ADD CONSTRAINT "user_notification_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_notification_preferences" ADD CONSTRAINT "user_notification_preferences_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_alert_states" ADD CONSTRAINT "site_alert_states_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enterprise_reports" ADD CONSTRAINT "enterprise_reports_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enterprise_reports" ADD CONSTRAINT "enterprise_reports_requestedBy_fkey" FOREIGN KEY ("requestedBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_import_jobs" ADD CONSTRAINT "site_import_jobs_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_import_jobs" ADD CONSTRAINT "site_import_jobs_uploadedBy_fkey" FOREIGN KEY ("uploadedBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_import_rows" ADD CONSTRAINT "site_import_rows_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "site_import_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_import_rows" ADD CONSTRAINT "site_import_rows_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ═════════════════════════════════════════════════════════════════════════════
-- DATA BACKFILL
--
-- The schema changes above are structural. Everything below preserves data that
-- would otherwise be silently lost or left blank by the restructure.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── 1. Preserve group assignments ────────────────────────────────────────────
-- Group membership used to be implied by Cluster.groupId. Now that Group is its
-- own dimension, that link has to be materialised into group_sites or every
-- existing site loses its group the moment the code stops reading groupId.
INSERT INTO "group_sites" ("groupId", "siteId", "organisationId", "assignedAt", "assignedBy")
SELECT c."groupId", cs."siteId", c."organisationId", cs."assignedAt", cs."assignedBy"
FROM "cluster_sites" cs
JOIN "clusters" c ON c."id" = cs."clusterId"
WHERE c."groupId" IS NOT NULL
ON CONFLICT ("siteId") DO NOTHING;

-- ── 2. Site name ─────────────────────────────────────────────────────────────
-- organisationName has been doing double duty as the site name.
UPDATE "sites" SET "name" = "organisationName" WHERE "name" IS NULL;

-- ── 3. Site lifecycle dates ──────────────────────────────────────────────────
-- Site Status is Active/Deactivated and set by an administrator; an existing
-- active site counts as activated when it was created.
UPDATE "sites" SET "activatedAt" = "createdAt" WHERE "isActive" = true AND "activatedAt" IS NULL;
UPDATE "sites" SET "deactivatedAt" = "updatedAt" WHERE "isActive" = false AND "deactivatedAt" IS NULL;

-- Denormalised last-activity, so existing sites do not all read "Never used".
-- Qualifying activity is listing creation or progression — not login.
UPDATE "sites" s
SET "lastActivityAt" = a."last_at"
FROM (
  SELECT "siteId", MAX("createdAt") AS "last_at"
  FROM "food_listings"
  GROUP BY "siteId"
) a
WHERE a."siteId" = s."id" AND s."lastActivityAt" IS NULL;

-- ── 4. Recovery pathways ─────────────────────────────────────────────────────
-- The old two-way split maps onto the first two of the four pathways. BOTH is
-- treated as food for people, which is its primary intent.
UPDATE "food_listings" SET "recoveryPathway" = 'FOOD_FOR_PEOPLE'
WHERE "recoveryPathway" IS NULL AND "listingType" IN ('HUMAN', 'BOTH');

UPDATE "food_listings" SET "recoveryPathway" = 'LIVESTOCK_FEED'
WHERE "recoveryPathway" IS NULL AND "listingType" = 'ANIMAL';

-- A collection inherits its listing's pathway until one is recorded against the
-- collection itself.
UPDATE "food_claims" c
SET "recoveryPathway" = l."recoveryPathway"
FROM "food_listings" l
WHERE c."listingId" = l."id" AND c."recoveryPathway" IS NULL;

-- ── 5. Impact methodology ────────────────────────────────────────────────────
-- Seeds the conversion factors the app has been using as constants, so every
-- screen reads them from one versioned place. Later revisions are added as new
-- rows with a later effectiveFrom, never by editing these.
INSERT INTO "impact_factors" ("key", "pathway", "value", "unit", "notes", "effectiveFrom")
VALUES
  ('meals_per_kg',    'FOOD_FOR_PEOPLE', 2.3809523809523810, 'meals/kg', 'Average meal weight 0.42 kg', '2020-01-01T00:00:00Z'),
  ('co2e_kg_per_kg',  NULL,              2.1,                'kgCO2e/kg', 'Avoided landfill/incineration emissions', '2020-01-01T00:00:00Z'),
  ('value_per_kg',    'FOOD_FOR_PEOPLE', 14.64,              'per kg',    'Estimated market value of rescued food', '2020-01-01T00:00:00Z'),
  ('value_per_kg',    'LIVESTOCK_FEED',  1.20,               'per kg',    'Placeholder — confirm with Saveful', '2020-01-01T00:00:00Z'),
  ('value_per_kg',    'CIRCULAR_RECOVERY', 0.80,             'per kg',    'Placeholder — confirm with Saveful', '2020-01-01T00:00:00Z'),
  ('value_per_kg',    'BIOENERGY',       0.40,               'per kg',    'Placeholder — confirm with Saveful', '2020-01-01T00:00:00Z')
ON CONFLICT ("key", "pathway", "effectiveFrom") DO NOTHING;
