# Make Food Count — Deployment Notes

## 1. Deploy

```
1. Deploy the backend.
2. npx prisma migrate deploy     # 20261117000000_make_food_count
3. Restart.
```

There is no feature flag. The endpoints simply do not exist until the build is
deployed, and no existing behaviour changes until the app starts sending the
optional `foodRecord` block on listing creation.

## 2. The migration

`20261117000000_make_food_count` is **additive and touches no existing table**:

| Check | Result |
|---|---|
| `DROP TABLE` / `DROP COLUMN` / `DROP CONSTRAINT` / `DROP TYPE` | none |
| `DELETE` / `TRUNCATE` statements | none |
| `ALTER COLUMN` / `SET NOT NULL` / `RENAME` | none |
| `ALTER TABLE` against an existing table | **none** |

It adds five tables — `food_records`, `food_record_lines`, `food_record_events`,
`food_record_listing_links`, `idempotency_keys` — four enums, and one value on
`AuditArea`.

Rollback means redeploying the previous build. The new tables can stay; nothing
else reads them.

**Never run `prisma migrate dev` against production.** It can offer to reset the
database. `migrate deploy` is the only safe command there.

## 3. What changes for existing behaviour

Listing creation gained two optional inputs:

- a `foodRecord` block in the body, and
- an `Idempotency-Key` header.

**With neither present, the endpoint behaves exactly as it did.** The existing
listing specs are unchanged and still pass.

When `foodRecord` is present, the links, events and audit row are written inside
the listing's own transaction — a listing that offers more than was recorded
should not exist at all.

Claim collection and cancellation now also write a food-record event. The hook
runs **after** the claim has been committed and only ever logs on failure:
Make Food Count observes collection, it must never be able to break it.

## 4. Smoke test

```bash
# No token → 401
curl -i $BASE/api/v1/mfc/taxonomy

# Business token → 200, with taxonomyVersion and limits
curl -s -H "Authorization: Bearer $BUSINESS_TOKEN" $BASE/api/v1/mfc/taxonomy | head

# Charity token → 404 (not 403 — the feature is invisible to receivers)
curl -i -H "Authorization: Bearer $CHARITY_TOKEN" $BASE/api/v1/mfc/taxonomy
```

Then the round trip:

```
POST /api/v1/mfc/records            { siteId, clientRequestId, sources }
PUT  /api/v1/mfc/records/:id/lines  { version, lines }
GET  /api/v1/mfc/records/:id        → totals, byKind, per-line status
POST /api/v1/mfc/records/:id/save   { version }
GET  /api/v1/mfc/records/:id/listing-prefill?kind=EDIBLE
```

Sending the same `clientRequestId` twice must return the **same** record id.

## 5. Verified, and not

**Verified:** 266 unit tests green, `tsc` clean, `nest build` clean, and
`test/mfc.contract.check.ts` passes with 12 bad payloads correctly rejected.

**Not verified:**

- The application has never been booted with this code, so DI resolution and
  routing are unproven.
- `test/mfc.e2e.ts` exercises the real services against a real database inside a
  transaction that is rolled back. It passes its reach checks and then needs the
  migration applied to go further.
- B5 insights have unit-tested arithmetic but no end-to-end run against data.

## 6. Open question for the client

The backend spec defers the taxonomy rows to the app spec §7, which is not in
this repository. The rows in `mfc.constants.ts` follow the **client's delivery
specification §5**, which also says "retain other approved V11 food category
options" for Overproduction and Preparation — and those are not listed anywhere
we hold.

Keys are stable and `TAXONOMY_VERSION` is served alongside them, so adding rows
later is a one-file change. Someone should still diff `mfc.constants.ts` against
the app's §7 before the app team builds screens against it.

`HOME_IMPACT_COUNTS_ALL_COLLECTIONS` in `mfc-insights.service.ts` is the switch
for client question 16: diverted currently counts every verified collection at
the site, not only food that came through Make Food Count.
