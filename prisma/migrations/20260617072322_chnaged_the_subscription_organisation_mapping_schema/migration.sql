/*
  Warnings:

  - You are about to drop the column `billingCycle` on the `organisations` table. All the data in the column will be lost.
  - You are about to drop the column `currentPeriodEnd` on the `organisations` table. All the data in the column will be lost.
  - You are about to drop the column `stripeCustomerId` on the `organisations` table. All the data in the column will be lost.
  - You are about to drop the column `stripeSubscriptionId` on the `organisations` table. All the data in the column will be lost.
  - You are about to drop the column `subscriptionId` on the `organisations` table. All the data in the column will be lost.
  - You are about to drop the column `subscriptionStatus` on the `organisations` table. All the data in the column will be lost.
  - You are about to drop the column `trialEndsAt` on the `organisations` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "organisations" DROP CONSTRAINT "organisations_subscriptionId_fkey";

-- DropIndex
DROP INDEX "organisations_subscriptionId_idx";

-- AlterTable
ALTER TABLE "organisations" DROP COLUMN "billingCycle",
DROP COLUMN "currentPeriodEnd",
DROP COLUMN "stripeCustomerId",
DROP COLUMN "stripeSubscriptionId",
DROP COLUMN "subscriptionId",
DROP COLUMN "subscriptionStatus",
DROP COLUMN "trialEndsAt";

-- CreateTable
CREATE TABLE "org_subscriptions" (
    "id" SERIAL NOT NULL,
    "organisationId" INTEGER NOT NULL,
    "planId" INTEGER NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'TRIALING',
    "billingCycle" "BillingCycle" NOT NULL DEFAULT 'MONTHLY',
    "trialEndsAt" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "org_subscriptions_organisationId_key" ON "org_subscriptions"("organisationId");

-- CreateIndex
CREATE INDEX "org_subscriptions_organisationId_idx" ON "org_subscriptions"("organisationId");

-- CreateIndex
CREATE INDEX "org_subscriptions_status_idx" ON "org_subscriptions"("status");

-- AddForeignKey
ALTER TABLE "org_subscriptions" ADD CONSTRAINT "org_subscriptions_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_subscriptions" ADD CONSTRAINT "org_subscriptions_planId_fkey" FOREIGN KEY ("planId") REFERENCES "subscription_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
