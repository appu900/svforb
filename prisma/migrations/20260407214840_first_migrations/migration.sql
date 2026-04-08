-- CreateEnum
CREATE TYPE "Region" AS ENUM ('IN', 'US', 'AU');

-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('PLATFORM_ADMIN', 'ORG_USER', 'ORG_ADMIN');

-- CreateEnum
CREATE TYPE "OrgRole" AS ENUM ('SUPER_ADMIN', 'ORG_MEMBER', 'ORG_ADMIN');

-- CreateEnum
CREATE TYPE "SiteRole" AS ENUM ('SITE_ADMIN', 'STAFF');

-- CreateEnum
CREATE TYPE "OrgType" AS ENUM ('BUSINESS_SINGLE', 'BUSINESS_MULTI', 'CHARITY');

-- CreateEnum
CREATE TYPE "VenueType" AS ENUM ('CAFE_RESTAURANT', 'BAKERY', 'GROCERY_STORE', 'FOOD_TRUCK', 'CATERING_SERVICE', 'HOTEL', 'WEDDING_VENUE', 'CLOUD_KITCHEN', 'OTHER');

-- CreateEnum
CREATE TYPE "BillingCycle" AS ENUM ('MONTHLY', 'ANNUAL');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "StorageType" AS ENUM ('NON_REFRIGERATED', 'REFRIGERATED', 'FROZEN');

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "region" "Region",
    "platformRole" "PlatformRole" NOT NULL DEFAULT 'ORG_USER',
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "emailverifyToken" TEXT,
    "emailVerifyExpiry" TIMESTAMP(3),
    "passwordResetToken" TEXT,
    "passwordResetExpiry" TIMESTAMP(3),
    "deviceToken" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamMember" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,

    CONSTRAINT "TeamMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_plans" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "maxSites" INTEGER NOT NULL,
    "maxUserPerSite" INTEGER NOT NULL,
    "priceMonthly" DOUBLE PRECISION NOT NULL,
    "priceAnnual" DOUBLE PRECISION NOT NULL,
    "features" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscription_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organisations" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "organizationType" "OrgType" NOT NULL,
    "region" "Region",
    "registrationNumber" TEXT,
    "address" TEXT NOT NULL,
    "brandName" TEXT,
    "venueType" "VenueType",
    "logoUrl" TEXT,
    "subscriptionId" INTEGER NOT NULL,
    "subscriptionStatus" "SubscriptionStatus" NOT NULL DEFAULT 'TRIALING',
    "billingCycle" "BillingCycle" NOT NULL DEFAULT 'MONTHLY',
    "trialEndsAt" TIMESTAMP(3),
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "currentPeriodEnd" TIMESTAMP(3),
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "ratingAvg" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ratingCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organisations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sites" (
    "id" SERIAL NOT NULL,
    "organisationId" INTEGER NOT NULL,
    "organisationName" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "postcode" TEXT,
    "contactName" TEXT NOT NULL,
    "contactEmail" TEXT NOT NULL,
    "contactMobile" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_membership" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "organisationId" INTEGER NOT NULL,
    "orgRole" "OrgRole" NOT NULL DEFAULT 'ORG_MEMBER',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_accesses" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "siteId" INTEGER NOT NULL,
    "organisationId" INTEGER NOT NULL,
    "siteRole" "SiteRole" NOT NULL DEFAULT 'STAFF',
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grantedBy" INTEGER NOT NULL,

    CONSTRAINT "site_accesses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_phoneNumber_idx" ON "users"("phoneNumber");

-- CreateIndex
CREATE INDEX "users_region_idx" ON "users"("region");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_plans_name_key" ON "subscription_plans"("name");

-- CreateIndex
CREATE INDEX "organisations_region_idx" ON "organisations"("region");

-- CreateIndex
CREATE INDEX "organisations_organizationType_idx" ON "organisations"("organizationType");

-- CreateIndex
CREATE INDEX "organisations_subscriptionId_idx" ON "organisations"("subscriptionId");

-- CreateIndex
CREATE INDEX "sites_organisationId_idx" ON "sites"("organisationId");

-- CreateIndex
CREATE INDEX "org_membership_userId_idx" ON "org_membership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "org_membership_userId_organisationId_key" ON "org_membership"("userId", "organisationId");

-- CreateIndex
CREATE INDEX "site_accesses_siteId_userId_idx" ON "site_accesses"("siteId", "userId");

-- CreateIndex
CREATE INDEX "site_accesses_userId_idx" ON "site_accesses"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "site_accesses_userId_siteId_key" ON "site_accesses"("userId", "siteId");

-- AddForeignKey
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscription_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_membership" ADD CONSTRAINT "org_membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_membership" ADD CONSTRAINT "org_membership_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_accesses" ADD CONSTRAINT "site_accesses_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_accesses" ADD CONSTRAINT "site_accesses_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_accesses" ADD CONSTRAINT "site_accesses_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
