-- Dashboard summary groups listings by organisation and day, and claims by collection day.
CREATE INDEX "food_listings_organisationId_createdAt_idx" ON "food_listings"("organisationId", "createdAt");
CREATE INDEX "food_listings_createdAt_idx" ON "food_listings"("createdAt");
CREATE INDEX "food_claims_collectedAt_idx" ON "food_claims"("collectedAt");
