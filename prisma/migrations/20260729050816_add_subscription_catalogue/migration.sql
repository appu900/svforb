-- CreateEnum
CREATE TYPE "EnterpriseLocationBand" AS ENUM ('BAND_10_25', 'BAND_26_50', 'BAND_51_100', 'BAND_100_PLUS');

-- CreateEnum
CREATE TYPE "EnterpriseContactWindow" AS ENUM ('ASAP', 'MORNING', 'AFTERNOON', 'ANY_TIME');

-- CreateEnum
CREATE TYPE "EnterpriseEnquiryStatus" AS ENUM ('NEW', 'CONTACTED', 'CLOSED');

-- AlterTable
ALTER TABLE "org_subscriptions" ADD COLUMN     "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "currentPeriodStart" TIMESTAMP(3),
ADD COLUMN     "quantity" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "stripePriceId" TEXT;

-- AlterTable
ALTER TABLE "organisations" ADD COLUMN     "freeTrialUsedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "subscription_plans" ADD COLUMN     "applicableOrgTypes" "OrgType"[],
ADD COLUMN     "contactSalesOnly" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'AUD',
ADD COLUMN     "description" TEXT,
ADD COLUMN     "inheritsFromId" INTEGER,
ADD COLUMN     "isMostPopular" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isPerSite" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "stripePriceIdAnnual" TEXT,
ADD COLUMN     "stripePriceIdMonthly" TEXT,
ADD COLUMN     "stripeProductId" TEXT,
ALTER COLUMN "maxSites" DROP NOT NULL,
ALTER COLUMN "maxUserPerSite" DROP NOT NULL,
ALTER COLUMN "priceMonthly" DROP NOT NULL,
ALTER COLUMN "priceAnnual" DROP NOT NULL;

-- CreateTable
CREATE TABLE "plan_features" (
    "id" SERIAL NOT NULL,
    "planId" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "included" BOOLEAN NOT NULL DEFAULT true,
    "value" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "plan_features_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enterprise_enquiries" (
    "id" SERIAL NOT NULL,
    "organisationId" INTEGER,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "businessName" TEXT NOT NULL,
    "businessType" TEXT NOT NULL,
    "mobile" TEXT NOT NULL,
    "locationBand" "EnterpriseLocationBand" NOT NULL,
    "contactWindow" "EnterpriseContactWindow" NOT NULL,
    "message" TEXT,
    "status" "EnterpriseEnquiryStatus" NOT NULL DEFAULT 'NEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "enterprise_enquiries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "plan_features_planId_sortOrder_idx" ON "plan_features"("planId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "plan_features_planId_label_key" ON "plan_features"("planId", "label");

-- CreateIndex
CREATE INDEX "enterprise_enquiries_status_createdAt_idx" ON "enterprise_enquiries"("status", "createdAt");

-- CreateIndex
CREATE INDEX "enterprise_enquiries_organisationId_idx" ON "enterprise_enquiries"("organisationId");

-- CreateIndex
CREATE INDEX "org_subscriptions_stripeSubscriptionId_idx" ON "org_subscriptions"("stripeSubscriptionId");

-- CreateIndex
CREATE INDEX "subscription_plans_isActive_sortOrder_idx" ON "subscription_plans"("isActive", "sortOrder");

-- AddForeignKey
ALTER TABLE "subscription_plans" ADD CONSTRAINT "subscription_plans_inheritsFromId_fkey" FOREIGN KEY ("inheritsFromId") REFERENCES "subscription_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_features" ADD CONSTRAINT "plan_features_planId_fkey" FOREIGN KEY ("planId") REFERENCES "subscription_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enterprise_enquiries" ADD CONSTRAINT "enterprise_enquiries_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "organisations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
