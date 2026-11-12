# Consolidated Collections — Backend Implementation Guide (svforb, NestJS + Prisma)

> Read `docs/consolidated-collections/SPEC.md` first. This guide gives the **step-by-step build order**
> for the backend. Do the steps in order. Each step ends with an **Acceptance** check. Do not start the
> next step until it passes (`npm run build` + relevant tests).
>
> Stack facts (verified in this repo):
> - NestJS 11, Prisma 7 (`prisma/schema.prisma`, migrations in `prisma/migrations`), PostgreSQL + PostGIS
> - BullMQ queues (`src/infra/queues/queus.constants.ts`, pattern in `src/modules/connections/queues/connection.queue.service.ts`)
> - Auth: `JwtAuthGuard`; `req.user` is `Jwtpayload` (`src/modules/auth/interface/jwt.interface.ts`: `sub, orgId, orgType, orgRole, enterpriseRole, siteId, siteRole`)
> - View-only guard: `assertNotViewOnly(caller)` in `src/modules/enterprise/enterprise.permissions.ts`
> - Enterprise snapshot: `enterpriseScope.snapshotForSite(siteId)` (used in `FoodListingService.createListing`)
> - Timezone and schedule helpers: `src/modules/connections/connection.schedule.ts` (`assertValidTimezone`, `instantForLocalTime`, `localDateAt`, `isoWeekdayOf`, `parseLocalTime`)
> - Push: `NotificationService.send({ title, body, data, targetUserIds, priority, allowEmptyTargets })` (see `ClaimsService.notifyRestaurantCollected`)
> - Audit: `AuditLog` model (needs `organisationId, actorName, actorEmail, area, action, entityType, entityId, summary, previousValue, newValue`)
>
> **Naming:** never reuse `Cluster*`, `EnterpriseGroup`, `GroupSite`. Everything new is `Consolidated*`.

---

## B0. Module skeleton

Create `src/modules/consolidated/`:

```
consolidated/
  consolidated.module.ts
  consolidated.constants.ts          # declarations, thresholds, horizon, reasons
  consolidated.errors.ts             # small helpers for 400/403/404/409 messages
  dto/
    group.dto.ts  schedule.dto.ts  collection.dto.ts  contribution.dto.ts
    receipt.dto.ts  item-check.dto.ts  report.dto.ts  permission.dto.ts
  controllers/
    consolidated-access.controller.ts      # /consolidated/me, /declarations, /permissions
    consolidated-groups.controller.ts      # /consolidated/groups, /points
    consolidated-collections.controller.ts # /consolidated/schedules, /collections
    consolidated-contributions.controller.ts # /consolidated/sites/.., /contributions, /change-requests
    consolidated-charity.controller.ts     # /consolidated/charity/...
    consolidated-reports.controller.ts     # /consolidated/reports
  services/
    consolidated-access.service.ts         # every permission check lives here
    consolidated-audit.service.ts
    consolidated-group.service.ts
    consolidated-schedule.service.ts       # recurrence → occurrences (pure helpers in schedule.ts)
    consolidated-schedule.ts               # PURE functions, unit tested
    consolidated-collection.service.ts     # lifecycle: open/close/cancel/publish
    consolidated-contribution.service.ts   # site create/edit/withdraw/handover, late, change requests
    consolidated-receipt.service.ts        # receipt / exclude
    consolidated-publish.service.ts        # build + sync master listing
    consolidated-material-change.ts        # PURE diff → material or not, unit tested
    consolidated-completion.service.ts     # charity item check → allocations
    consolidated-notifier.service.ts       # all pushes for this feature
    consolidated-report.service.ts
  queues/consolidated.queue.service.ts
  workers/consolidated.worker.ts
```

Register `ConsolidatedModule` in `src/app.module.ts`. Import `EnterpriseModule` (snapshot and permissions),
the notification module (for `NotificationService`), `S3Module` (photos), `FoodListingModule` (export
`ListingQueueService` from it if needed for the NEW_LISTING enqueue) and `BullModule.registerQueue({ name: QUEUE_NAMES.CONSOLIDATED })`.

**Acceptance:** `npm run build` passes and the app boots.

---

## B1. Database schema (one migration: `consolidated_collections`)

Add to `prisma/schema.prisma`. Keep it **additive** (no drops, all new columns nullable or defaulted).

