-- INR pricing for region = IN. Stored alongside the AUD amounts and pushed to
-- Stripe as currency_options on the same Price, so price ids are unchanged.
ALTER TABLE "subscription_plans"
  ADD COLUMN "priceMonthlyInr" DOUBLE PRECISION,
  ADD COLUMN "priceAnnualInr"  DOUBLE PRECISION;
