-- CreateEnum
CREATE TYPE "ConsolidatedListingRole" AS ENUM ('STANDARD', 'CONTRIBUTION', 'MASTER');

-- CreateEnum
CREATE TYPE "ClaimKind" AS ENUM ('STANDARD', 'CONSOLIDATED_MASTER', 'CONSOLIDATED_ALLOCATION');

-- CreateEnum
CREATE TYPE "ConsolidatedMemberRole" AS ENUM ('MANAGER', 'RECEIVER');

-- CreateEnum
CREATE TYPE "ConsolidatedHandoverMethod" AS ENUM ('SITE_DROP_OFF', 'INTERNAL_COLLECTION');

-- CreateEnum
CREATE TYPE "ConsolidatedRecurrence" AS ENUM ('ONE_OFF', 'DAILY', 'WEEKLY', 'SELECTED_WEEKDAYS', 'CUSTOM_DATES');

-- CreateEnum
CREATE TYPE "ConsolidatedScheduleStatus" AS ENUM ('ACTIVE', 'ENDED');

-- CreateEnum
CREATE TYPE "ConsolidatedCollectionStatus" AS ENUM ('SCHEDULED', 'OPEN', 'SUBMISSIONS_CLOSED', 'PUBLISHED', 'CLAIMED', 'AWAITING_ITEM_CHECK', 'COMPLETED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ConsolidatedContributionStatus" AS ENUM ('SUBMITTED', 'LATE_PENDING_APPROVAL', 'REJECTED_LATE', 'WITHDRAWN', 'HANDED_OVER', 'RECEIVED', 'NOT_RECEIVED', 'EXCLUDED', 'NO_CONTRIBUTION', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ConsolidatedReceiptStatus" AS ENUM ('PENDING', 'RECEIVED', 'NOT_RECEIVED');

-- CreateEnum
CREATE TYPE "ConsolidatedItemOutcome" AS ENUM ('PENDING', 'ACCEPTED', 'PARTIALLY_ACCEPTED', 'REJECTED', 'UNAVAILABLE', 'NOT_RECEIVED', 'EXCLUDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ConsolidatedDeclarationType" AS ENUM ('SITE', 'MANAGER', 'CHARITY');

-- CreateEnum
CREATE TYPE "ConsolidatedRejectionReason" AS ENUM ('QUALITY', 'TEMPERATURE', 'PACKAGING_DAMAGED', 'PAST_DATE', 'NOT_AS_DESCRIBED', 'CANNOT_TRANSPORT', 'CANNOT_STORE', 'OTHER');

-- CreateEnum
CREATE TYPE "ConsolidatedChangeRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "AuditArea" ADD VALUE 'CONSOLIDATED_COLLECTIONS';

-- AlterTable
ALTER TABLE "org_membership" ADD COLUMN     "canManageConsolidated" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "food_listings" ADD COLUMN     "consolidatedRole" "ConsolidatedListingRole" NOT NULL DEFAULT 'STANDARD';

-- AlterTable
ALTER TABLE "food_items" ADD COLUMN     "quantityDescription" TEXT;

-- AlterTable
ALTER TABLE "food_claims" ADD COLUMN     "claimKind" "ClaimKind" NOT NULL DEFAULT 'STANDARD',
ADD COLUMN     "parentClaimId" INTEGER;

-- CreateTable
CREATE TABLE "consolidated_groups" (
    "id" SERIAL NOT NULL,
    "organisationId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "hostSiteId" INTEGER NOT NULL,
    "timezone" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "archivedAt" TIMESTAMP(3),
    "createdByUserId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "consolidated_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consolidated_collection_points" (
    "id" SERIAL NOT NULL,
    "groupId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "postcode" TEXT,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "directions" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "consolidated_collection_points_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consolidated_group_sites" (
    "id" SERIAL NOT NULL,
    "groupId" INTEGER NOT NULL,
    "siteId" INTEGER NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "addedBy" INTEGER NOT NULL,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "consolidated_group_sites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consolidated_group_members" (
    "id" SERIAL NOT NULL,
    "groupId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "role" "ConsolidatedMemberRole" NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "addedBy" INTEGER NOT NULL,

    CONSTRAINT "consolidated_group_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consolidated_schedules" (
    "id" SERIAL NOT NULL,
    "groupId" INTEGER NOT NULL,
    "collectionPointId" INTEGER NOT NULL,
    "method" "ConsolidatedHandoverMethod" NOT NULL,
    "recurrence" "ConsolidatedRecurrence" NOT NULL,
    "status" "ConsolidatedScheduleStatus" NOT NULL DEFAULT 'ACTIVE',
    "timezone" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "daysOfWeek" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "customDates" TIMESTAMP(3)[] DEFAULT ARRAY[]::TIMESTAMP(3)[],
    "opensDaysBefore" INTEGER NOT NULL DEFAULT 0,
    "submissionsCloseMinutes" INTEGER NOT NULL,
    "handoverStartMinutes" INTEGER NOT NULL,
    "handoverEndMinutes" INTEGER NOT NULL,
    "pickupStartMinutes" INTEGER NOT NULL,
    "pickupEndMinutes" INTEGER NOT NULL,
    "contactName" TEXT NOT NULL,
    "contactPhone" TEXT NOT NULL,
    "instructions" TEXT,
    "suitabilityNotes" TEXT NOT NULL,
    "participatingSiteIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "generatedUntil" TIMESTAMP(3),
    "createdByUserId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "consolidated_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consolidated_collections" (
    "id" SERIAL NOT NULL,
    "organisationId" INTEGER NOT NULL,
    "groupId" INTEGER NOT NULL,
    "scheduleId" INTEGER,
    "collectionPointId" INTEGER NOT NULL,
    "pointName" TEXT NOT NULL,
    "pointAddress" TEXT NOT NULL,
    "pointPostcode" TEXT,
    "pointLat" DOUBLE PRECISION NOT NULL,
    "pointLng" DOUBLE PRECISION NOT NULL,
    "pointDirections" TEXT,
    "method" "ConsolidatedHandoverMethod" NOT NULL,
    "status" "ConsolidatedCollectionStatus" NOT NULL DEFAULT 'SCHEDULED',
    "timezone" TEXT NOT NULL,
    "scheduledDate" TIMESTAMP(3) NOT NULL,
    "opensAt" TIMESTAMP(3) NOT NULL,
    "submissionsCloseAt" TIMESTAMP(3) NOT NULL,
    "reopenedUntil" TIMESTAMP(3),
    "handoverStartAt" TIMESTAMP(3) NOT NULL,
    "handoverEndAt" TIMESTAMP(3) NOT NULL,
    "pickupStartAt" TIMESTAMP(3) NOT NULL,
    "pickupEndAt" TIMESTAMP(3) NOT NULL,
    "contactName" TEXT NOT NULL,
    "contactPhone" TEXT NOT NULL,
    "instructions" TEXT,
    "suitabilityNotes" TEXT NOT NULL,
    "participatingSiteIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "isDetached" BOOLEAN NOT NULL DEFAULT false,
    "openedAt" TIMESTAMP(3),
    "closingReminderAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "overdueAlertAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "publishedByUserId" INTEGER,
    "masterListingId" INTEGER,
    "claimedAt" TIMESTAMP(3),
    "pickupReminderAt" TIMESTAMP(3),
    "itemCheckReminderAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelledByUserId" INTEGER,
    "cancelReason" TEXT,
    "expiredAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "consolidated_collections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consolidated_contributions" (
    "id" SERIAL NOT NULL,
    "collectionId" INTEGER NOT NULL,
    "siteId" INTEGER NOT NULL,
    "listingId" INTEGER,
    "status" "ConsolidatedContributionStatus" NOT NULL,
    "isLate" BOOLEAN NOT NULL DEFAULT false,
    "submittedAt" TIMESTAMP(3),
    "submittedByUserId" INTEGER,
    "lateDecidedAt" TIMESTAMP(3),
    "lateDecidedByUserId" INTEGER,
    "lateDecisionReason" TEXT,
    "withdrawnAt" TIMESTAMP(3),
    "withdrawReason" TEXT,
    "handoverAt" TIMESTAMP(3),
    "handoverByUserId" INTEGER,
    "receiptStatus" "ConsolidatedReceiptStatus" NOT NULL DEFAULT 'PENDING',
    "receiptAt" TIMESTAMP(3),
    "receiptByUserId" INTEGER,
    "receiptNote" TEXT,
    "excludedAt" TIMESTAMP(3),
    "excludedByUserId" INTEGER,
    "excludeReason" TEXT,
    "allocationClaimId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "consolidated_contributions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consolidated_items" (
    "id" SERIAL NOT NULL,
    "collectionId" INTEGER NOT NULL,
    "contributionId" INTEGER NOT NULL,
    "siteId" INTEGER NOT NULL,
    "sourceFoodItemId" INTEGER NOT NULL,
    "masterFoodItemId" INTEGER,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "submittedQtyKg" DOUBLE PRECISION NOT NULL,
    "verifiedQtyKg" DOUBLE PRECISION,
    "acceptedQtyKg" DOUBLE PRECISION,
    "rejectedQtyKg" DOUBLE PRECISION,
    "unavailableQtyKg" DOUBLE PRECISION,
    "rejectionReason" "ConsolidatedRejectionReason",
    "rejectionNote" TEXT,
    "outcome" "ConsolidatedItemOutcome" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "consolidated_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consolidated_declarations" (
    "id" SERIAL NOT NULL,
    "collectionId" INTEGER NOT NULL,
    "contributionId" INTEGER,
    "claimId" INTEGER,
    "type" "ConsolidatedDeclarationType" NOT NULL,
    "version" TEXT NOT NULL,
    "textSnapshot" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "organisationId" INTEGER NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "consolidated_declarations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consolidated_changes" (
    "id" SERIAL NOT NULL,
    "collectionId" INTEGER NOT NULL,
    "fromVersion" INTEGER NOT NULL,
    "toVersion" INTEGER NOT NULL,
    "isMaterial" BOOLEAN NOT NULL,
    "reasons" TEXT[],
    "summary" TEXT NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "createdByUserId" INTEGER NOT NULL,
    "notifiedAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consolidated_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consolidated_change_requests" (
    "id" SERIAL NOT NULL,
    "contributionId" INTEGER NOT NULL,
    "collectionId" INTEGER NOT NULL,
    "requestedByUserId" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "ConsolidatedChangeRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decidedByUserId" INTEGER,
    "decidedAt" TIMESTAMP(3),
    "decisionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consolidated_change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "consolidated_groups_organisationId_isActive_idx" ON "consolidated_groups"("organisationId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "consolidated_groups_organisationId_name_key" ON "consolidated_groups"("organisationId", "name");

-- CreateIndex
CREATE INDEX "consolidated_collection_points_groupId_idx" ON "consolidated_collection_points"("groupId");

-- CreateIndex
CREATE INDEX "consolidated_group_sites_siteId_idx" ON "consolidated_group_sites"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "consolidated_group_sites_groupId_siteId_key" ON "consolidated_group_sites"("groupId", "siteId");

-- CreateIndex
CREATE INDEX "consolidated_group_members_userId_idx" ON "consolidated_group_members"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "consolidated_group_members_groupId_userId_role_key" ON "consolidated_group_members"("groupId", "userId", "role");

-- CreateIndex
CREATE INDEX "consolidated_schedules_groupId_status_idx" ON "consolidated_schedules"("groupId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "consolidated_collections_masterListingId_key" ON "consolidated_collections"("masterListingId");

-- CreateIndex
CREATE INDEX "consolidated_collections_organisationId_status_idx" ON "consolidated_collections"("organisationId", "status");

-- CreateIndex
CREATE INDEX "consolidated_collections_groupId_scheduledDate_idx" ON "consolidated_collections"("groupId", "scheduledDate");

-- CreateIndex
CREATE INDEX "consolidated_collections_status_opensAt_idx" ON "consolidated_collections"("status", "opensAt");

-- CreateIndex
CREATE INDEX "consolidated_collections_status_submissionsCloseAt_idx" ON "consolidated_collections"("status", "submissionsCloseAt");

-- CreateIndex
CREATE INDEX "consolidated_collections_status_pickupEndAt_idx" ON "consolidated_collections"("status", "pickupEndAt");

-- CreateIndex
CREATE UNIQUE INDEX "consolidated_collections_scheduleId_scheduledDate_key" ON "consolidated_collections"("scheduleId", "scheduledDate");

-- CreateIndex
CREATE UNIQUE INDEX "consolidated_contributions_listingId_key" ON "consolidated_contributions"("listingId");

-- CreateIndex
CREATE UNIQUE INDEX "consolidated_contributions_allocationClaimId_key" ON "consolidated_contributions"("allocationClaimId");

-- CreateIndex
CREATE INDEX "consolidated_contributions_siteId_idx" ON "consolidated_contributions"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "consolidated_contributions_collectionId_siteId_key" ON "consolidated_contributions"("collectionId", "siteId");

-- CreateIndex
CREATE UNIQUE INDEX "consolidated_items_sourceFoodItemId_key" ON "consolidated_items"("sourceFoodItemId");

-- CreateIndex
CREATE UNIQUE INDEX "consolidated_items_masterFoodItemId_key" ON "consolidated_items"("masterFoodItemId");

-- CreateIndex
CREATE INDEX "consolidated_items_collectionId_idx" ON "consolidated_items"("collectionId");

-- CreateIndex
CREATE INDEX "consolidated_items_contributionId_idx" ON "consolidated_items"("contributionId");

-- CreateIndex
CREATE INDEX "consolidated_items_siteId_idx" ON "consolidated_items"("siteId");

-- CreateIndex
CREATE INDEX "consolidated_declarations_collectionId_type_idx" ON "consolidated_declarations"("collectionId", "type");

-- CreateIndex
CREATE INDEX "consolidated_changes_collectionId_idx" ON "consolidated_changes"("collectionId");

-- CreateIndex
CREATE INDEX "consolidated_change_requests_collectionId_status_idx" ON "consolidated_change_requests"("collectionId", "status");

-- CreateIndex
CREATE INDEX "food_listings_consolidatedRole_idx" ON "food_listings"("consolidatedRole");

-- CreateIndex
CREATE INDEX "food_claims_claimKind_idx" ON "food_claims"("claimKind");

-- CreateIndex
CREATE INDEX "food_claims_parentClaimId_idx" ON "food_claims"("parentClaimId");

-- AddForeignKey
ALTER TABLE "food_claims" ADD CONSTRAINT "food_claims_parentClaimId_fkey" FOREIGN KEY ("parentClaimId") REFERENCES "food_claims"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consolidated_groups" ADD CONSTRAINT "consolidated_groups_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consolidated_groups" ADD CONSTRAINT "consolidated_groups_hostSiteId_fkey" FOREIGN KEY ("hostSiteId") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consolidated_collection_points" ADD CONSTRAINT "consolidated_collection_points_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "consolidated_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consolidated_group_sites" ADD CONSTRAINT "consolidated_group_sites_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "consolidated_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consolidated_group_sites" ADD CONSTRAINT "consolidated_group_sites_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consolidated_group_members" ADD CONSTRAINT "consolidated_group_members_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "consolidated_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consolidated_group_members" ADD CONSTRAINT "consolidated_group_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consolidated_schedules" ADD CONSTRAINT "consolidated_schedules_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "consolidated_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consolidated_collections" ADD CONSTRAINT "consolidated_collections_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "consolidated_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consolidated_collections" ADD CONSTRAINT "consolidated_collections_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "consolidated_schedules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consolidated_collections" ADD CONSTRAINT "consolidated_collections_masterListingId_fkey" FOREIGN KEY ("masterListingId") REFERENCES "food_listings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consolidated_contributions" ADD CONSTRAINT "consolidated_contributions_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "consolidated_collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consolidated_contributions" ADD CONSTRAINT "consolidated_contributions_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consolidated_contributions" ADD CONSTRAINT "consolidated_contributions_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "food_listings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consolidated_items" ADD CONSTRAINT "consolidated_items_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "consolidated_collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consolidated_items" ADD CONSTRAINT "consolidated_items_sourceFoodItemId_fkey" FOREIGN KEY ("sourceFoodItemId") REFERENCES "food_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consolidated_items" ADD CONSTRAINT "consolidated_items_masterFoodItemId_fkey" FOREIGN KEY ("masterFoodItemId") REFERENCES "food_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consolidated_declarations" ADD CONSTRAINT "consolidated_declarations_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "consolidated_collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consolidated_changes" ADD CONSTRAINT "consolidated_changes_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "consolidated_collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consolidated_change_requests" ADD CONSTRAINT "consolidated_change_requests_contributionId_fkey" FOREIGN KEY ("contributionId") REFERENCES "consolidated_contributions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