```prisma
// ─── Enums ─────────────────────────────────────────────────────────────
enum ConsolidatedListingRole { STANDARD CONTRIBUTION MASTER }
enum ClaimKind { STANDARD CONSOLIDATED_MASTER CONSOLIDATED_ALLOCATION }
enum ConsolidatedMemberRole { MANAGER RECEIVER }
enum ConsolidatedHandoverMethod { SITE_DROP_OFF INTERNAL_COLLECTION }
enum ConsolidatedRecurrence { ONE_OFF DAILY WEEKLY SELECTED_WEEKDAYS CUSTOM_DATES }
enum ConsolidatedScheduleStatus { ACTIVE ENDED }
enum ConsolidatedCollectionStatus {
  SCHEDULED OPEN SUBMISSIONS_CLOSED PUBLISHED CLAIMED AWAITING_ITEM_CHECK COMPLETED CANCELLED EXPIRED
}
enum ConsolidatedContributionStatus {
  SUBMITTED LATE_PENDING_APPROVAL REJECTED_LATE WITHDRAWN HANDED_OVER RECEIVED NOT_RECEIVED
  EXCLUDED NO_CONTRIBUTION COMPLETED CANCELLED
}
enum ConsolidatedReceiptStatus { PENDING RECEIVED NOT_RECEIVED }
enum ConsolidatedItemOutcome {
  PENDING ACCEPTED PARTIALLY_ACCEPTED REJECTED UNAVAILABLE NOT_RECEIVED EXCLUDED CANCELLED
}
enum ConsolidatedDeclarationType { SITE MANAGER CHARITY }
enum ConsolidatedRejectionReason {
  QUALITY TEMPERATURE PACKAGING_DAMAGED PAST_DATE NOT_AS_DESCRIBED CANNOT_TRANSPORT CANNOT_STORE OTHER
}
enum ConsolidatedChangeRequestStatus { PENDING APPROVED REJECTED CANCELLED }

// add to existing enum AuditArea:
//   CONSOLIDATED_COLLECTIONS

// ─── Additions to existing models ───────────────────────────────────────
// OrgMemeberShip:
//   canManageConsolidated Boolean @default(false)
// FoodListing:
//   consolidatedRole ConsolidatedListingRole @default(STANDARD)
//   @@index([consolidatedRole])
//   + back-relations: consolidatedContribution ConsolidatedContribution?  @relation("ContributionListing")
//                     consolidatedMasterOf    ConsolidatedCollection?    @relation("MasterListing")
// FoodItem:
//   quantityDescription String?        // "12 trays" — display only
//   + back-relations for ConsolidatedItem (source + master)
// FoodClaim:
//   claimKind     ClaimKind @default(STANDARD)
//   parentClaimId Int?                 // allocation → master claim
//   parentClaim   FoodClaim?  @relation("ClaimAllocations", fields: [parentClaimId], references: [id])
//   allocations   FoodClaim[] @relation("ClaimAllocations")
//   @@index([claimKind])
//   @@index([parentClaimId])
// Organisation / Site / User: add the back-relation fields Prisma asks for.

// ─── New models ─────────────────────────────────────────────────────────
model ConsolidatedGroup {
  id             Int          @id @default(autoincrement())
  organisationId Int
  organisation   Organisation @relation(fields: [organisationId], references: [id], onDelete: Cascade)
  name           String
  description    String?
  hostSiteId     Int
  hostSite       Site         @relation("ConsolidatedHostSite", fields: [hostSiteId], references: [id])
  timezone       String       // IANA; defaults to host site timezone
  isActive       Boolean      @default(true)
  archivedAt     DateTime?
  createdByUserId Int
  points      ConsolidatedCollectionPoint[]
  sites       ConsolidatedGroupSite[]
  members     ConsolidatedGroupMember[]
  schedules   ConsolidatedSchedule[]
  collections ConsolidatedCollection[]
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@unique([organisationId, name])
  @@index([organisationId, isActive])
  @@map("consolidated_groups")
}

model ConsolidatedCollectionPoint {
  id         Int               @id @default(autoincrement())
  groupId    Int
  group      ConsolidatedGroup @relation(fields: [groupId], references: [id], onDelete: Cascade)
  name       String            // "Loading Dock B"
  address    String
  postcode   String?
  lat        Float
  lng        Float
  directions String?
  isDefault  Boolean @default(false)
  isActive   Boolean @default(true)
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt
  @@index([groupId])
  @@map("consolidated_collection_points")
}

model ConsolidatedGroupSite {
  id        Int               @id @default(autoincrement())
  groupId   Int
  group     ConsolidatedGroup @relation(fields: [groupId], references: [id], onDelete: Cascade)
  siteId    Int
  site      Site              @relation(fields: [siteId], references: [id], onDelete: Cascade)
  addedAt   DateTime @default(now())
  addedBy   Int
  removedAt DateTime?          // soft removal keeps history
  @@unique([groupId, siteId])
  @@index([siteId])
  @@map("consolidated_group_sites")
}

model ConsolidatedGroupMember {
  id        Int                    @id @default(autoincrement())
  groupId   Int
  group     ConsolidatedGroup      @relation(fields: [groupId], references: [id], onDelete: Cascade)
  userId    Int
  user      User                   @relation(fields: [userId], references: [id], onDelete: Cascade)
  role      ConsolidatedMemberRole
  addedAt   DateTime @default(now())
  addedBy   Int
  @@unique([groupId, userId, role])
  @@index([userId])
  @@map("consolidated_group_members")
}

model ConsolidatedSchedule {
  id                Int                        @id @default(autoincrement())
  groupId           Int
  group             ConsolidatedGroup          @relation(fields: [groupId], references: [id], onDelete: Cascade)
  collectionPointId Int
  method            ConsolidatedHandoverMethod
  recurrence        ConsolidatedRecurrence
  status            ConsolidatedScheduleStatus @default(ACTIVE)
  timezone          String
  startDate         DateTime                   // local date normalised to UTC midnight
  endDate           DateTime?
  daysOfWeek        Int[]     @default([])     // 1=Mon..7=Sun
  customDates       DateTime[] @default([])
  opensDaysBefore   Int       @default(0)
  submissionsCloseMinutes Int                  // local minutes past midnight
  handoverStartMinutes    Int
  handoverEndMinutes      Int
  pickupStartMinutes      Int
  pickupEndMinutes        Int
  contactName       String
  contactPhone      String
  instructions      String?
  suitabilityNotes  String
  participatingSiteIds Int[] @default([])     // empty = all active group sites
  generatedUntil    DateTime?                  // last local date materialised
  createdByUserId   Int
  collections       ConsolidatedCollection[]
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@index([groupId, status])
  @@map("consolidated_schedules")
}

model ConsolidatedCollection {
  id                Int                          @id @default(autoincrement())
  organisationId    Int
  groupId           Int
  group             ConsolidatedGroup            @relation(fields: [groupId], references: [id], onDelete: Cascade)
  scheduleId        Int?
  schedule          ConsolidatedSchedule?        @relation(fields: [scheduleId], references: [id], onDelete: SetNull)
  collectionPointId Int
  // snapshot of the point at generation/edit time (point edits must not rewrite history)
  pointName     String
  pointAddress  String
  pointPostcode String?
  pointLat      Float
  pointLng      Float
  pointDirections String?
  method            ConsolidatedHandoverMethod
  status            ConsolidatedCollectionStatus @default(SCHEDULED)
  timezone          String
  scheduledDate     DateTime                     // local date at UTC midnight
  opensAt           DateTime
  submissionsCloseAt DateTime
  reopenedUntil     DateTime?
  handoverStartAt   DateTime
  handoverEndAt     DateTime
  pickupStartAt     DateTime
  pickupEndAt       DateTime
  contactName       String
  contactPhone      String
  instructions      String?
  suitabilityNotes  String
  participatingSiteIds Int[] @default([])        // resolved at generation
  isDetached        Boolean  @default(false)     // edited individually → series edits skip it
  // lifecycle stamps (also used for sweep idempotency)
  openedAt          DateTime?
  closingReminderAt DateTime?
  closedAt          DateTime?
  overdueAlertAt    DateTime?
  publishedAt       DateTime?
  publishedByUserId Int?
  masterListingId   Int?     @unique
  masterListing     FoodListing? @relation("MasterListing", fields: [masterListingId], references: [id])
  claimedAt         DateTime?
  pickupReminderAt  DateTime?
  itemCheckReminderAt DateTime?
  completedAt       DateTime?
  cancelledAt       DateTime?
  cancelledByUserId Int?
  cancelReason      String?
  expiredAt         DateTime?
  version           Int      @default(1)        // bumps on every charity-visible change
  contributions     ConsolidatedContribution[]
  items             ConsolidatedItem[]
  declarations      ConsolidatedDeclaration[]
  changes           ConsolidatedChange[]
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@unique([scheduleId, scheduledDate])
  @@index([organisationId, status])
  @@index([groupId, scheduledDate])
  @@index([status, opensAt])
  @@index([status, submissionsCloseAt])
  @@index([status, pickupEndAt])
  @@map("consolidated_collections")
}

model ConsolidatedContribution {
  id             Int                            @id @default(autoincrement())
  collectionId   Int
  collection     ConsolidatedCollection         @relation(fields: [collectionId], references: [id], onDelete: Cascade)
  siteId         Int
  site           Site                           @relation(fields: [siteId], references: [id])
  listingId      Int?                           @unique   // null only for NO_CONTRIBUTION rows
  listing        FoodListing?                   @relation("ContributionListing", fields: [listingId], references: [id])
  status         ConsolidatedContributionStatus
  isLate         Boolean  @default(false)
  submittedAt    DateTime?
  submittedByUserId Int?
  lateDecidedAt  DateTime?
  lateDecidedByUserId Int?
  lateDecisionReason String?
  withdrawnAt    DateTime?
  withdrawReason String?
  handoverAt     DateTime?
  handoverByUserId Int?
  receiptStatus  ConsolidatedReceiptStatus @default(PENDING)
  receiptAt      DateTime?
  receiptByUserId Int?
  receiptNote    String?
  excludedAt     DateTime?
  excludedByUserId Int?
  excludeReason  String?
  allocationClaimId Int? @unique
  changeRequests ConsolidatedChangeRequest[]
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@unique([collectionId, siteId])
  @@index([siteId])
  @@map("consolidated_contributions")
}

/// Traceability ledger, one row per SOURCE food item (R19)
model ConsolidatedItem {
  id                Int                     @id @default(autoincrement())
  collectionId      Int
  collection        ConsolidatedCollection  @relation(fields: [collectionId], references: [id], onDelete: Cascade)
  contributionId    Int
  siteId            Int
  sourceFoodItemId  Int                     @unique
  sourceFoodItem    FoodItem                @relation("ConsolidatedSourceItem", fields: [sourceFoodItemId], references: [id])
  masterFoodItemId  Int?                    @unique
  masterFoodItem    FoodItem?               @relation("ConsolidatedMasterItem", fields: [masterFoodItemId], references: [id])
  name              String
  category          String?
  submittedQtyKg    Float
  verifiedQtyKg     Float?
  acceptedQtyKg     Float?
  rejectedQtyKg     Float?
  unavailableQtyKg  Float?
  rejectionReason   ConsolidatedRejectionReason?
  rejectionNote     String?
  outcome           ConsolidatedItemOutcome @default(PENDING)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@index([collectionId])
  @@index([contributionId])
  @@index([siteId])
  @@map("consolidated_items")
}

model ConsolidatedDeclaration {
  id             Int                         @id @default(autoincrement())
  collectionId   Int
  collection     ConsolidatedCollection      @relation(fields: [collectionId], references: [id], onDelete: Cascade)
  contributionId Int?
  claimId        Int?
  type           ConsolidatedDeclarationType
  version        String
  textSnapshot   String
  userId         Int
  organisationId Int
  acceptedAt     DateTime @default(now())
  ipAddress      String?
  userAgent      String?
  @@index([collectionId, type])
  @@map("consolidated_declarations")
}

/// Charity-visible change after claim (R11)
model ConsolidatedChange {
  id             Int                    @id @default(autoincrement())
  collectionId   Int
  collection     ConsolidatedCollection @relation(fields: [collectionId], references: [id], onDelete: Cascade)
  fromVersion    Int
  toVersion      Int
  isMaterial     Boolean
  reasons        String[]               // e.g. ["PICKUP_TIME","QTY_DROP_GT_20"]
  summary        String                 // neutral text shown to charity
  before         Json
  after          Json
  createdByUserId Int
  notifiedAt     DateTime?
  acknowledgedAt DateTime?
  acknowledgedByUserId Int?
  createdAt DateTime @default(now())
  @@index([collectionId])
  @@map("consolidated_changes")
}

/// Site edit after publish needing manager approval (R6/R7)
model ConsolidatedChangeRequest {
  id             Int                             @id @default(autoincrement())
  contributionId Int
  contribution   ConsolidatedContribution        @relation(fields: [contributionId], references: [id], onDelete: Cascade)
  collectionId   Int
  requestedByUserId Int
  payload        Json                            // validated UpdateContributionDto
  status         ConsolidatedChangeRequestStatus @default(PENDING)
  decidedByUserId Int?
  decidedAt      DateTime?
  decisionReason String?
  createdAt DateTime @default(now())
  @@index([collectionId, status])
  @@map("consolidated_change_requests")
}
```

