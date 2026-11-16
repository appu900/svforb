# Make Food Count — backend spec

Product, screens and the client's wording live in the app repo:
`saveful-for-business-rn/docs/make-food-count/SPEC.md` (read §1–§2 there first). Client questions:
`saveful-for-business-rn/docs/make-food-count/CLIENT_QUESTIONS.md`. Delivery: **Fri 20 Nov 2026**.

This file is the contract the app builds against: data model, endpoints, rules, metric maths, permissions, tests.

---

## 1. Principles

1. **One food record, many outcomes.** Recorded, listed, claimed and collected are four separate numbers.
   Listing never changes a line; collection never changes a listing line's recorded kg.
2. **Only verified collection counts as recovered.** Claim status `COLLECTED`, measured from `ClaimItem.qtyKg`.
3. **Additive only.** New tables and optional fields. Existing listing, claim and consolidated behaviour is
   unchanged when the new optional inputs are absent.
4. **Reach is resolved on the server** to a set of site ids, and every query is filtered by it. Out-of-reach ids
   return 404.
5. **Every material change is an event** (who, when, before, after) so metrics can be replayed and audited.

## 2. Reused

| Need | Existing |
|---|---|
| Site access | `siteAccess` (SITE_ADMIN / STAFF), `OrgMemeberShip` (orgRole, enterpriseRole) |
| Enterprise reach | `UserScope` (ENTERPRISE / GROUP / CLUSTER / TERRITORY / SITE) + `GroupSite` / `ClusterSite` / `TerritorySite`. Reuse the existing scope resolver (grep `UserScope` usages in the enterprise module) |
| History-safe dimensions | `snapshotGroupId / snapshotClusterId / snapshotTerritoryId`, stamped as listings and claims do today |
| Listings | `FoodListing` (HUMAN → FOOD_FOR_PEOPLE; ANIMAL → LIVESTOCK_FEED), `FoodItem` |
| Claims / collection | `FoodClaim` (PENDING → CONFIRMED → COLLECTED / CANCELLED), `ClaimItem`, `recoveryPathway`, `claimKind` |
| Destinations | `RecoveryPathway`: FOOD_FOR_PEOPLE = Charity donations, LIVESTOCK_FEED = Animal feed, CIRCULAR_RECOVERY = Compost / organics, BIOENERGY = Bioenergy |
| Audit | `AuditLog` (add `AuditArea.MAKE_FOOD_COUNT`) |
| Impact factors | the same factors the app uses (`estimateMealsSaved`, `estimateCo2AvoidedKg`) — move to a shared backend constant if not already there |

## 3. Data model (one additive migration)

