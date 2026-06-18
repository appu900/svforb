/*
  Warnings:

  - You are about to drop the column `claimedItems` on the `food_claims` table. All the data in the column will be lost.
  - You are about to drop the column `claimedQtyKg` on the `food_claims` table. All the data in the column will be lost.
  - You are about to drop the column `containsAllergens` on the `food_listings` table. All the data in the column will be lost.
  - You are about to drop the column `foodItems` on the `food_listings` table. All the data in the column will be lost.
  - You are about to drop the column `isGlutenFree` on the `food_listings` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "FoodListingType" AS ENUM ('HUMAN', 'ANIMAL', 'BOTH');

-- AlterTable
ALTER TABLE "food_claims" DROP COLUMN "claimedItems",
DROP COLUMN "claimedQtyKg";

-- AlterTable
ALTER TABLE "food_listings" DROP COLUMN "containsAllergens",
DROP COLUMN "foodItems",
DROP COLUMN "isGlutenFree",
ADD COLUMN     "allergens" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "listingType" "FoodListingType" NOT NULL DEFAULT 'HUMAN',
ADD COLUMN     "needsAmbient" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "needsFreezer" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "food_items" (
    "id" SERIAL NOT NULL,
    "listingId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "totalQtyKg" DOUBLE PRECISION NOT NULL,
    "remainingQtyKg" DOUBLE PRECISION NOT NULL,
    "unit" TEXT,
    "category" TEXT,

    CONSTRAINT "food_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claim_items" (
    "id" SERIAL NOT NULL,
    "claimId" INTEGER NOT NULL,
    "foodItemId" INTEGER NOT NULL,
    "qtyKg" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "claim_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "food_items_listingId_idx" ON "food_items"("listingId");

-- CreateIndex
CREATE INDEX "claim_items_claimId_idx" ON "claim_items"("claimId");

-- CreateIndex
CREATE INDEX "claim_items_foodItemId_idx" ON "claim_items"("foodItemId");

-- AddForeignKey
ALTER TABLE "food_items" ADD CONSTRAINT "food_items_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "food_listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_items" ADD CONSTRAINT "claim_items_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "food_claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_items" ADD CONSTRAINT "claim_items_foodItemId_fkey" FOREIGN KEY ("foodItemId") REFERENCES "food_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
