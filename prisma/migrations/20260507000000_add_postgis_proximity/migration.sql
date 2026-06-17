-- Enable PostGIS extension
CREATE EXTENSION IF NOT EXISTS postgis;

-- Add geography column to sites (used for proximity queries)
ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS location geography(Point, 4326);

-- Backfill from existing lat/lng
UPDATE sites
  SET location = ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography
  WHERE latitude IS NOT NULL AND longitude IS NOT NULL;

-- Add geography column to organisations
ALTER TABLE organisations
  ADD COLUMN IF NOT EXISTS location geography(Point, 4326);

UPDATE organisations
  SET location = ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography
  WHERE latitude IS NOT NULL AND longitude IS NOT NULL;

-- Spatial indexes for fast ST_DWithin queries
CREATE INDEX IF NOT EXISTS sites_location_gist_idx
  ON sites USING GIST(location);

CREATE INDEX IF NOT EXISTS organisations_location_gist_idx
  ON organisations USING GIST(location);