```prisma
enum FoodSource       { OVERPRODUCTION SPOILAGE PREPARATION PLATE_SCRAPS }
enum FoodRecordStatus { DRAFT SAVED }
enum FoodListingKind  { EDIBLE NON_EDIBLE }
enum FoodRecordEventType { RECORD_CREATED RECORD_SAVED SOURCES_CHANGED LINE_CREATED QTY_CHANGED FIT_CHANGED LINE_DELETED LISTED LISTING_CANCELLED CLAIM_COLLECTED CLAIM_CANCELLED }

model FoodRecord {                       // food_records
  id              Int      @id @default(autoincrement())
  organisationId  Int
  siteId          Int
  createdById     Int
  updatedById     Int
  recordedAt      DateTime @default(now())   // reporting date (see §7)
  status          FoodRecordStatus @default(DRAFT)
  sources         FoodSource[]
  version         Int      @default(1)        // optimistic lock
  clientRequestId String   @unique            // idempotent create
  snapshotGroupId Int?  snapshotClusterId Int?  snapshotTerritoryId Int?
  createdAt DateTime @default(now())  updatedAt DateTime @updatedAt
  @@index([organisationId, recordedAt]) @@index([siteId, recordedAt]) @@index([snapshotGroupId]) @@index([snapshotTerritoryId]) @@index([snapshotClusterId])
}

model FoodRecordLine {                   // food_record_lines
  id           Int @id @default(autoincrement())
  recordId     Int            // onDelete: Cascade
  clientKey    String         // stable key from the app
  source       FoodSource
  category     String         // taxonomy key, e.g. "meat_poultry"
  subtype      String?        // e.g. "chicken"
  qtyKg        Decimal @db.Decimal(10, 2)
  unit         String  @default("kg")
  fitForHumans Boolean        // always false unless source = OVERPRODUCTION
  deletedAt    DateTime?      // soft delete
  createdAt DateTime @default(now())  updatedAt DateTime @updatedAt
  @@unique([recordId, clientKey]) @@index([recordId, source])
}

model FoodRecordEvent {                  // food_record_events
  id Int @id @default(autoincrement())
  recordId Int  lineId Int?  actorUserId Int?   // null actor = system (claim hooks)
  type FoodRecordEventType
  before Json?  after Json?
  createdAt DateTime @default(now())
  @@index([recordId, createdAt])
}

model FoodRecordListingLink {            // food_record_listing_links
  id Int @id @default(autoincrement())
  recordId Int  lineId Int  listingId Int  foodItemId Int @unique
  kind FoodListingKind
  listedQtyKg Decimal @db.Decimal(10, 2)
  createdAt DateTime @default(now())
  @@index([lineId]) @@index([listingId]) @@index([recordId])
}

model IdempotencyKey {                   // idempotency_keys (generic, reusable)
  key String @id  userId Int  scope String  resultId Int?  createdAt DateTime @default(now())
  @@index([createdAt])
}
```

Rules on the model:

- **One `FoodItem` per linked line** (no merging), so `ClaimItem` kg maps to exactly one line.
- Items added by hand in the listing screen are not linked and don't count in Make Food Count.
- `fitForHumans` is forced to `false` for non-Overproduction sources on the server, whatever the client sends.

## 4. Taxonomy

The taxonomy is a constant config served at `GET /mfc/taxonomy` and versioned with a `taxonomyVersion` string.

Each entry has: `source`, `key`, `label`, `imageKey`, `listingName`, `listingIconKey`, optional `subtypes[]`, and `fitAllowed`.

- Unknown keys are rejected.
- The rows are those in the app SPEC §7.
- The client may still change labels (question 6). Keys don't change.

Limits are also served from the config: `maxKgPerLine: 500` and `decimals: 2`.

