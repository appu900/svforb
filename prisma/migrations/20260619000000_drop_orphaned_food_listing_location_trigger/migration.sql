-- The `location` column was dropped from food_listings in migration
-- 20260616180800_added_farmer_role, but the trigger and function that
-- reference it were not. This causes P2022 ColumnNotFound on every INSERT.

DROP TRIGGER IF EXISTS food_listings_sync_location ON food_listings;
DROP FUNCTION IF EXISTS sync_food_listing_location();
