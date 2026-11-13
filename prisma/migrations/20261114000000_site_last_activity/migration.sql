-- sites."lastActivityAt" feeds "Sites with no recent activity" and the Sites
-- table, but no code path ever wrote it, so every active site read as quiet.
-- Qualifying activity: a listing published at the site, a claim on one of its
-- listings, or a claim / collection made by the site as the recipient.

-- Backfill from existing listings and claims
WITH activity AS (
  SELECT "siteId" AS site_id, MAX("createdAt") AS activity_at
  FROM food_listings
  GROUP BY "siteId"
  UNION ALL
  SELECT fl."siteId", MAX(COALESCE(fc."collectedAt", fc."createdAt"))
  FROM food_claims fc
  JOIN food_listings fl ON fl.id = fc."listingId"
  GROUP BY fl."siteId"
  UNION ALL
  SELECT fc."claimantSiteId", MAX(COALESCE(fc."collectedAt", fc."createdAt"))
  FROM food_claims fc
  WHERE fc."claimantSiteId" IS NOT NULL
  GROUP BY fc."claimantSiteId"
),
latest AS (
  SELECT site_id, MAX(activity_at) AS activity_at FROM activity GROUP BY site_id
)
UPDATE sites s
SET "lastActivityAt" = latest.activity_at
FROM latest
WHERE s.id = latest.site_id
  AND (s."lastActivityAt" IS NULL OR s."lastActivityAt" < latest.activity_at);

-- Only ever moves forward, and skips the write when nothing changes.
CREATE OR REPLACE FUNCTION touch_site_activity(target_site_id INTEGER, activity_at TIMESTAMP)
RETURNS VOID AS $$
BEGIN
  IF target_site_id IS NULL OR activity_at IS NULL THEN
    RETURN;
  END IF;
  UPDATE sites
  SET "lastActivityAt" = activity_at
  WHERE id = target_site_id
    AND ("lastActivityAt" IS NULL OR "lastActivityAt" < activity_at);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION food_listing_touch_site()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM touch_site_activity(NEW."siteId", NEW."createdAt");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS food_listings_touch_site ON food_listings;
CREATE TRIGGER food_listings_touch_site
  AFTER INSERT ON food_listings
  FOR EACH ROW
  EXECUTE FUNCTION food_listing_touch_site();

CREATE OR REPLACE FUNCTION food_claim_touch_sites()
RETURNS TRIGGER AS $$
DECLARE
  claim_activity_at TIMESTAMP;
  provider_site_id INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    claim_activity_at := COALESCE(NEW."collectedAt", NEW."createdAt");
  ELSIF NEW.status = 'COLLECTED' AND NEW."collectedAt" IS NOT NULL
        AND NEW."collectedAt" IS DISTINCT FROM OLD."collectedAt" THEN
    claim_activity_at := NEW."collectedAt";
  ELSE
    RETURN NEW;
  END IF;

  SELECT "siteId" INTO provider_site_id FROM food_listings WHERE id = NEW."listingId";
  PERFORM touch_site_activity(provider_site_id, claim_activity_at);
  PERFORM touch_site_activity(NEW."claimantSiteId", claim_activity_at);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS food_claims_touch_sites ON food_claims;
CREATE TRIGGER food_claims_touch_sites
  AFTER INSERT OR UPDATE OF status, "collectedAt" ON food_claims
  FOR EACH ROW
  EXECUTE FUNCTION food_claim_touch_sites();
