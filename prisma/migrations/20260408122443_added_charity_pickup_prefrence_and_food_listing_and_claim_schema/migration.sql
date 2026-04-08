-- CreateEnum
CREATE TYPE "ListingStatus" AS ENUM ('ACTIVE', 'PARTIAL', 'CLAIMED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('PENDING', 'CONFIRMED', 'COLLECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "charity_pickup_prefs" (
    "id" SERIAL NOT NULL,
    "organisationId" INTEGER NOT NULL,
    "radiusKm" INTEGER NOT NULL DEFAULT 5,
    "postCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "charity_pickup_prefs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_listings" (
    "id" SERIAL NOT NULL,
    "siteId" INTEGER NOT NULL,
    "organisationId" INTEGER NOT NULL,
    "foodItems" JSONB NOT NULL,
    "totalQtyKg" DOUBLE PRECISION NOT NULL,
    "remainingQtyKg" DOUBLE PRECISION NOT NULL,
    "pickupAddress" TEXT NOT NULL,
    "pickupPostcode" TEXT,
    "pickupLat" DOUBLE PRECISION NOT NULL,
    "pickupLng" DOUBLE PRECISION NOT NULL,
    "bestBefore" TIMESTAMP(3) NOT NULL,
    "pickupFromTime" TIMESTAMP(3),
    "pickupByTime" TIMESTAMP(3),
    "needsRefrigeration" BOOLEAN NOT NULL DEFAULT false,
    "needsReheating" BOOLEAN NOT NULL DEFAULT false,
    "containsAllergens" BOOLEAN NOT NULL DEFAULT false,
    "isGlutenFree" BOOLEAN NOT NULL DEFAULT false,
    "isSafeForDonation" BOOLEAN NOT NULL DEFAULT true,
    "photoUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "ListingStatus" NOT NULL DEFAULT 'ACTIVE',
    "relistOfId" INTEGER,
    "uniqueCharityCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_listings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "food_claims" (
    "id" SERIAL NOT NULL,
    "listingId" INTEGER NOT NULL,
    "charityOrgId" INTEGER NOT NULL,
    "claimedItems" JSONB NOT NULL,
    "claimedQtyKg" DOUBLE PRECISION NOT NULL,
    "isFullClaim" BOOLEAN NOT NULL DEFAULT false,
    "status" "ClaimStatus" NOT NULL DEFAULT 'PENDING',
    "rating" INTEGER,
    "ratingNote" TEXT,
    "collectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "food_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "listing_activity" (
    "id" SERIAL NOT NULL,
    "listingId" INTEGER NOT NULL,
    "actorOrgId" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "qtyKg" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "listing_activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_charity_support" (
    "id" SERIAL NOT NULL,
    "restaurantOrgId" INTEGER NOT NULL,
    "charityOrgId" INTEGER NOT NULL,
    "firstClaimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastClaimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "totalClaimsCount" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "restaurant_charity_support_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "charity_pickup_prefs_organisationId_key" ON "charity_pickup_prefs"("organisationId");

-- CreateIndex
CREATE INDEX "food_listings_siteId_idx" ON "food_listings"("siteId");

-- CreateIndex
CREATE INDEX "food_listings_organisationId_idx" ON "food_listings"("organisationId");

-- CreateIndex
CREATE INDEX "food_listings_status_idx" ON "food_listings"("status");

-- CreateIndex
CREATE INDEX "food_listings_bestBefore_idx" ON "food_listings"("bestBefore");

-- CreateIndex
CREATE INDEX "food_listings_pickupPostcode_idx" ON "food_listings"("pickupPostcode");

-- CreateIndex
CREATE INDEX "food_claims_listingId_idx" ON "food_claims"("listingId");

-- CreateIndex
CREATE INDEX "food_claims_charityOrgId_idx" ON "food_claims"("charityOrgId");

-- CreateIndex
CREATE INDEX "food_claims_status_idx" ON "food_claims"("status");

-- CreateIndex
CREATE INDEX "listing_activity_listingId_idx" ON "listing_activity"("listingId");

-- CreateIndex
CREATE INDEX "listing_activity_actorOrgId_idx" ON "listing_activity"("actorOrgId");

-- CreateIndex
CREATE INDEX "listing_activity_createdAt_idx" ON "listing_activity"("createdAt");

-- CreateIndex
CREATE INDEX "restaurant_charity_support_restaurantOrgId_idx" ON "restaurant_charity_support"("restaurantOrgId");

-- CreateIndex
CREATE INDEX "restaurant_charity_support_charityOrgId_idx" ON "restaurant_charity_support"("charityOrgId");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_charity_support_restaurantOrgId_charityOrgId_key" ON "restaurant_charity_support"("restaurantOrgId", "charityOrgId");

-- AddForeignKey
ALTER TABLE "charity_pickup_prefs" ADD CONSTRAINT "charity_pickup_prefs_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_listings" ADD CONSTRAINT "food_listings_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_listings" ADD CONSTRAINT "food_listings_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_listings" ADD CONSTRAINT "food_listings_relistOfId_fkey" FOREIGN KEY ("relistOfId") REFERENCES "food_listings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_claims" ADD CONSTRAINT "food_claims_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "food_listings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_claims" ADD CONSTRAINT "food_claims_charityOrgId_fkey" FOREIGN KEY ("charityOrgId") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing_activity" ADD CONSTRAINT "listing_activity_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "food_listings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing_activity" ADD CONSTRAINT "listing_activity_actorOrgId_fkey" FOREIGN KEY ("actorOrgId") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_charity_support" ADD CONSTRAINT "restaurant_charity_support_restaurantOrgId_fkey" FOREIGN KEY ("restaurantOrgId") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_charity_support" ADD CONSTRAINT "restaurant_charity_support_charityOrgId_fkey" FOREIGN KEY ("charityOrgId") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