## 5. API (`/api/v1/mfc`, JWT, business roles only)

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/taxonomy` | — | taxonomy + limits |
| POST | `/records` | `{siteId, clientRequestId, sources[], recordedAt?}` | record (same `clientRequestId` → same record, 200) |
| GET | `/records` | `siteId?, status?, from?, to?, cursor?, limit?` | page of records with totals |
| GET | `/records/:id` | — | record, live lines, totals, per-kind `{eligibleKg, listedKg, claimedKg, collectedKg, status}`, per-line outcomes |
| PATCH | `/records/:id` | `{version, sources?, recordedAt?}` | record; stale version → 409 `{currentVersion}` |
| PUT | `/records/:id/lines` | `{version, lines:[{clientKey, source, category, subtype?, qtyKg, fitForHumans?}]}` | full set: diff by `clientKey` → create / update / soft-delete; events; new `version` + totals |
| POST | `/records/:id/save` | `{version}` | DRAFT → SAVED (idempotent) |
| GET | `/records/:id/listing-prefill` | `kind=EDIBLE\|NON_EDIBLE` | `{items:[{lineId, name, category, iconKey, countedKg, availableKg}], totalKg}` |
| GET | `/home-impact` | `siteId?` | `{recordedKg, divertedKg, collections, co2AvoidedKg}` |
| GET | `/insights/filters` | — | `{groups, territories, clusters, sites}` within reach; each site lists its group, territory and cluster ids for cascading |
| GET | `/insights` | `from, to, groupId?, territoryId?, clusterId?, siteId?` | §7 payload |
| GET | `/insights/sources/:source` | same filters | drill-down for one source |

**Existing create-listing endpoints (people and farm)** take an optional field:

```
foodRecord: { recordId, kind, items: [{ lineId, itemIndex }] }
```

The request also takes an `Idempotency-Key` header. In the same transaction as the listing, the server must:

- check reach;
- check each line belongs to the record and its kind matches (EDIBLE = Overproduction ticked fit; NON_EDIBLE = any line that isn't fit);
- check each item's quantity is ≤ the line's `availableKg`;
- create the links and the LISTED events.

A replayed key returns the first listing. Without `foodRecord`, the endpoints behave exactly as today.

Validation is done with class-validator DTOs under the global `ValidationPipe` (whitelist + forbidNonWhitelisted). `qtyKg` must be > 0, have ≤ 2 decimals and be ≤ 500.

## 6. Permissions

| Client role | Connect mapping | Records | Insights |
|---|---|---|---|
| Kitchen staff / site user | `siteAccess` STAFF or SITE_ADMIN; enterprise SITE_USER | create, edit, save, list for their sites | their sites |
| Site administrator | `siteAccess` SITE_ADMIN; enterprise SITE_ADMIN | above + events (audit) | their sites |
| Group / Territory / Cluster manager | enterprise GROUP_ADMIN / CLUSTER_ADMIN + `UserScope` | read only | their scope |
| Enterprise admin / org owner / ORG_ADMIN | enterprise ENTERPRISE_ADMIN / SUPER_ADMIN, orgRole SUPER_ADMIN / ORG_ADMIN | read (edit only where they also hold site access) | whole org |
| Charity / farmer / driver | receiver org types | **none** (404 on all `/mfc`) | none |

"Edit own site food records" means any record of a site the user can access, not only records they created. This is
assumed and confirmed with the client.

## 7. Metric definitions

All metrics are limited to reach and to the filters. Dimensions use the record's snapshot ids, and dates use `record.recordedAt` (question 13).

| Metric | Definition |
|---|---|
| recordedKg | Σ `qtyKg` of live lines |
| fitKg / notFitKg | live lines by `fitForHumans` |
| eligibleKg (kind) | fit lines (EDIBLE) or not-fit lines (NON_EDIBLE) |
| listedKg | Σ `listedQtyKg` of links whose listing status ≠ CANCELLED |
| availableKg (line) | line `qtyKg` − Σ `listedQtyKg` on links whose listing is ACTIVE, PARTIAL or CLAIMED |
| claimedKg | Σ `ClaimItem.qtyKg` on linked items, claim status PENDING / CONFIRMED / COLLECTED |
| collectedKg = recovered | Σ `ClaimItem.qtyKg` on linked items, claim status **COLLECTED** |
| destination | `claim.recoveryPathway`, falling back to `listing.recoveryPathway` |
| notRecovered | `recordedKg − collectedKg`, broken down as below |
| impact | meals and CO₂ factors applied to **collectedKg**, labelled estimated |

`notRecovered` breakdown:

| Bucket | Meaning |
|---|---|
| notListed | Lines never listed |
| listedNotClaimed | Listing ACTIVE, nothing claimed |
| expired | Listing EXPIRED, unclaimed part |
| cancelled | Listing CANCELLED |
| claimedNotCollected | Claim PENDING or CONFIRMED |

The buckets must sum to `notRecovered`; a test checks this.

**Consolidated Collections:** if a linked listing went through Consolidated Collections, count `CONSOLIDATED_ALLOCATION` claims and **never** `CONSOLIDATED_MASTER`.

**`/insights` payload:**

```
{ filtersApplied, isDemo:false,
  overview:{recordedKg, recoveredKg, notRecoveredKg, estimatedMeals, estimatedCo2Kg},
  destinations:[{pathway, kg, shareOfRecovered}],
  bySource:[{source, recordedKg, recoveredKg, notRecoveredKg}],
  whatHappened:{recordedKg, listedKg, claimedKg, collectedKg, notRecovered:{notListed, listedNotClaimed, expired, cancelled, claimedNotCollected}},
  redistributed:{byCategory:[…], bySite:[…], trend:[{bucketStart, recordedKg, recoveredKg}]} }
