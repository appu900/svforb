-- Charity/farmer and food business can each rate the driver after delivery.
ALTER TABLE "driver_pickups"
  ADD COLUMN IF NOT EXISTS "charityDriverRating" INTEGER,
  ADD COLUMN IF NOT EXISTS "charityDriverRatingNote" TEXT,
  ADD COLUMN IF NOT EXISTS "restaurantDriverRating" INTEGER,
  ADD COLUMN IF NOT EXISTS "restaurantDriverRatingNote" TEXT;
