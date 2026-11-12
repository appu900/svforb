# Consolidated Collections — Deployment Notes

Read this before deploying or running migrations after pulling this change.

---

## 1. The feature is off by default

Everything is gated behind one environment variable:

```
CONSOLIDATED_ENABLED=true
```

**While it is unset, the feature is invisible.** All 44 endpoints under
`/api/v1/consolidated/*` return **404**, and the 5-minute sweep worker is not
scheduled. 404 rather than 403 is deliberate: a feature that is switched off
should look like it does not exist, not like something you are being kept out of.

Nothing changes for any existing user until somebody sets it. Pulling this
branch and deploying it is safe on its own.

To turn it on:

```bash
CONSOLIDATED_ENABLED=true npm run start:dev
```

On boot you should see:

```
Scheduled consolidated sweep every 5m
```

If you see `CONSOLIDATED_ENABLED is not set — sweep not scheduled.` instead,
the flag has not reached the process.

---

## 2. The migration is already applied to production

`20261112000000_consolidated_collections` was applied to the production
database on 12 November 2026. **Nobody needs to run it.**

`npx prisma migrate deploy` will correctly report nothing pending — 41 local
migrations, 41 applied, 0 pending, 0 failed.

The migration is **additive only**. It was generated offline with
`prisma migrate diff --from-schema --to-schema` (no database connection),
scanned for destructive statements, and applied with `migrate deploy`, which
only ever applies pending migrations:

| Check | Result |
|---|---|
| `DROP TABLE` / `DROP COLUMN` / `DROP CONSTRAINT` / `DROP TYPE` | none |
| `DELETE` / `TRUNCATE` statements | none |
| `ALTER COLUMN` / `SET NOT NULL` / `RENAME` | none |
| Row counts across 17 live tables, before vs after | identical |

It adds 11 tables and 13 enums, one value to `AuditArea`, and five columns to
existing tables — every one of them nullable or defaulted, so no existing row
was touched:

```sql
org_membership  ADD "canManageConsolidated" BOOLEAN NOT NULL DEFAULT false
food_listings   ADD "consolidatedRole"      NOT NULL DEFAULT 'STANDARD'
food_items      ADD "quantityDescription"   TEXT            -- nullable
food_claims     ADD "claimKind"             NOT NULL DEFAULT 'STANDARD',
                ADD "parentClaimId"         INTEGER         -- nullable
```

**Never run `prisma migrate dev` against production.** It can offer to reset
the database. `migrate deploy` is the only safe command there.

---

## 2a. A second migration is NOT yet applied

`20261113000000_consolidated_site_invitations` adds site invitations (accept /
decline before a site joins a group). It is additive only: one enum and six
columns on `consolidated_group_sites`, all nullable or defaulted to `ACCEPTED`,
so any existing row keeps working unchanged.

Apply it before (or with) the deploy that ships this code:

```bash
npx prisma migrate deploy
```

## 3. What existing behaviour changed

Twelve existing files gained filters from
`src/modules/consolidated/consolidated.filters.ts`, so that a consolidated
collection is counted once rather than as several listings, and its weight is
taken from the per-site allocations rather than from both those and the
charity-facing master claim.

Collection counts and kilogram totals deliberately filter on **opposite** claim
kinds. Filter them the same way and you either double every kilogram or report
one collection as N.

With the flag off, no row in the database has a non-`STANDARD`
`consolidatedRole` or `claimKind`, so every one of these filters is a no-op and
existing reporting is unchanged.

---

## 4. What is verified, and what is not

**Verified** — 205 unit tests, plus 67 end-to-end checks covering the whole
journey against a real database:

```
npx ts-node --transpile-only -P tsconfig.json test/consolidated.e2e.ts
```

That runs the real services inside one transaction which is rolled back at the
end, so it is safe to point at any database. It proves the happy path, the
double-counting guards, and that a contribution is never discoverable.

**Not yet verified:**

- The application has never been booted with this code. DI resolution, the
  guards and HTTP routing are unproven — the end-to-end test constructs the
  services by hand. **A staging boot with the flag on is the outstanding gap.**
- The sweep worker has never run.
- Twelve service methods have no coverage: `cancel`, `syncMaster`,
  `decideLate`, `decideChangeRequest`, `acknowledgeChange`, `exclude`,
  `reopenSubmissions`, `updateOccurrence`, `remind`, `archive`, `setSites`
  and `end`.
- No Swagger decorators on the 44 endpoints yet.

---

## 5. Rollback

Turn the flag off. The endpoints return 404 again and the sweep stops being
scheduled. The tables stay, holding whatever was recorded while it was on.

There is no need to roll the migration back, and doing so would drop data.
