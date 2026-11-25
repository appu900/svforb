-- Modular billing: every plan sells a module (Make Food Count, Saveful Connect,
-- or the Complete bundle of both) at a scope (single site, multi site, enterprise).
-- Existing plans default to CONNECT, which is what they always sold.

CREATE TYPE "BillingModule" AS ENUM ('MFC', 'CONNECT', 'COMPLETE');
CREATE TYPE "PlanScope" AS ENUM ('SINGLE', 'MULTI', 'ENTERPRISE');

ALTER TABLE "subscription_plans" ADD COLUMN "module" "BillingModule" NOT NULL DEFAULT 'CONNECT';
ALTER TABLE "subscription_plans" ADD COLUMN "scope" "PlanScope" NOT NULL DEFAULT 'SINGLE';
ALTER TABLE "subscription_plans" ADD COLUMN "trialDays" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "subscription_plans" ADD COLUMN "tagline" TEXT;
ALTER TABLE "subscription_plans" ADD COLUMN "closingLine" TEXT;
ALTER TABLE "subscription_plans" ADD COLUMN "badge" TEXT;

-- Legacy tiers keep the 30-day trial they always had, and the right scope.
UPDATE "subscription_plans" SET "trialDays" = 30;
UPDATE "subscription_plans" SET "scope" = 'MULTI' WHERE "name" = 'MULTI_SITE';
UPDATE "subscription_plans" SET "scope" = 'ENTERPRISE', "module" = 'COMPLETE' WHERE "name" = 'ENTERPRISE';
