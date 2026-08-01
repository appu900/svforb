-- Deferred plan changes: a downgrade is held until the current period closes.

ALTER TABLE "org_subscriptions" ADD COLUMN "pendingPlanId" INTEGER;
ALTER TABLE "org_subscriptions" ADD COLUMN "pendingBillingCycle" "BillingCycle";
ALTER TABLE "org_subscriptions" ADD COLUMN "pendingChangeEffectiveAt" TIMESTAMP(3);
ALTER TABLE "org_subscriptions" ADD COLUMN "stripeScheduleId" TEXT;

ALTER TABLE "org_subscriptions" ADD CONSTRAINT "org_subscriptions_pendingPlanId_fkey"
  FOREIGN KEY ("pendingPlanId") REFERENCES "subscription_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;
