-- CreateEnum
CREATE TYPE "FoodSource" AS ENUM ('OVERPRODUCTION', 'SPOILAGE', 'PREPARATION', 'PLATE_SCRAPS');

-- CreateEnum
CREATE TYPE "FoodRecordStatus" AS ENUM ('DRAFT', 'SAVED');

-- CreateEnum
CREATE TYPE "FoodListingKind" AS ENUM ('EDIBLE', 'NON_EDIBLE');

-- CreateEnum
CREATE TYPE "FoodRecordEventType" AS ENUM ('RECORD_CREATED', 'RECORD_SAVED', 'SOURCES_CHANGED', 'LINE_CREATED', 'QTY_CHANGED', 'FIT_CHANGED', 'LINE_DELETED', 'LISTED', 'LISTING_CANCELLED', 'CLAIM_COLLECTED', 'CLAIM_CANCELLED');

-- AlterEnum
ALTER TYPE "AuditArea" ADD VALUE 'MAKE_FOOD_COUNT';

-- CreateTable
CREATE TABLE "food_records" (
    "id" SERIAL NOT NULL,
    "organisationId" INTEGER NOT NULL,
    "siteId" INTEGER NOT NULL,
    "createdById" INTEGER NOT NULL,
    "updatedById" INTEGER NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "FoodRecordStatus" NOT NULL DEFAULT 'DRAFT',
    "sources" "FoodSource"[],
    "version" INTEGER NOT NULL DEFAULT 1,
    "clientRequestId" TEXT NOT NULL,
    "snapshotGroupId" INTEGER,
    "snapshotClusterId" INTEGER,
    "snapshotTerritoryId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_record_lines" (
    "id" SERIAL NOT NULL,
    "recordId" INTEGER NOT NULL,
    "clientKey" TEXT NOT NULL,
    "source" "FoodSource" NOT NULL,
    "category" TEXT NOT NULL,
    "subtype" TEXT,
    "qtyKg" DECIMAL(10,2) NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'kg',
    "fitForHumans" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_record_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_record_events" (
    "id" SERIAL NOT NULL,
    "recordId" INTEGER NOT NULL,
    "lineId" INTEGER,
    "actorUserId" INTEGER,
    "type" "FoodRecordEventType" NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "food_record_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_record_listing_links" (
    "id" SERIAL NOT NULL,
    "recordId" INTEGER NOT NULL,
    "lineId" INTEGER NOT NULL,
    "listingId" INTEGER NOT NULL,
    "foodItemId" INTEGER NOT NULL,
    "kind" "FoodListingKind" NOT NULL,
    "listedQtyKg" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "food_record_listing_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "key" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "scope" TEXT NOT NULL,
    "resultId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "food_records_clientRequestId_key" ON "food_records"("clientRequestId");

-- CreateIndex
CREATE INDEX "food_records_organisationId_recordedAt_idx" ON "food_records"("organisationId", "recordedAt");

-- CreateIndex
CREATE INDEX "food_records_siteId_recordedAt_idx" ON "food_records"("siteId", "recordedAt");

-- CreateIndex
CREATE INDEX "food_records_snapshotGroupId_idx" ON "food_records"("snapshotGroupId");

-- CreateIndex
CREATE INDEX "food_records_snapshotClusterId_idx" ON "food_records"("snapshotClusterId");

-- CreateIndex
CREATE INDEX "food_records_snapshotTerritoryId_idx" ON "food_records"("snapshotTerritoryId");

-- CreateIndex
CREATE INDEX "food_record_lines_recordId_source_idx" ON "food_record_lines"("recordId", "source");

-- CreateIndex
CREATE UNIQUE INDEX "food_record_lines_recordId_clientKey_key" ON "food_record_lines"("recordId", "clientKey");

-- CreateIndex
CREATE INDEX "food_record_events_recordId_createdAt_idx" ON "food_record_events"("recordId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "food_record_listing_links_foodItemId_key" ON "food_record_listing_links"("foodItemId");

-- CreateIndex
CREATE INDEX "food_record_listing_links_lineId_idx" ON "food_record_listing_links"("lineId");

-- CreateIndex
CREATE INDEX "food_record_listing_links_listingId_idx" ON "food_record_listing_links"("listingId");

-- CreateIndex
CREATE INDEX "food_record_listing_links_recordId_idx" ON "food_record_listing_links"("recordId");

-- CreateIndex
CREATE INDEX "idempotency_keys_createdAt_idx" ON "idempotency_keys"("createdAt");

-- AddForeignKey
ALTER TABLE "food_records" ADD CONSTRAINT "food_records_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_records" ADD CONSTRAINT "food_records_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_records" ADD CONSTRAINT "food_records_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_records" ADD CONSTRAINT "food_records_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_record_lines" ADD CONSTRAINT "food_record_lines_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "food_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_record_events" ADD CONSTRAINT "food_record_events_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "food_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_record_events" ADD CONSTRAINT "food_record_events_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "food_record_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_record_events" ADD CONSTRAINT "food_record_events_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_record_listing_links" ADD CONSTRAINT "food_record_listing_links_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "food_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_record_listing_links" ADD CONSTRAINT "food_record_listing_links_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "food_record_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_record_listing_links" ADD CONSTRAINT "food_record_listing_links_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "food_listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_record_listing_links" ADD CONSTRAINT "food_record_listing_links_foodItemId_fkey" FOREIGN KEY ("foodItemId") REFERENCES "food_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

