-- Enterprise user management: role (what they can do) and scope (what they see).

CREATE TYPE "EnterpriseRole" AS ENUM (
  'SUPER_ADMIN', 'REPORTING_USER', 'GROUP_ADMIN', 'CLUSTER_ADMIN', 'SITE_ADMIN', 'SITE_USER'
);
CREATE TYPE "ScopeType" AS ENUM ('ENTERPRISE', 'GROUP', 'CLUSTER', 'TERRITORY', 'SITE');

-- Distinguishes an unused invite (INVITED) from a user who has signed in (ACTIVE)
ALTER TABLE "users" ADD COLUMN "lastLoginAt" TIMESTAMP(3);

ALTER TABLE "org_membership" ADD COLUMN "enterpriseRole" "EnterpriseRole";

CREATE TABLE "user_scopes" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "organisationId" INTEGER NOT NULL,
    "scopeType" "ScopeType" NOT NULL,
    "scopeId" INTEGER,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grantedBy" INTEGER NOT NULL,
    CONSTRAINT "user_scopes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "user_scopes_userId_scopeType_scopeId_key" ON "user_scopes"("userId", "scopeType", "scopeId");
CREATE INDEX "user_scopes_userId_idx" ON "user_scopes"("userId");
CREATE INDEX "user_scopes_organisationId_scopeType_idx" ON "user_scopes"("organisationId", "scopeType");
ALTER TABLE "user_scopes" ADD CONSTRAINT "user_scopes_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_scopes" ADD CONSTRAINT "user_scopes_organisationId_fkey"
  FOREIGN KEY ("organisationId") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing Enterprise org admins become Super Admins so nothing locks out.
UPDATE "org_membership" m
SET "enterpriseRole" = 'SUPER_ADMIN'
FROM "org_subscriptions" s
JOIN "subscription_plans" p ON p.id = s."planId"
WHERE m."organisationId" = s."organisationId"
  AND p.name = 'ENTERPRISE'
  AND m."orgRole" = 'SUPER_ADMIN';
