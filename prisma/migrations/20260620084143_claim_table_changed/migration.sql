/*
  Warnings:

  - You are about to drop the column `charityOrgId` on the `food_claims` table. All the data in the column will be lost.
  - You are about to drop the column `isFullClaim` on the `food_claims` table. All the data in the column will be lost.
  - You are about to drop the column `uniqueCharityCount` on the `food_listings` table. All the data in the column will be lost.
  - Added the required column `claimantOrgId` to the `food_claims` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "ClaimMode" AS ENUM ('FULL', 'PARTIAL');

-- DropForeignKey
ALTER TABLE "food_claims" DROP CONSTRAINT "food_claims_charityOrgId_fkey";

-- DropIndex
DROP INDEX "food_claims_charityOrgId_idx";

-- AlterTable
ALTER TABLE "food_claims" DROP COLUMN "charityOrgId",
DROP COLUMN "isFullClaim",
ADD COLUMN     "claimMode" "ClaimMode" NOT NULL DEFAULT 'PARTIAL',
ADD COLUMN     "claimantOrgId" INTEGER NOT NULL,
ADD COLUMN     "confirmedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "food_listings" DROP COLUMN "uniqueCharityCount",
ADD COLUMN     "uniqueClaimantCount" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "food_claims_claimantOrgId_idx" ON "food_claims"("claimantOrgId");

-- AddForeignKey
ALTER TABLE "food_claims" ADD CONSTRAINT "food_claims_claimantOrgId_fkey" FOREIGN KEY ("claimantOrgId") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
