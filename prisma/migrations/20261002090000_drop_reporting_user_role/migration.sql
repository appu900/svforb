-- Postgres cannot drop an enum value in place, so the type is rebuilt without
-- it. The casts fail loudly if any row still holds REPORTING_USER.
ALTER TYPE "EnterpriseRole" RENAME TO "EnterpriseRole_old";

CREATE TYPE "EnterpriseRole" AS ENUM (
  'SUPER_ADMIN', 'ENTERPRISE_ADMIN', 'GROUP_ADMIN', 'CLUSTER_ADMIN', 'SITE_ADMIN', 'SITE_USER'
);

ALTER TABLE "org_membership"
  ALTER COLUMN "enterpriseRole" TYPE "EnterpriseRole"
  USING ("enterpriseRole"::text::"EnterpriseRole");

ALTER TABLE "enterprise_invitations"
  ALTER COLUMN "enterpriseRole" TYPE "EnterpriseRole"
  USING ("enterpriseRole"::text::"EnterpriseRole");

DROP TYPE "EnterpriseRole_old";
