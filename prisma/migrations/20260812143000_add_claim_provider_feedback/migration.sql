-- Restaurant (listing provider) confirmation + evaluation after claimant collects.
ALTER TABLE "food_claims"
  ADD COLUMN IF NOT EXISTS "providerConfirmedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "providerRating" INTEGER,
  ADD COLUMN IF NOT EXISTS "providerRatingNote" TEXT,
  ADD COLUMN IF NOT EXISTS "providerDidCollect" BOOLEAN;
