# Modular billing (backend)

Saveful sells two **modules**, Make Food Count (`MFC`) and Saveful Connect (`CONNECT`), plus a discounted
**Complete Solution** bundle (`COMPLETE`, both modules). Each is offered at single-site and multi-site scope.
Product requirements and the client work live in the app repo: `saveful-for-business-rn/docs/modular-billing/`.

## Data model
- `SubscriptionPlan.module` (`BillingModule`: MFC | CONNECT | COMPLETE), `scope` (`PlanScope`: SINGLE | MULTI |
  ENTERPRISE), `trialDays` (0 = no trial), and card copy `tagline`, `closingLine`, `badge`.
- An organisation still has one `OrgSubscription` with one `planId`. Modules come from the plan.
- Catalogue (`prisma/seed.ts`): `MFC_SINGLE`, `CONNECT_SINGLE`, `COMPLETE_SINGLE`, `MFC_MULTI`, `CONNECT_MULTI`,
  `COMPLETE_MULTI`, `ENTERPRISE` (COMPLETE). The legacy `SINGLE_SITE`, `SINGLE_SITE_PLUS` and `MULTI_SITE` stay with
  `isActive=false`, `module=CONNECT`, so existing subscribers keep their price and get Saveful Connect.
- Make Food Count and Complete are offered to `BUSINESS_SINGLE` / `BUSINESS_MULTI` only. Farm producers can buy
  `CONNECT_SINGLE` only.

## API
- `GET /subscriptions/available`: each plan adds `module`, `scope`, `trialDays`, `trialAvailable` (the org's trial is
  unused, `trialDays > 0` and the plan is not contact-sales), `tagline`, `closingLine`, `badge`.
- `GET /subscriptions/me` adds `planModule`, `planScope` and `modules: ('MFC'|'CONNECT')[]`. `modules` is empty
  unless entitled (TRIALING/ACTIVE). Non-billable orgs (charities, farmer consumers) get both.
- Profile `subscription.plan` adds `module` and `scope`.

## Trials
- One trial per organisation (`organisations.freeTrialUsedAt`), and only on plans with `trialDays > 0`.
- `POST /billing/trial` on a plan without a trial returns `400 { error: 'TRIAL_NOT_OFFERED' }`. Clients fall back to
  `POST /billing/checkout`.

## Changing plan (`src/modules/billing/plan-change.rules.ts`)
Within one scope, the module decides:

| From \ To | MFC | CONNECT | COMPLETE |
|---|---|---|---|
| MFC | cycle only | SWITCH (period end) | UPGRADE (now, prorated) |
| CONNECT | SWITCH (period end) | cycle only | UPGRADE (now) |
| COMPLETE | DOWNGRADE (period end) | DOWNGRADE (period end) | cycle only |

- Same module (e.g. legacy Single Site + → Saveful Connect), or a change of scope: the monthly list price decides,
  then the cycle (annual applies now, monthly waits). Different plans at the same price and cycle are a SWITCH.
- Same plan and cycle: `409 ALREADY_ON_PLAN`.
- `change-plan` and `change-plan/preview` responses add `changeType: 'UPGRADE' | 'DOWNGRADE' | 'SWITCH'`.
- **Upgrading while TRIALING** to a plan with `trialDays > 0` (Connect → Complete) swaps the price and keeps the
  trial: no `trial_end: 'now'`, no card needed, nothing billed. To a plan without a trial, the trial ends now and a
  card is required (`PAYMENT_METHOD_REQUIRED`), as before.

## Per-site billing
`chargesPerSite(plan) = plan.isPerSite`. `*_MULTI` plans bill per site: Stripe quantity = site count at checkout,
kept in sync by `syncSiteQuantity` with proration. Legacy `MULTI_SITE` is `isPerSite=false`, a flat fee.

## Module gating
- `@RequiresModule('MFC' | 'CONNECT')` (`subscriptions/decorators/requires-module.decorator.ts`) is read by the global
  `SubscriptionInterceptor` on writes for billable orgs (not platform admins, not `@SkipSubscriptionCheck`). It runs
  `assertModule`, which runs `assertEntitled` first, then returns `402 { error: 'MODULE_REQUIRED', module }`.
- Applied to: `MfcRecordsController` (MFC); `FoodListingController` `POST photos`, `POST /`, `DELETE :id`, the
  business `ConnectionController` and `ClaimsController` (CONNECT).
- Not gated: reads, food-listing notifications, `charity/connections`, consolidated collections (any paid plan).

## Error codes
| Code | HTTP | Meaning |
|---|---|---|
| `MODULE_REQUIRED` | 402 | The plan lacks the route's module. The body has `module`. |
| `TRIAL_NOT_OFFERED` | 400 | The plan is sold without a trial. |

## Deploy
1. Deploy the backend.
2. `npx prisma migrate deploy` (`20261125000000_billing_modules`, additive).
3. `npx prisma db seed`. This hides the legacy plans from sale, so run it only once the clients that show the new plans
   are ready.

Rollback: redeploy the previous build; the columns are additive. To stop selling the new plans, flip `isActive`
through the admin plan API.