Then run `npx prisma migrate dev --name consolidated_collections` and `npx prisma generate`.

**Acceptance:** the migration applies on a fresh DB and on a copy of staging. All existing rows get
`consolidatedRole=STANDARD` and `claimKind=STANDARD`. `npm run build` passes.

---

## B2. Constants and pure helpers

`consolidated.constants.ts`:
```ts
export const CONSOLIDATED_HORIZON_DAYS = 14;
export const CONSOLIDATED_SWEEP_EVERY_MS = 5 * 60_000;
export const CLOSING_REMINDER_MINUTES = 60;
export const PICKUP_REMINDER_MINUTES = 30;
export const ITEM_CHECK_REMINDER_HOURS = 24;
export const MATERIAL_QTY_DROP_PCT = 20;        // R11, make org-configurable in Phase 2
export const MATERIAL_CATEGORY_DROP_PCT = 20;
export const MAX_MASTER_PHOTOS = 5;
export const DECLARATIONS = {
  SITE:    { version: 'v1', text: '<exact SITE text from SPEC §6>' },
  MANAGER: { version: 'v1', text: '<exact MANAGER text from SPEC §6>' },
  CHARITY: { version: 'v1', text: '<exact CHARITY text from SPEC §6>' },
} as const;
```
Add `CONSOLIDATED: 'queue.consolidated'` to `QUEUE_NAMES` and a `CONSOLIDATED_JOBS = { SWEEP: 'consolidated.sweep' }`.

`consolidated-schedule.ts` (PURE, no DB; reuse `connection.schedule.ts` helpers):
- `validateScheduleInput(input)` → throws `BadRequestException` for: invalid timezone; bad `HH:mm`;
  the time order in SPEC A6; `startDate` in the past; `endDate < startDate`; WEEKLY / SELECTED_WEEKDAYS
  without `daysOfWeek` (WEEKLY = exactly one day); CUSTOM_DATES empty or with past dates; more than 366 custom dates.
- `occurrenceDates(schedule, fromLocalDate, toLocalDate): Date[]` → local dates per recurrence:
  ONE_OFF = `[startDate]`; DAILY = every day; WEEKLY / SELECTED_WEEKDAYS = matching ISO weekdays;
  CUSTOM_DATES = `customDates` in range. Always clip to `[startDate, endDate]`.
- `resolveOccurrence(schedule, localDate)` → `{ opensAt, submissionsCloseAt, handoverStartAt, handoverEndAt, pickupStartAt, pickupEndAt }`
  using `instantForLocalTime(timezone, localDate, minutes)`. `opensAt` = local 00:00 of `localDate - opensDaysBefore`.

`consolidated-material-change.ts` (PURE):
```ts
type Snapshot = { pointName; pointAddress; pickupStartAt; pickupEndAt;
  storage: {refrigeration,ambient,freezer,hot,reheating}; allergens: string[];
  items: { key: string; name: string; category: string|null; qtyKg: number }[] };
export function diffMaterial(before: Snapshot, after: Snapshot): { isMaterial: boolean; reasons: string[]; summary: string }
```
Reasons: `LOCATION`, `PICKUP_TIME`, `HANDLING` (storage or allergens changed), `QTY_DROP_GT_20`
(total after < total before × 0.8), `ITEM_REMOVED`, `CATEGORY_DROP_GT_20` (per category, before → after).
`summary` is neutral charity text, e.g. "Pickup time changed to 2:30–3:00 pm. Total reduced from 18 kg to 12 kg."
Never include site names.

**Tests (`*.spec.ts`, required):**
- DST: a Melbourne weekly schedule across the first Sunday of October / April keeps 2:00 pm local.
- Each recurrence type produces the right dates. A horizon window works. `endDate` clips.
- Validation rejects each bad order.
- diffMaterial: a 19% drop is not material, 21% is; a removed item is material even at 5% weight; an allergen
  added is material; only a notes change is not material.

