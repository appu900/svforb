-- CreateEnum
CREATE TYPE "TokenTargetApp" AS ENUM ('BUSINESS', 'DRIVER');

-- AlterTable
ALTER TABLE "device_tokens" ADD COLUMN "targetApp" "TokenTargetApp" NOT NULL DEFAULT 'BUSINESS';

-- Backfill: non-business app bundles belong to the driver app
UPDATE "device_tokens"
SET "targetApp" = 'DRIVER'
WHERE "appBundle" IS NOT NULL
  AND "appBundle" NOT IN (
    'com.saveful.business.app',
    'com.priteepriyadarshini.savefulbusiness'
  );

-- CreateIndex
CREATE INDEX "device_tokens_userId_isActive_targetApp_idx" ON "device_tokens"("userId", "isActive", "targetApp");
