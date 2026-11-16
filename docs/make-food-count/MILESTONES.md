# Make Food Count — backend milestones and AI prompts

How to use:

1. Open a fresh AI coding session in `svforb`.
2. Paste the **backend system prompt** below, then **one** milestone prompt.
3. Check the result yourself, commit, then move to the next milestone.

The app has its own plan in `saveful-for-business-rn/docs/make-food-count/MILESTONES.md`. The combined schedule:

| Day | Backend (this repo) | App |
|---|---|---|
| Mon 16 | **B1** model + taxonomy + reach | A1 foundation (fixtures until B2) |
| Tue 17 | **B2** records API | A2 Home + Sources, A3 Recording |
| Wed 18 | **B3** listing integration | A4 Summary, A5 Listing prefill |
| Thu 19 | **B4** outcomes, **B5** insights + home impact | A6 Outcomes, A7 Food Impact |
| Fri 20 | **B6** hardening + deploy notes | A8 tablet, accessibility, UAT, release |

---

## Backend system prompt (paste first, every time)

```text
You are a senior backend engineer on Saveful Connect (repo /Users/swagatkumardash/projects/svforb: NestJS,
Prisma 7 with the pg adapter, Postgres on PlanetScale, BullMQ/Redis, FCM push via NotificationService).
You are building "Make Food Count" (MFC).

Read first, every session:
- docs/make-food-count/SPEC.md (this repo) — the contract. Follow it exactly; it wins over your own ideas.
- ../saveful-for-business-rn/docs/make-food-count/SPEC.md §1–§2 for the product context and the client's
  open questions (CLIENT_QUESTIONS.md). Build the "Build default" where the client hasn't answered.

Rules:
1. Reuse existing code: siteAccess, OrgMemeberShip, UserScope + the existing enterprise scope resolver,
   snapshot-id stamping used by food listings, FoodListing/FoodItem/FoodClaim/ClaimItem, RecoveryPathway,
   AuditLog, the consolidated module's patterns (services split by concern, notifier, audit service, specs).
   grep before writing anything new.
2. Additive only. New models/enums/optional fields. Existing endpoints must behave exactly as before when the
   new optional inputs are absent; existing Jest specs must keep passing.
3. Migrations: hand-write a new folder under prisma/migrations (timestamp after the newest) or use
   `npx prisma migrate dev --create-only` against a LOCAL database only. NEVER run `migrate dev`, `db push`,
   `migrate reset` or any write against the DATABASE_URL in .env (it is production). Run `npx prisma generate`.
4. Server-side validation with class-validator DTOs (global ValidationPipe whitelist + forbidNonWhitelisted).
   DTO class names must be unique across the app (Swagger fails on duplicates) — prefix them with Mfc.
5. Resolve the caller's reach to site ids on the server; filter every query by it; out-of-reach → 404.
   Receiver org types (charity, farmer) and drivers get 404 on every /mfc route.
6. Every material change writes a FoodRecordEvent (and AuditLog where SPEC §8.5 says).
7. Money-like precision: qtyKg is Decimal(10,2); convert to number only at the response edge, rounded to 2 dp.
8. Tests: Jest specs for every rule you add (SPEC §9). Run `npx tsc --noEmit` and `npx jest`; both must pass.
9. Never commit, push, deploy or touch production data. Stop and report instead.
10. Finish with: files changed, commands run + results, anything not done, questions for the business owner.
    Update docs/make-food-count/SPEC.md if you had to decide something it doesn't cover.
```

---

## B1 — Model, taxonomy, reach

```text
Milestone B1. Implement SPEC §3 (data model), §4 (taxonomy) and the reach part of §6.

1. prisma/schema.prisma: add the enums and models from SPEC §3 with relations/back-relations
   (Organisation, Site, User, FoodListing, FoodItem). Add AuditArea.MAKE_FOOD_COUNT. Hand-write the
   additive migration SQL (enums, tables, FKs, indexes, unique constraints). `npx prisma generate`.
2. src/modules/make-food-count/ module skeleton: mfc.module.ts registered in AppModule, constants
   (taxonomy config + limits + taxonomyVersion), MfcTaxonomyController GET /mfc/taxonomy.
3. MfcAccessService: reachSiteIds(user) and assertSiteInReach / assertRecordInReach (404), canEditSite,
   canReadInsights. Reuse the enterprise scope resolver; non-enterprise orgs: owner/ORG_ADMIN = all sites,
   others = siteAccess sites. Receiver org types → empty reach.
4. Specs: taxonomy shape (every subtype has a listingName + iconKey), reach for each role in SPEC §6,
   charity → 404.

Done when: generate + typecheck + jest green; migration SQL reviewed by you line by line in the report.
```

## B2 — Records API