---

## B3. Access service (all permission logic in one place)

`ConsolidatedAccessService` methods (each throws `ForbiddenException` / `NotFoundException`):

| Method | Rule |
|---|---|
| `assertProductAccess(caller)` | **The single commercial gate for this feature (R4).** Today it is effectively a no-op: the global `SubscriptionInterceptor` already returns 402 for any billable org without a live plan, and R4 puts Consolidated Collections on every paid plan with no module condition. It exists so the commercial rule has **one** home. Every public entry point (controller method) calls it first, before any role or scope check. |
| `canManageFlag(caller)` | `orgRole === SUPER_ADMIN` OR membership `canManageConsolidated = true` AND (`orgRole in [SUPER_ADMIN, ORG_ADMIN]` OR the user has ≥1 `siteAccess` with `SITE_ADMIN`). Also `assertNotViewOnly`. |
| `callerSiteIds(caller)` | `null` = all org sites (SUPER_ADMIN/ORG_ADMIN); otherwise the siteIds from `siteAccess` for this org |
| `assertCanCreateGroup(caller, siteIds)` | `canManageFlag`, and every site is in the caller's org, active, and (Site Admin) within `callerSiteIds` |
| `assertManager(caller, groupId)` | group.org = caller.org AND (SUPER_ADMIN OR (member role MANAGER AND `canManageFlag`)). A Site Admin manager's access must also still cover all **active** group sites. |
| `assertReceiver(caller, groupId)` | manager OR member role RECEIVER |
| `assertSiteUser(caller, siteId)` | SUPER_ADMIN of the org, or `siteAccess(userId, siteId)` exists. Not view-only. |
| `assertSiteParticipates(collection, siteId)` | siteId ∈ `collection.participatingSiteIds` |
| `assertCharityOwnsClaim(caller, claimId)` | claim.claimantOrgId = caller.orgId AND claim.claimKind = CONSOLIDATED_MASTER |
| `meSummary(caller)` | builds `/consolidated/me` |

**Why `assertProductAccess` exists even though it does nothing today.** Commercial rules change far more often than permission rules. S4B is moving to module-based pricing, and R4 is a decision that could be revisited. Routing every entry point through one method means that change is a single edit with a single test, instead of an audit of every controller. Do not inline “no check needed” — call it.

Permissions endpoints (`/consolidated/permissions`, `PATCH /permissions/:userId`): org owner only. The target must be
an Org Admin or have a SITE_ADMIN site access, otherwise 400 "User must be an Org Admin or Site Admin". When the flag is
removed, delete their MANAGER memberships (audit it).

**Tests:** a site admin cannot add a site outside their access; another org's group gives 404; staff cannot
publish; a receiver can only call receipt; a view-only enterprise role gets 403; every controller method
calls `assertProductAccess` first (assert on the spy, so a new endpoint that forgets it fails the suite).

---

## B4. Audit service

`ConsolidatedAuditService.log(tx, { caller, action, entityType, entityId, entityLabel, previous?, next?, summary })`
writes an `AuditLog` row with `area = CONSOLIDATED_COLLECTIONS`, the actor name/email looked up once per request,
and the ip/userAgent if available (pass `req` from the controllers).

Action slugs (use exactly these):
`group.created, group.updated, group.archived, group.sites_changed, group.members_changed, point.created,
point.updated, permission.changed, schedule.created, schedule.updated, schedule.ended,
collection.generated, collection.updated, collection.opened, collection.closed, collection.reopened,
collection.cancelled, collection.published, collection.republished, collection.claimed,
collection.claim_cancelled, collection.completed, collection.expired, contribution.submitted,
contribution.late_submitted, contribution.late_approved, contribution.late_rejected,
contribution.updated, contribution.withdrawn, contribution.handover, contribution.receipt,
contribution.excluded, change_request.created, change_request.approved, change_request.rejected,
change.material_created, change.acknowledged, item_check.submitted, reminder.sent`.

All state-changing service methods run in a `prisma.$transaction` and log inside it.

---

## B5. Groups and points (SPEC §7.2)

`ConsolidatedGroupService` + controller. Implementation notes:
- `create`: validate via `assertCanCreateGroup`; `hostSiteId ∈ siteIds`; `timezone` = dto ?? `hostSite.timezone`
  (IANA, nullable on `Site`; resolve with `resolveDonorTimezone` from connection.schedule, and if it is still null
  return 400 "Set a timezone for the host site or the group") — then `assertValidTimezone`. Create the group, the default point (`isDefault=true`),
  sites, and members (the creator is always a MANAGER). Every manager user must pass `canManageFlag`. Receivers just need to be
  in the org.
- `PUT sites`: set `removedAt` on removed rows (and clear it on re-added rows); never hard delete. If removing the host site,
  require a new `hostSiteId`. Future SCHEDULED collections update `participatingSiteIds`; OPEN or later keep their snapshot.
- `archive`: 409 if any collection is OPEN/SUBMISSIONS_CLOSED/PUBLISHED/CLAIMED/AWAITING_ITEM_CHECK. Otherwise
  set `isActive=false, archivedAt`, end active schedules, and cancel future SCHEDULED collections.
- `eligible-sites`: active org sites ∩ `callerSiteIds`.
- `eligible-users`: org members with `{ id, name, email, orgRole, isSiteAdmin, canManage }`.
- List response: `{ id, name, hostSite, siteCount, pointCount, nextCollection: { id, scheduledDate, status } | null, isActive }`.

**Acceptance (e2e or manual via Swagger):** create → get → update sites → archive works; the audit rows exist;
cross-org and out-of-scope calls fail.

---

## B6. Schedules and occurrence generation (SPEC §7.3, R8, A4–A6)

`ConsolidatedScheduleService`:
- `create(caller, dto)`: `assertManager(groupId)`; the point belongs to the group and is active; `participatingSiteIds`
  ⊆ the active group sites (empty → all). Run `validateScheduleInput`. Save the schedule and call
  `generate(schedule, today, today + HORIZON)` inside the same transaction. Notify `consolidated_scheduled` (B12).
- `generate(schedule, from, to)`: for each `occurrenceDates` date with no row, insert a `ConsolidatedCollection`
  with the point snapshot, resolved instants, `participatingSiteIds` resolved now, and status `SCHEDULED`
  (or `OPEN` if `opensAt <= now`). `@@unique([scheduleId, scheduledDate])` makes it idempotent. Update `generatedUntil`.
- `update(caller, id, dto)`: validate, save, then for future collections of this schedule with status
  SCHEDULED/OPEN and `isDetached=false`: recompute the times, point snapshot and fields. Delete (cancel) occurrences
  that no longer match the recurrence **only if they have no contributions** (otherwise cancel with notification).
  Generate new ones. Notify the affected sites.
- `end(caller, id, fromDate)`: status ENDED, `endDate=fromDate-1`; cancel future collections ≥ fromDate (B7 cancel logic).
- Collection `PATCH /collections/:id` (single occurrence): sets `isDetached=true`; re-validate time order;
  if CLAIMED/AWAITING_ITEM_CHECK → run the material-change flow (B10.3). If PUBLISHED → sync the master listing (B9.2).