```

- The trend bucket is the day for ranges up to 31 days, the week up to 6 months, and the month beyond that.
- Aggregate in SQL (`$queryRaw` with parameterised filters) with no N+1 queries.
- An empty range returns zeros, never an error.

**`/home-impact`:**
- `recordedKg` comes from Make Food Count.
- `divertedKg`, `collections` and `co2AvoidedKg` come from **all** verified collections of the site (question 16; switch to Make Food Count-only if the client says so).

## 8. Write rules

1. **Idempotency:**
   - `POST /records` is idempotent on `clientRequestId`.
   - Listing creation is idempotent on the `Idempotency-Key` header, stored in `IdempotencyKey` with scope `mfc-listing`. A replay returns the stored listing id.
2. **Concurrency:** writes take `version` and run `UPDATE … WHERE id AND version` inside a transaction. A mismatch returns 409.
3. **Line guards**, where `active` means a listing with status ACTIVE, PARTIAL or CLAIMED:

   | Change | Allowed when |
   |---|---|
   | Lower `qtyKg` | New value ≥ the line's active `listedQtyKg` and ≥ its `collectedKg` |
   | Change `fitForHumans` | The line has no active link |
   | Delete the line | The line has no active link |

   A blocked change returns **409**: `{code:'LINE_LISTED', lineId, listedKg}`.
4. **Claim hooks:** when a claim on a linked item becomes COLLECTED or CANCELLED, write a `CLAIM_COLLECTED` or `CLAIM_CANCELLED` event.
   - Call the hook from the existing claim service after commit.
   - Never change claim behaviour.
   - A failing hook only logs.
5. **Audit:** mirror record saves and listing creation into `AuditLog` (area `MAKE_FOOD_COUNT`) for the admin audit view.
6. **No demo data in production:** `isDemo` is always false here. Demo comes from a separate demo organisation, if the client wants one.

## 9. Tests (Jest)

| Case | Expectation |
|---|---|
| UAT-02 | Chicken 5 fit, Beef 3 not, Fish 2 fit → 10 / 7 / 3 |
| UAT-03 | + Preparation 4 + Plate Scraps 2 → 16 / 7 / 9 |
| Validation | −1, "abc", 1.234, 501, unknown category, fit=true on Spoilage (forced false) |
| Idempotency | same `clientRequestId` twice → one record; listing replay → one listing |
| Concurrency | stale version → 409 |
| UAT-06 / 07 | prefill EDIBLE = 7 kg, NON_EDIBLE = 9 kg; second prefill after listing → 0 available |
| Guards | lower below listed → 409; untick a listed line → 409 |
| UAT-08 | publish, no collection → recovered 0; partial claim 4 kg COLLECTED → recovered 4 |
| States | expired / cancelled show in their buckets; buckets sum to notRecovered |
| Consolidated | master claim excluded, allocation counted |
| Reach (UAT-10) | territory manager passing another territory's ids gets them filtered out; charity user → 404 |
| Regression | listing creation without `foodRecord` unchanged (existing specs still pass) |

## 10. Deployment

1. Deploy the backend.
2. Run `npx prisma migrate deploy`.
3. Restart.

The migration is additive, so rollback means redeploying the previous build; the new tables can stay. There is no feature flag unless the client asks for a staged rollout. If one is added, it defaults to on, like `CONSOLIDATED_ENABLED`.
