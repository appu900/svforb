-- PlanFeature gains a stable `key` used for code-level entitlement checks.
-- `label` is display text and may be reworded; `key` must not change.

-- Rows are rebuilt wholesale by prisma/seed.ts, so clearing is safe and lets
-- the new column be NOT NULL without inventing a default.
DELETE FROM "plan_features";

DROP INDEX IF EXISTS "plan_features_planId_label_key";

ALTER TABLE "plan_features" ADD COLUMN "key" TEXT NOT NULL;

CREATE UNIQUE INDEX "plan_features_planId_key_key" ON "plan_features"("planId", "key");