**Acceptance:** creating a "weekdays Mon/Wed/Fri" schedule generates the correct rows for 14 days; editing the time
updates future rows only; detached rows are untouched; DST spec tests pass.

---

## B7. Collection lifecycle and sweeps

### B7.1 Manager actions (`ConsolidatedCollectionService`)
- `closeSubmissions(id)`: OPEN → SUBMISSIONS_CLOSED, `closedAt`. For each participating site without a contribution
  row, create `NO_CONTRIBUTION` (listingId null). Clear `reopenedUntil`.
- `reopenSubmissions(id, until)`: allowed from SUBMISSIONS_CLOSED, and only when not published and `until <= handoverEndAt`.
  → OPEN with `reopenedUntil`. Delete NO_CONTRIBUTION rows (they are recreated at the next close).
  After publish → 409 "Already published — sites must use a change request or late contribution".
- `cancel(id, reason)`: any non-final status. In one transaction: status CANCELLED + stamps; all non-final contributions →
  CANCELLED; their listings → `ListingStatus.CANCELLED`; ledger outcome CANCELLED; master listing (if any) → CANCELLED;
  an active master claim → `ClaimStatus.CANCELLED` (and cancel an active driver pickup the same way the existing
  `ClaimsService.cancelClaim` does — call the shared helper, don't duplicate it). Notify sites, receivers, and the charity
  if claimed (neutral text). **Never** create direct listings (R9).
- `remind(id, siteIds?)`: push to users of those sites; stamp an audit `reminder.sent`.

### B7.2 Sweep worker (BullMQ repeatable, every 5 min; copy the `ConnectionQueueService.onModuleInit` pattern including
removing stale repeatables)
Each step is idempotent (guarded by the stamp column) and batched (≤500 rows):
1. **Generate:** for ACTIVE schedules with `generatedUntil < today + HORIZON` → `generate`.
2. **Open:** SCHEDULED with `opensAt <= now` → OPEN, `openedAt`.
3. **Closing reminder:** OPEN, `closingReminderAt is null`, `submissionsCloseAt - 60min <= now` → push to sites with
   no contribution; stamp.
4. **Auto-close:** OPEN, `now >= coalesce(reopenedUntil, submissionsCloseAt)` → `closeSubmissions`.
5. **Overdue handover:** `overdueAlertAt is null`, `now >= handoverEndAt`, status in (OPEN, SUBMISSIONS_CLOSED) → contributions
   still SUBMITTED → push to managers + those sites; stamp.
6. **Pickup reminder:** CLAIMED, `pickupReminderAt is null`, `pickupStartAt - 30min <= now` → push to charity users of the claimant site +
   receivers; stamp.
7. **Expire:** status in (OPEN, SUBMISSIONS_CLOSED, PUBLISHED), `now > pickupEndAt` → EXPIRED; master listing → EXPIRED;
   all non-final contributions keep their listing but mark it `ListingStatus.EXPIRED`; ledger outcome stays non-redistributed.
   Notify managers.
8. **Item-check reminder:** AWAITING_ITEM_CHECK, `itemCheckReminderAt is null`, `now > pickupEndAt + 24h` → push to charity +
   managers; stamp.

Make the existing listing expiry sweep (`listing.worker.ts`, `SWEEP_EXPIRED_LISTINGS` and `EXPIRE_LISTING`) **skip**
`consolidatedRole in (CONTRIBUTION, MASTER)`. This module owns their lifecycle.

**Tests:** a sweeper run twice changes nothing the second time; close creates NO_CONTRIBUTION rows; cancel cascades.

---

## B8. Site contributions (SPEC §7.4, R5–R7, SM1–SM4)

`ConsolidatedContributionService`:

### B8.1 `GET /sites/:siteId/open-collections`
`assertSiteUser`; collections in the caller org where the site ∈ `participatingSiteIds`, status OPEN (or reopened), and
no existing contribution for this site that is not WITHDRAWN. Also return collections closed < handoverEndAt as
`lateAllowed: true` (the UI shows "Submit late (needs approval)"). Response items:
`{ id, groupName, point:{name,address}, method, scheduledDate, submissionsCloseAt, handoverStartAt, handoverEndAt, pickupStartAt, pickupEndAt, suitabilityNotes, instructions, lateAllowed, timezone }`.

### B8.2 `POST /collections/:id/contributions`
1. `assertSiteUser(dto.siteId)`, `assertSiteParticipates`, status OPEN, or SUBMISSIONS_CLOSED/PUBLISHED/CLAIMED with
   `now < pickupStartAt` (→ late). Otherwise 409.
2. Declaration: `dto.declaration.version === DECLARATIONS.SITE.version && accepted === true` else 400.
3. Upsert guard: an existing WITHDRAWN row for this site → reuse the row (new listing). Any other existing row → 409 "Already
   contributed — edit your contribution instead".
4. **Refactor first:** extract the body of `FoodListingService.createListing` into
   `createListingRecord(tx, caller, input, opts: { consolidatedRole, skipDiscovery: boolean })` and keep `createListing`
   calling it unchanged. For contributions call it with:
   `consolidatedRole=CONTRIBUTION`, `listingType=HUMAN`, `recoveryPathway=FOOD_FOR_PEOPLE`,
   `pickupAddress/lat/lng/postcode` = collection point snapshot, `pickupFromTime=pickupStartAt`, `pickupByTime=pickupEndAt`,
   `bestBefore` = dto (do **not** derive from the event — SPEC), `skipDiscovery=true` → **do not** call `enqueueNewListing`,
   **do not** enqueue the listing expiry, and **do not** invalidate the nearby cache.
   FoodItems save `quantityDescription`.
5. Create the contribution: `SUBMITTED` (or `LATE_PENDING_APPROVAL` + `isLate=true`), `submittedAt` (server), and `submittedByUserId`.
   Create a `ConsolidatedItem` per FoodItem (`submittedQtyKg`).
6. Create a `ConsolidatedDeclaration(type SITE, contributionId, version, textSnapshot)`.
7. ListingActivity row: eventType `consolidated contribution`, message "Added to collection at <point> on <date>".
8. Audit + notify (late → managers `consolidated_late_request`).
9. If the collection is already PUBLISHED/CLAIMED and the late item is approved later, see B8.5.

### B8.3 `PATCH /contributions/:id`
- The site user of that site, or a manager.
- Status SUBMITTED/HANDED_OVER/LATE_PENDING_APPROVAL **and** the collection is not yet published → apply directly: update the listing
  fields + items (add/remove/update FoodItems, keeping the `ConsolidatedItem` rows in sync; a removed item's ledger row is deleted
  since nothing is verified yet). If the contribution was already RECEIVED, reset the receipt to PENDING (food changed after
  verification; the manager must re-verify). Audit `contribution.updated` with before/after.
- Collection published or claimed → create `ConsolidatedChangeRequest(payload=dto)`; notify managers; return
  `{ changeRequestId, status:'PENDING_APPROVAL' }`.
- Manager edits after publish skip the request and apply directly through B8.5.