```text
Milestone B2. Implement the records endpoints of SPEC §5 and write rules §8.1–8.2 (+ §8.3 against the links
table even though nothing creates links yet).

1. DTOs: MfcCreateRecordDto, MfcPatchRecordDto, MfcPutLinesDto (+ MfcLineDto), MfcSaveRecordDto,
   MfcRecordListQueryDto.
2. MfcRecordService: create (idempotent on clientRequestId; stamp snapshot ids the same way listings do),
   list (cursor), get (record + live lines + totals + per-kind summary, outcomes 0 for now), patch, putLines
   (diff by clientKey in one transaction with the version check; events for create/qty/fit/delete; force
   fitForHumans=false outside OVERPRODUCTION; reject unknown taxonomy keys), save.
3. A pure totals helper (unit-tested): total, fit, notFit, per-source, per-group (meat, seafood).
4. Specs: UAT-02, UAT-03, validation cases, idempotent create, 409 on stale version, soft delete keeps
   events, edit by another site's user → 404.

Done when: typecheck + jest green. Paste an example GET /records/:id response into the report so the app team
can build against it.
```

## B3 — Listing integration

```text
Milestone B3. Implement listing-prefill and the optional `foodRecord` block on the existing create-listing
endpoints (people + farm), SPEC §5 and §8.1, §8.3.

1. Find the existing create-listing controller(s)/service(s) (grep the routes the app calls in
   saveful-for-business-rn/src/services/foodListing.service.ts). Add an optional `foodRecord` DTO field and
   read the `Idempotency-Key` header. Do NOT change behaviour when they are absent.
2. Inside the same transaction as the listing: validate per SPEC §5, create one FoodItem per linked line,
   FoodRecordListingLink rows, LISTED events, AuditLog. Store the idempotency key; a replay returns the stored
   listing.
3. GET /mfc/records/:id/listing-prefill?kind= using availableKg (SPEC §7).
4. Specs: UAT-06 (7 kg), UAT-07 (9 kg), replay → same listing, concurrent double submit → one listing,
   item qty > availableKg → 400, kind mismatch → 400, after listing prefill shows 0 available, existing
   listing specs unchanged.

Done when: typecheck + jest green; report the exact request body the app must send.
```

## B4 — Outcomes per line

```text
Milestone B4. Fill per-line and per-kind outcomes in GET /records/:id and the claim hooks (SPEC §7, §8.3–8.4).

1. Outcome query: for a record's links, sum ClaimItem.qtyKg by claim status, listing status, pathway; include
   CONSOLIDATED_ALLOCATION, exclude CONSOLIDATED_MASTER. Derive per-kind status:
   NOT_LISTED | LISTED | CLAIMED | PARTIALLY_COLLECTED | COLLECTED | EXPIRED | CANCELLED.
2. Line guards now use real outcomes (listed and collected).
3. Claim hooks: after a claim on a linked FoodItem becomes COLLECTED or CANCELLED (find where the claims service
   changes status), write events. Post-commit, failures only logged, claim behaviour untouched.
4. Specs: UAT-08 (0 then 4), expired and cancelled states, partial collection, consolidated allocation counted,
   master excluded.

Done when: typecheck + jest green.
```

## B5 — Insights and home impact

```text
Milestone B5. Implement GET /mfc/insights/filters, /mfc/insights, /mfc/insights/sources/:source and
/mfc/home-impact per SPEC §5 and §7.

1. Filters: options within reach; each site carries groupId/territoryId/clusterId so the app can cascade.
   Include clusters only if the org has any.
2. Insights: one parameterised SQL per block (overview, destinations, bySource, whatHappened, byCategory,
   bySite, trend) filtered by reach site ids + snapshot dimensions + recordedAt range. No N+1. Round to 2 dp.
3. Home impact per SPEC §7 (recordedKg from MFC; diverted/collections/CO2 from all verified collections of the
   site — keep this switchable with one constant, see client question 16).
4. Specs: buckets sum to notRecovered; destinations share sums to 100% when recovered > 0; reach (UAT-10);
   empty range → zeros; a moved site keeps old records in the old territory (snapshot).

Done when: typecheck + jest green; report one example payload for each endpoint.
```

## B6 — Hardening and release notes

```text
Milestone B6. Make MFC release-ready.

1. Review indexes against the B5 queries (EXPLAIN on a local DB with seeded data if available).
2. Contract check like test/consolidated.contract.check.ts: send the exact payloads the app sends (take them
   from the app's makeFoodCount.service.ts) through the DTOs; none may fail.
3. Swagger: tags and examples on every /mfc route; no duplicate DTO names.
4. docs/make-food-count/DEPLOYMENT.md: deploy → `npx prisma migrate deploy` → restart; rollback; smoke test
   (GET /mfc/taxonomy 401 without token, 200 with a business token; charity token → 404).
5. Full `npx jest` + `npx tsc --noEmit`. Boot the app with dummy env from an empty dir as a DI smoke test if a
   real DB isn't available, and list the /mfc routes it maps.

Do not deploy. Report a checklist.
```
