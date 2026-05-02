-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OrgType" ADD VALUE 'CHARITY_SINGLE';
ALTER TYPE "OrgType" ADD VALUE 'CHARITY_MULTI';

-- AlterEnum
ALTER TYPE "SiteRole" ADD VALUE 'DRIVER';

-- AlterTable
ALTER TABLE "site_accesses" ADD COLUMN     "canClaimPickupsDirectly" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "sites" ADD COLUMN     "pickupRadiusKm" INTEGER;