### B8.4 `withdraw`, `handover`
- `withdraw`: only before publish, status SUBMITTED/HANDED_OVER/LATE_PENDING_APPROVAL → WITHDRAWN; listing CANCELLED; ledger rows
  deleted. After publish → 409 "Ask your manager to exclude it".
- `handover`: site user; status SUBMITTED (not late-pending); collection OPEN or SUBMISSIONS_CLOSED or PUBLISHED; now ≥
  `handoverStartAt - 2h` (allow early). → HANDED_OVER, `handoverAt=now()`, `handoverByUserId`. The response includes the method label.
  Notify managers + receivers `consolidated_handover`. Calling it again → 200 no-op.

### B8.5 Late approval and change requests (manager)
- `approve-late`: LATE_PENDING_APPROVAL → SUBMITTED. If the collection is PUBLISHED/CLAIMED it still needs receipt before it joins the master
  listing (B9.2 sync happens after receipt).
- `reject-late`: → REJECTED_LATE; listing CANCELLED; notify the site.
- `change-requests/:id/approve`: apply the payload as in B8.3 (direct path), then reset the receipt to PENDING if quantities went
  **up** or new items were added (verify again). If they went **down**, set `verifiedQtyKg = min(verified, new)` automatically.
  Then `PublishService.syncMaster(collectionId, caller)` (B9.2) → it handles material-change detection when claimed.
- `reject`: status REJECTED + reason; notify the site.

**Acceptance:** contribution listings never appear in `GET /food-listings/nearby` or `/notifications` inbox,
receive no push fan-out, and cannot be claimed (B9.4). A site user cannot read another site's contribution (404).

---

## B9. Receipt, publish, master listing, claim

### B9.1 Receipt and exclude (`ConsolidatedReceiptService`)
- `receipt(id, dto)`: `assertReceiver(group)`. Contribution status SUBMITTED/HANDED_OVER/RECEIVED/NOT_RECEIVED
  (re-recording is allowed until published; after publish only via a manager change, which goes through syncMaster).
  - `RECEIVED`: for each item, `verifiedQtyKg = dto item qty ?? submittedQtyKg`; validate `0 ≤ verified ≤ submitted`
    (more than submitted → 400 "Ask the site to update the listing"). An item with verified 0 → outcome EXCLUDED.
    Status RECEIVED, receipt stamps.
  - `NOT_RECEIVED`: status NOT_RECEIVED; ledger outcome NOT_RECEIVED. Keep the contribution listing ACTIVE until the
    collection finishes, so the site still sees it. At completion or expiry, set that listing to EXPIRED.
  - Notify the site (`consolidated_received` / `consolidated_not_received`).
- `exclude(id, reason)`: manager; before publish → EXCLUDED, ledger EXCLUDED. After publish → same, then `syncMaster`.

### B9.2 Publish (`ConsolidatedPublishService`)
`publishPreview(id)` returns `{ items[], totals, storage, allergens, bestBefore, warnings[], blockers[] }`
- **blockers** (SPEC A7): status not SUBMISSIONS_CLOSED; a contribution SUBMITTED/HANDED_OVER/LATE_PENDING_APPROVAL with receipt PENDING;
  no RECEIVED item with verified > 0; any included item whose contribution listing `bestBefore < pickupEndAt`
  (message names the site and item so the manager can exclude or adjust it); pickupEndAt already passed.
- **warnings:** sites with NO_CONTRIBUTION or NOT_RECEIVED; reduced quantities.

`publish(id, caller, declaration)`:
1. Re-run the blockers → 409 with a list.
2. Declaration MANAGER v1 → `ConsolidatedDeclaration`.
3. Build the master listing via `createListingRecord(tx, …, { consolidatedRole: MASTER, skipDiscovery: false })`:
   - `siteId = group.hostSiteId`, `organisationId`, enterprise snapshot of the host site (irrelevant for impact, but required).
   - `listingType = HUMAN`, `recoveryPathway = FOOD_FOR_PEOPLE`.
   - Pickup address/lat/lng/postcode from the point snapshot; `pickupFromTime = pickupStartAt`, `pickupByTime = pickupEndAt`.
   - `bestBefore = min(contribution listing bestBefore)` (A8).
   - Storage flags OR; allergens union; `isSafeForDonation = true`; photos union (≤5);
     `collectionNotes` = `${pointName}. ${pointDirections ?? ''} ${instructions ?? ''} Suitability: ${suitabilityNotes}. Contact: ${contactName} ${contactPhone}` (≤300 chars; truncate the instructions first).
   - **One master FoodItem per included ledger row** (`name`, `category`, `unit`, `quantityDescription`,
     `totalQtyKg = remainingQtyKg = verifiedQtyKg`). Set `ConsolidatedItem.masterFoodItemId`.
   - `totalQtyKg = remainingQtyKg = Σ verified`.
4. Collection → PUBLISHED, `publishedAt/By`, `masterListingId`, `version=1`.
5. After the transaction: call the existing `enqueueNewListing` (push to nearby charities). It uses `businessName` in the
   text, so pass the **point name** as `businessName` and no outlet name leaks. Do **not** call `enqueueListingExpiry`:
   this module expires masters itself (B7.2 step 7). Invalidate the nearby and recent caches.
6. Notify managers + contributing sites `consolidated_published`.

`syncMaster(collectionId, caller)` (used after any post-publish change):
- Status PUBLISHED: rebuild the master FoodItems/qty/flags from the ledger in place (update/insert/delete master items whose
  ledger row was excluded); bump `version`; ListingActivity "Listing updated". Invalidate the caches.
- Status CLAIMED/AWAITING_ITEM_CHECK: take a `Snapshot` before and after, then `diffMaterial`. Apply the update to the master listing
  **and** the master claim's `ClaimItem` rows (qty = new verified). Create `ConsolidatedChange` (material or not).
  If material → push the charity `pickup_change` + set `pendingChangeId`. If not material → push only if the quantity changed.
  Bump `version`.
- If everything is excluded after a claim → cancel the claim + collection (the cancel flow) with reason "No food available".

### B9.3 Hide master/contribution where needed (exact files to change)
Add helper `src/modules/consolidated/consolidated.filters.ts`:
```ts
export const DISCOVERABLE_LISTING = { consolidatedRole: { not: 'CONTRIBUTION' } } as const;   // Prisma where
export const BUSINESS_LIST_LISTING = { consolidatedRole: { not: 'MASTER' } } as const;
export const IMPACT_CLAIM = { claimKind: { not: 'CONSOLIDATED_MASTER' } } as const;
export const OPERATIONAL_CLAIM = { claimKind: { not: 'CONSOLIDATED_ALLOCATION' } } as const;
export const SQL_DISCOVERABLE = Prisma.sql`fl."consolidatedRole" <> 'CONTRIBUTION'`;
export const SQL_IMPACT_CLAIM = Prisma.sql`fc."claimKind" <> 'CONSOLIDATED_MASTER'`;
```
Apply them (search each file for `foodClaim`, `foodListing.find`, `food_listings`, `food_claims`):

