/*
  Warnings:

  - You are about to drop the column `location` on the `food_listings` table. All the data in the column will be lost.

*/
-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OrgType" ADD VALUE 'FARMER_PRODUCER';
ALTER TYPE "OrgType" ADD VALUE 'FARMER_CONSUMER';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "VenueType" ADD VALUE 'CATERER';
ALTER TYPE "VenueType" ADD VALUE 'FARM';

-- DropIndex
DROP INDEX "food_listings_location_gist_idx";

-- DropIndex
DROP INDEX "organisations_location_gist_idx";

-- DropIndex
DROP INDEX "sites_location_gist_idx";

-- AlterTable
ALTER TABLE "food_listings" DROP COLUMN "location";

-- CreateTable
CREATE TABLE "SiteAnalytics" (
    "id" SERIAL NOT NULL,
    "siteId" INTEGER NOT NULL,

    CONSTRAINT "SiteAnalytics_pkey" PRIMARY KEY ("id")
);
