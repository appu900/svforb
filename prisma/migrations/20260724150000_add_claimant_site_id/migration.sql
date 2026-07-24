-- Tie charity/farmer claims to the site that claimed them (multi-site impact).
ALTER TABLE "food_claims"
  ADD COLUMN IF NOT EXISTS "claimantSiteId" INTEGER;

CREATE INDEX IF NOT EXISTS "food_claims_claimantSiteId_idx" ON "food_claims"("claimantSiteId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'food_claims_claimantSiteId_fkey'
  ) THEN
    ALTER TABLE "food_claims"
      ADD CONSTRAINT "food_claims_claimantSiteId_fkey"
      FOREIGN KEY ("claimantSiteId") REFERENCES "sites"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Single-site orgs: attribute all legacy claims to that site.
UPDATE "food_claims" fc
SET "claimantSiteId" = s.id
FROM (
  SELECT "organisationId", MIN(id) AS id
  FROM "sites"
  GROUP BY "organisationId"
  HAVING COUNT(*) = 1
) s
WHERE fc."claimantOrgId" = s."organisationId"
  AND fc."claimantSiteId" IS NULL;

-- Multi-site legacy: attribute via collecting driver's site access in the claimant org.
UPDATE "food_claims" fc
SET "claimantSiteId" = mapped."siteId"
FROM (
  SELECT DISTINCT ON (dp."claimId")
    dp."claimId",
    sa."siteId"
  FROM "driver_pickups" dp
  JOIN "site_accesses" sa ON sa."userId" = dp."driverId"
  JOIN "food_claims" c ON c.id = dp."claimId"
  WHERE sa."organisationId" = c."claimantOrgId"
  ORDER BY dp."claimId", dp."collectedAt" DESC NULLS LAST, sa.id ASC
) mapped
WHERE fc.id = mapped."claimId"
  AND fc."claimantSiteId" IS NULL;
