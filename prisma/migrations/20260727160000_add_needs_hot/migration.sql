-- AlterTable
ALTER TABLE "food_listings" ADD COLUMN IF NOT EXISTS "needsHot" BOOLEAN NOT NULL DEFAULT false;