| File | Change |
|---|---|
| `foodlisting/services/food.listing.service.ts` | `getNearbyListings` raw SQL (3 queries around lines 600–700): add `SQL_DISCOVERABLE`. `getOrgListings`, `getAllListingOfSiteID`, `getRecentListings`: add `BUSINESS_LIST_LISTING`. `getListingById`: unchanged, but add the `requiresItemCheck` flag (B9.5). `cancelListing`: 409 for CONTRIBUTION/MASTER ("Manage this from the collection"). |
| `foodlisting/workers/listing.worker.ts` | New-listing fan-out: skip CONTRIBUTION. Expiry sweep + `EXPIRE_LISTING`: skip CONTRIBUTION and MASTER. |
| `foodlisting/services/site.notification.service.ts` | Inbox: exclude CONTRIBUTION. |
| `psearch/psearch.service.ts` | Exclude CONTRIBUTION from search results. |
| relist / edit listing endpoints (`/listings/:id`, `/listings/:id/relist`) | 409 for CONTRIBUTION/MASTER (edits go through `/consolidated/contributions`). |
| `claims/services/claims.service.ts` | see B9.4 |
| `impact/services/impact.service.ts` | every Prisma `foodClaim.findMany` where → AND `IMPACT_CLAIM`; every raw SQL on `fc` (`queryTopFoodRows`, `orgScopeFilter` callers) → AND `SQL_IMPACT_CLAIM` |
| `enterprise/services/enterprise-reporting.service.ts`, `admin-dashboard.service.ts`, `enterprise-structure.service.ts`, `admin-app-users.service.ts`, `admin-connections.service.ts` | kg / impact aggregates → `IMPACT_CLAIM`. "Number of collections/pickups" counts → `OPERATIONAL_CLAIM` (STANDARD + MASTER). Listing counts → `BUSINESS_LIST_LISTING` (so a collection is not counted as N+1 listings) |
| `drivers/service/driver.location.service.ts` | B9.6 |

### B9.4 Claims changes (`claims.service.ts`)
- `claimListing`: after loading the listing:
  - `consolidatedRole === CONTRIBUTION` → `NotFoundException('Listing not found')`.
  - `consolidatedRole === MASTER` → force `dto.claimMode = FULL`; the collection must be PUBLISHED; set `claimKind=CONSOLIDATED_MASTER`
    on the created claim; in the same transaction set the collection → CLAIMED, `claimedAt`; and contribution listings →
    `ListingStatus.CLAIMED` (so sites see "Claimed" in Your Listings). After commit: notify `consolidated_claimed`.
- `cancelClaim` (charity cancels before pickup) on a master claim: collection CLAIMED → PUBLISHED if `now < pickupEndAt`, else
  EXPIRED; contribution listings → ACTIVE (or EXPIRED). Notify managers.
