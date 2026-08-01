-- Partial index backing the active-listing feeds. Present in the schema but
-- never migrated, so the deployed database was missing it.

CREATE INDEX IF NOT EXISTS "food_listings_active_idx"
  ON "food_listings"("status")
  WHERE (status = ANY (ARRAY['ACTIVE'::"ListingStatus", 'PARTIAL'::"ListingStatus"]));
