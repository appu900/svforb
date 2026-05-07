-- prisma/migrations/20260507000001_add_food_listings_location/migration.sql

-- Add geography column to food_listings
ALTER TABLE food_listings
  ADD COLUMN IF NOT EXISTS location geography(Point, 4326);

-- Backfill from existing pickupLat/pickupLng
UPDATE food_listings
  SET location = ST_SetSRID(
    ST_MakePoint("pickupLng", "pickupLat"), 4326
  )::geography
  WHERE
    "pickupLat" IS NOT NULL
    AND "pickupLng" IS NOT NULL
    AND location IS NULL;

-- Spatial index
CREATE INDEX IF NOT EXISTS food_listings_location_gist_idx
  ON food_listings USING GIST(location);

-- Partial index for active listings only
-- nearby listings query always filters ACTIVE/PARTIAL
CREATE INDEX IF NOT EXISTS food_listings_active_idx
  ON food_listings(status)
  WHERE status IN ('ACTIVE', 'PARTIAL');

-- Auto sync trigger
-- keeps location in sync with pickupLat/pickupLng automatically
-- no $executeRaw needed in service code
CREATE OR REPLACE FUNCTION sync_food_listing_location()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."pickupLat" IS NOT NULL AND NEW."pickupLng" IS NOT NULL THEN
    NEW.location = ST_SetSRID(
      ST_MakePoint(NEW."pickupLng", NEW."pickupLat"), 4326
    )::geography;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS food_listings_sync_location ON food_listings;
CREATE TRIGGER food_listings_sync_location
  BEFORE INSERT OR UPDATE OF "pickupLat", "pickupLng"
  ON food_listings
  FOR EACH ROW
  EXECUTE FUNCTION sync_food_listing_location();