- `markCollected` on a master claim: keep the existing early return for `status === COLLECTED` ("Already marked as
  collected") **first** — the mobile post-collection rating modal relies on it after the item check. Otherwise →
  `BadRequestException('Use item check')`.
- `getMyClaims`, `getListingClaims`, `getClaimActivity`: `OPERATIONAL_CLAIM` for charity callers. For master claims add
  `requiresItemCheck: true`, `itemCheckDone`, and `pendingChangeId` to each item.
- Ratings (`rateClaim`, `submitProviderFeedback`, `rateDriver`) work on the master claim as today. Provider feedback for a master
  claim is allowed for group managers (the host site check must accept `assertManager`).
- Provider-side "claimed/collected" notifications (`notifyRestaurant*`) for master claims → route to managers + receivers
  (not the whole host site). The consolidated notifier sends the per-site messages.

### B9.5 Listing payload flag
Wherever a listing or claim is serialised for a charity (`getNearbyListings`, `getListingById`, `getMyClaims`), add
`requiresItemCheck: listing.consolidatedRole === 'MASTER'`. Do **not** add any other consolidated fields to charity payloads,
and never include contributing site names.

For **business** listing payloads (`getOrgListings`, `getAllListingOfSiteID`, `getRecentListings`, `getListingById` when the
caller's org owns the listing), add `consolidatedRole` and, for CONTRIBUTION listings,
`consolidated: { contributionId, collectionId, status, method, pointName, handoverStartAt, handoverEndAt, timezone }`
(one extra `include` on `consolidatedContribution → collection`). The mobile "Your Listings" screen uses this to show the badge
and the handover button without an extra request.

### B9.6 Driver pickup (R10, A9)
In `driver.location.service.ts`, where a pickup becomes `DriverPickupStatus.COLLECTED` and the claim becomes COLLECTED:
if the claim is CONSOLIDATED_MASTER → keep the claim update as is, then set the collection → AWAITING_ITEM_CHECK and push the charity
"Please complete the item check for your pickup". **Do not** write allocations here. The `requestDriverPickup` flow is unchanged.

**Acceptance:** an e2e test (see B13) walks claim → driver collected → item check → completed.

---

## B10. Charity item check and completion (R12, R19)

`ConsolidatedCompletionService`.

### B10.1 `GET /charity/claims/:claimId/item-check`
`assertCharityOwnsClaim`. Return the master items (from the master FoodItems joined to the ledger), **without** site info:
`{ claimId, pickup:{ pointName, address, start, end }, items:[{ masterFoodItemId, name, category, quantityDescription, qtyKg }], storage, allergens, declaration: DECLARATIONS.CHARITY, rejectionReasons: [...], pendingChange: { id, summary } | null, alreadyCompleted }`.

### B10.2 `POST /charity/claims/:claimId/item-check`
Validation:
- The claim status is PENDING/CONFIRMED (self pickup) or COLLECTED (driver); the collection is CLAIMED or AWAITING_ITEM_CHECK. Done → 409.
- No unacknowledged material change → 409 "Please review the pickup change first".
- Every master item is present exactly once; `accepted + rejected + unavailable === qtyKg` (±0.001); all ≥ 0;
  `rejected > 0` ⇒ `rejectionReason` required; OTHER ⇒ `rejectionNote` required.
- Declaration CHARITY v1 accepted.

Transaction (row-lock the master listing `FOR UPDATE` like `claimListing` does):
1. Update each `ConsolidatedItem`: accepted/rejected/unavailable, reason, outcome
   (`ACCEPTED` if accepted == verified; `PARTIALLY_ACCEPTED` if 0 < accepted < verified; `REJECTED` if accepted 0 and rejected > 0;
   `UNAVAILABLE` if everything is unavailable).
2. Master claim: if not COLLECTED → status COLLECTED, `collectedAt = now()`. Update the master `ClaimItem.qtyKg = acceptedQtyKg`
   (so the charity's own history shows the accepted kg). Save `rating/ratingNote` if given (same rules as `rateClaim`).
3. Declaration CHARITY row (`claimId`).
4. **Allocations.** For each contribution with Σ accepted > 0:
   ```ts
   tx.foodClaim.create({ data: {
     listingId: contribution.listingId, claimantOrgId: master.claimantOrgId, claimantSiteId: master.claimantSiteId,
     claimMode: 'PARTIAL', status: 'COLLECTED', claimKind: 'CONSOLIDATED_ALLOCATION', parentClaimId: master.id,
     recoveryPathway: 'FOOD_FOR_PEOPLE', confirmedAt: now, collectedAt: now,
     ...snapshotIdsFromContributionListing,             // snapshotGroupId/ClusterId/TerritoryId of the CONTRIBUTION listing
     claimItems: { create: items.map(i => ({ foodItemId: i.sourceFoodItemId, qtyKg: i.acceptedQtyKg })) },
   }})
   ```
   Set `contribution.allocationClaimId`, status COMPLETED. Decrement the source `FoodItem.remainingQtyKg` and listing `remainingQtyKg`
   by accepted. Set the contribution listing status to `CLAIMED` (unchanged) — the existing UI shows it as collected via the claim.
   Contributions with Σ accepted = 0 → status COMPLETED, no allocation; listing → EXPIRED.
5. **Invariant check** (throw → rollback): `Σ allocation qty === Σ master ClaimItem qty === Σ ledger accepted`.
6. Collection → COMPLETED, `completedAt`. Master listing status CLAIMED (unchanged).
7. ListingActivity on each contribution listing: "Collected: X kg accepted, Y kg not accepted".
8. After commit: invalidate the impact/listing caches used by the existing code (see `claims.cachemanager.ts`,
   `food.listing.cache.ts`); push `consolidated_completed` per site with **its own** numbers, and a manager summary.
   Then trigger the existing post-collection hooks the normal `markCollected` triggers (e.g. milestone/impact aggregate jobs —
   check `markCollected` after line ~700 and reuse the same calls for each allocation).

### B10.3 Material change acknowledgement
`POST /charity/changes/:changeId/acknowledge` → the claim owner; set `acknowledgedAt/By`; audit; notify managers.
Phase 1: the charity can only acknowledge **or** cancel the claim through the existing cancel endpoint (B9.4 handles it).

**Tests (must exist):**
- 3 sites (4 kg, 6 kg, 8 kg); receipt verifies 4, 5, 8; the charity accepts 4, 5, 6 (rejects 2 with QUALITY).
  → allocations 4/5/6; site impact via the existing `ImpactService.getSiteImpact` returns 4, 5, 6;
  charity org impact returns 15 (not 30, not 17); master claim excluded.
- A site with NOT_RECEIVED gets no allocation and 0 impact.
- An item check with a wrong sum → 400. A double submit → 409.

---

## B11. Reporting (RP1, SPEC §7.8)

`ConsolidatedReportService.summary(caller, q)`:
- Scope: groups where the caller is manager (or SUPER_ADMIN → all org groups). A site user may call it with `siteId` of their own site only
  (returns just their rows).
- Source: `consolidated_items` joined to `consolidated_collections` (`scheduledDate` in range, status in COMPLETED/EXPIRED/
  CANCELLED/CLAIMED/AWAITING_ITEM_CHECK/PUBLISHED). Sum `submittedQtyKg` (listed), `verifiedQtyKg`, `acceptedQtyKg`,
  `rejectedQtyKg`, `unavailableQtyKg` grouped by site, plus a combined total. Rejection reasons count. Categories when `category` is set.
- Convert kg ↔ lb **only** at the presentation layer if the org `MeasurementUnit` is IMPERIAL (follow how `impact.service` does it).
  No other conversions (R15).
- `reports/collections`: paged per-collection rows `{ id, date, groupName, pointName, status, listedKg, verifiedKg, acceptedKg, rejectedKg, unavailableKg, sitesContributed, charityName? }`.
  Show `charityName` to managers only.

**Acceptance:** for the B10 test scenario, summary totals = listed 18, verified 17, accepted 15, rejected 2, unavailable 0, and
per-site rows reconcile.

---

## B12. Notifications (`ConsolidatedNotifierService`)

- One method per SPEC §8 row. Use `NotificationService.send({ title, body, data:{ type, collectionId, contributionId?, listingId?, claimId?, changeId?, deepLink }, targetUserIds, priority, allowEmptyTargets: true })`
  and `.catch(log)` — never fail the business transaction because of a push.
- Recipients:
  - "users of site X" = the `siteAccess` users of that site (excluding view-only) + the org SUPER_ADMIN(s). Reuse the claims service
    `getOrgUserIds(orgId, siteId)` logic (move it to a shared util if needed).
  - managers = MANAGER members + SUPER_ADMIN; receivers = RECEIVER members.
  - charity = the users of the claimant org/site (same as the existing claim notifications).
- `deepLink` values: business `consolidated/collection/:id`, `consolidated/contribution/:id`; charity `updates`.
- Charity texts must be neutral: use the point name, never the group name or site names.
- Also write a `ListingActivity` on the affected contribution listing for site-visible events, so the existing "Updates" timeline
  shows them.

---

## B13. Tests, docs, and rollout

1. **Unit:** schedule (B2), material diff (B2), access (B3), invariants (B10).
2. **E2E happy path** (`test/consolidated.e2e-spec.ts`, use `prisma/dev-fixtures.ts` style seed):
   org owner grants permission → manager creates a group (3 sites, a point, 1 receiver) → schedules one-off today →
   sweep opens → 3 site users contribute (one late → approved) → handovers → receipt (one adjust, one not received) →
   close → preview has no blockers → publish → master visible in nearby for a charity within radius; contributions not visible →
   charity claims (FULL forced) → item check with one rejection → allocations exist → site impact correct → reports correct.
3. **E2E edge:** cancel after claim (charity notified, no impact); material change requires ack before item check; driver path →
   AWAITING_ITEM_CHECK; expiry when nobody claims; withdraw before publish; change request after publish.
4. **Regression:** run the whole existing test suite; add tests that a STANDARD listing/claim behaves exactly as before in nearby,
   claim, collected, impact and enterprise reporting.
5. **OpenAPI:** add Swagger decorators to every controller; run `npm run docs:openapi`; update `docs/API.md` with a
   "Consolidated Collections" section linking to SPEC.
6. **Seed:** add an optional fixture to `prisma/dev-fixtures.ts` that creates a demo group "Melbourne Park Precinct" with 3 kiosks
   and a point "Loading Dock B" so the mobile developers have data.
7. **Rollout:** deploy the migration first (additive), then the code. A feature flag env `CONSOLIDATED_ENABLED=true` gates the
   controllers (return 404 when off) and the sweep worker.

> **Already deployed.** The migration was applied to production on 12 November 2026 and the code is on `main`.
> The flag is unset, so the feature is invisible. See `DEPLOYMENT.md` for what that means for anyone pulling this,
> and for what is verified and what is not.

---

## Build order summary (checklist)

- [ ] B0 module skeleton
- [ ] B1 schema + migration
- [ ] B2 constants + pure helpers + tests
- [ ] B3 access service + permission endpoints + tests
- [ ] B4 audit service
- [ ] B5 groups/points endpoints
- [ ] B6 schedules + generation
- [ ] B7 lifecycle + sweep worker; make the listing worker skip consolidated listings
- [ ] B8 contributions (refactor `createListingRecord` first)
- [ ] B9 receipt, publish, filters across existing services, claims changes, driver hook
- [ ] B10 item check + allocations + invariant tests
- [ ] B11 reports
- [ ] B12 notifications
- [ ] B13 e2e, regression, OpenAPI, seed, flag

Tell the mobile team when B5, B6, B8, B9 and B10 are deployed to staging. They can build against mocks
(`FRONTEND_GUIDE.md` §F2) until then.
