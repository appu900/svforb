# Consolidated Collections — Shared Specification (v1)

> **This file is the single source of truth for the Consolidated Collections feature.**
> An identical copy lives in both repos:
> - Backend: `svforb/docs/consolidated-collections/SPEC.md`
> - Mobile app: `saveful-for-business-rn/docs/consolidated-collections/SPEC.md`
>
> If you change one, change the other. Implementation steps are in
> `BACKEND_GUIDE.md` (backend repo) and `FRONTEND_GUIDE.md` (mobile repo).

---

## 0. How to use these documents (for AI agents and developers)

1. Read this SPEC end to end before writing any code.
2. Then open the guide for the repo you are working in and follow its steps **in order**.
   Each step lists files to touch, what to build, and an acceptance check.
3. Do not invent behaviour. If something is not covered here, follow the
   "Assumptions" in §11. If it is not covered there either, stop and ask.
4. Naming rule: never use the words **"Cluster"** or plain **"Group"** in new code for this feature.
   The Enterprise module already uses `Cluster`, `EnterpriseGroup`, `GroupSite`, `ClusterSite`
   for *reporting*, which is a different feature. Every new symbol is prefixed `Consolidated…`.
5. Charity-facing UI must never show the words "consolidated", "cluster", "group",
   or the names of contributing outlets (see §2.4).

---

## 1. What we are building (plain summary)

Several food outlets in one venue (a stadium, zoo, campus) bring their surplus food to **one
collection point**. The charity sees **one ordinary listing**, claims it once and picks up once.
Saveful still records **which site gave what**, so every site gets accurate impact and nothing is
counted twice.

**Core promise:** multiple food sites → one collection point → one listing → one charity pickup.

It is an **extension of the existing "Surplus Food for People" (edible) flow**. It is not a new app,
module or bottom tab. Direct listings, the animal/non-edible pathway, Connections, claims, ratings
and reports must keep working unchanged.

Commercial: included with Saveful Connect at no extra cost for **any paid plan**.

---

## 2. Terminology, roles, and rules

### 2.1 Terms

| Business term | Meaning | Example | Code name |
|---|---|---|---|
| Consolidated Collection Group | A saved set of sites that contribute to a shared collection point | Melbourne Park Precinct | `ConsolidatedGroup` |
| Consolidated Collection Point | The central location where food is brought together | Loading Dock B | `ConsolidatedCollectionPoint` |
| Consolidated Collection | One dated collection event for some or all sites in a group | Fri 13 Nov, 2 pm | `ConsolidatedCollection` |
| Collection schedule | The one-off or recurring rule that generates collections | Every Fri 2 pm | `ConsolidatedSchedule` |
| Participating Sites | The outlets that contribute | Kiosk 1, Kiosk 2, Corporate Suite | `ConsolidatedGroupSite` |
| Site contribution | One site's food for one collection (a normal `FoodListing` marked as a contribution) | Kiosk 1: 4 kg sandwiches | `ConsolidatedContribution` |
| Consolidated listing | The single charity-facing listing generated on publish (a `FoodListing` marked as master) | "Loading Dock B — 18 kg" | master `FoodListing` |

### 2.2 Roles (no new role types)

| Who | How they get it | Can do |
|---|---|---|
| **Manager** | Existing Org Admin (`OrgRole.SUPER_ADMIN` / `ORG_ADMIN`) or Site Admin (`SiteRole.SITE_ADMIN`) **plus** the new permission flag `canManageConsolidated`. Org owner (`SUPER_ADMIN`) has it implicitly. | Create/edit/archive groups (only with sites inside their access), schedule collections, monitor, confirm receipt, exclude, approve changes and late items, publish, cancel, see reports for groups they manage |
| **Receiver (delegate)** | Any existing org user the manager adds to the group as a receiver. Same login. | Confirm receipt (Received / Not Received / Adjust Quantity) for that group's collections. Nothing else extra. |
| **Site user** | Existing users with access to a participating site (Site Admin or Staff, not view-only) | List food into an open collection for **their own site**, edit or withdraw before publish, request changes after publish, confirm handover, see their own results. **Cannot** see other sites' data, change the method or schedule, or publish. |
| **Charity / driver** | Unchanged | See one normal listing, claim the whole of it, pick up (self or driver), inspect, record accepted/rejected/unavailable per item, sign the declaration, rate |

Scope rules:
- A Site Admin manager may only create or manage a group whose sites are **all** within their `siteAccess`.
- An Org Admin manager may use any site in their organisation.
- No cross-organisation groups: every site in a group belongs to the group's organisation.

### 2.3 Business rules from the client (final answers)

| # | Rule |
|---|---|
| R1 | Managers = existing Org Admin / Site Admin + `canManageConsolidated` permission. |
| R2 | Receiver = existing user assigned by the manager; may be the manager. |
| R3 | Managers work in **both** the mobile app and the Enterprise web portal. The API is shared (the web portal is a later, separate task). |
| R4 | Available on **any paid plan**, gated at **plan level — never tied to a module**. A customer holding any one module (Listing or Make Food Count) gets it at no extra charge. Orgs on a free trial are entitled too: the platform treats `TRIALING` and `ACTIVE` alike (`ENTITLING_STATUSES`). The global `SubscriptionInterceptor` already blocks writes for a billable org with no live plan, so **this feature adds no commercial check of its own**. If it ever becomes module-gated or tier-gated, change exactly one method — `ConsolidatedAccessService.assertProductAccess()` (BACKEND_GUIDE §B3) — never by adding checks to controllers or services. |
| R5 | A site can be in **many groups and many collections**. Each contribution (listing) belongs to **exactly one** collection. |
| R6 | Edits: **before publish**, the site edits or withdraws freely. **After publish, before claim**, the change needs manager approval, then the consolidated listing updates. **After claim**, it needs manager approval **and** the material-change rules (R11). Every change is audited. |
| R7 | Submissions close automatically at the deadline. The manager can reopen or approve a late contribution. After claim, additions follow the post-claim change process. |
| R8 | Recurrence in Phase 1: one-off, daily, weekly, selected weekdays, **and custom dates** (cheap to add, so it is included). Every occurrence keeps its own contributions, status and reporting. |
| R9 | Cancelling a collection: notify sites (and the charity if claimed). Contribution records stay for audit but count as **not redistributed**. They **never** turn into direct listings automatically. |
| R10 | Existing collection options still apply, including **driver pickup**. The charity or driver sees one listing, one point and one process. |
| R11 | **Material change** (needs charity acknowledgement): collection location changed; pickup date/time changed; food safety or handling info changed (storage flags, allergens); total quantity down by **more than 20%** (constant, configurable later); any item removed, or any food category reduced by more than 20%. Anything else is logged and notified if relevant. |
| R12 | At pickup, record per item: **accepted**, **rejected** (with reason) and **unavailable**. Rejected food is neither waste nor redistributed. The business decides what to do next (relist or record elsewhere), manually. |
| R13 | Declaration texts are final (see §6). Store version and text snapshot. |
| R14 | No new mandatory temperature or photo evidence. Optional photos where the listing flow already supports them. |
| R15 | Kilograms stay the standard unit. An optional free-text descriptive quantity ("12 trays") is display-only. No automatic conversion. |
| R16 | Reuse existing design components. Extend existing screens. The Canva reference: https://canva.link/zbrruehmugncm5c |
| R17 | Phased release (see §10). |
| R18 | Receipt at the point, per contribution: **Received / Not Received / Adjust Quantity**. This applies to both handover methods. No transport routing. The listing distinguishes **submitted** from **verified** quantity. |
| R19 | Traceable chain per item: submitted → verified → accepted / rejected / unavailable → outcome. Impact is attributed to sites by **actual accepted quantity** (never pro rata). The sum of site accepted = the collection's accepted total. |
| R20 | The manager can close submissions and publish even if some sites have not contributed. Those sites are recorded as "no contribution". |

### 2.4 Charity-facing rules
- The charity sees a normal listing in Available: collection point name and address, pickup window,
  food items, storage and allergens, and instructions.
- No "consolidated" / "cluster" / "group" labels, and no outlet names, in normal charity UI.
- Claim is always **whole listing** (FULL). Partial claim is disabled for these listings.
- Collection confirmation becomes an **item check**: accepted / rejected (+reason) / unavailable per
  item, plus the charity declaration. Then the existing rating/feedback continues.
- The API exposes a neutral flag `requiresItemCheck: true` so the app knows to show the item check.
  The UI never labels why.

### 2.5 Handover methods (one per collection, chosen by the manager)

| Method | Code | Site sees button | Times the manager sets |
|---|---|---|---|
| Site drop-off | `SITE_DROP_OFF` | "Confirm food dropped off" | Drop-off window (start–end). The end is the final drop-off deadline. |
| Internal site collection | `INTERNAL_COLLECTION` | "Confirm food collected" | Food-ready deadline + internal collection window |

Both methods also need: submissions-close time, charity pickup window, contact name/phone, instructions,
and suitability requirements text. Mixed methods within one collection are **not** supported.
The site cannot change the method.

---

### 2.5a Site invitations (client requirement, Canva CM1)

A site added to a group takes part only after someone who runs it **accepts**.
- Who answers: the site's Site Admins; for a site with no Site Admin, the org owner/admins.
- A site joins immediately (no invitation) when the person adding it could answer for it anyway.
- Only ACCEPTED sites are participating sites for schedules and collections. Accepting adds the
  site to the group's active schedules and to its SCHEDULED/OPEN (non-detached) collections.
- Declining removes the site from the group (row kept, `removedAt` set); re-adding sends a new invitation.
- Pushes: `consolidated_invitation` (to responders), `consolidated_invitation_accepted|declined` (to managers).

## 3. End-to-end flow

```
MANAGER (setup, occasional)            Account → Consolidated Collections
  1. Create group: name, host site, collection point(s), participating sites, managers, receivers

MANAGER (operations, regular)          Home → Consolidated Collections
  2. Schedule: group, point, method, recurrence, times, contact, instructions, suitability
     → system generates dated collections (rolling 14 days ahead)

SITE USER                              List Surplus → Surplus Food for People
  3. Choose "Direct listing" or an open collection → existing Food Details → read-only logistics
     → Confirm + site declaration → contribution created (hidden from charities)
  4. Handover button: "Confirm food dropped off" / "Confirm food collected" (server time + actor)

SYSTEM
  - Submissions auto-close at deadline; reminders before close; overdue alert after handover end

MANAGER / RECEIVER                     Collection dashboard
  5. Per contribution: Received / Not Received / Adjust quantity  (= verified quantity)
  6. Review & Publish: preview of verified items, manager declaration → ONE master listing goes live

CHARITY                                Available → Claim → Pickup (self or driver)
  7. Claims the whole listing
  8. At pickup: per-item accepted / rejected (+reason) / unavailable, charity declaration → rate

SYSTEM
  9. Per-site "allocation" claims are written with the accepted quantities → each site's existing
     impact, insights and updates work automatically. The master claim is excluded from impact.
```

---

## 4. Data model (summary — exact Prisma is in BACKEND_GUIDE §B1)

```
Organisation 1─* ConsolidatedGroup 1─* ConsolidatedCollectionPoint
                       │ 1─* ConsolidatedGroupSite  *─1 Site
                       │ 1─* ConsolidatedGroupMember *─1 User   (role MANAGER | RECEIVER)
                       │ 1─* ConsolidatedSchedule 1─* ConsolidatedCollection
                                                         │ 1─1 FoodListing (master, consolidatedRole=MASTER)
                                                         │ 1─* ConsolidatedContribution 1─1 FoodListing (contribution)
                                                         │ 1─* ConsolidatedItem (ledger: per source FoodItem)
                                                         │ 1─* ConsolidatedDeclaration
                                                         │ 1─* ConsolidatedChange (material changes + ack)
                                                         │ 1─* ConsolidatedChangeRequest (site edits needing approval)
OrgMemeberShip.canManageConsolidated  (permission flag)
FoodListing.consolidatedRole  STANDARD | CONTRIBUTION | MASTER
FoodClaim.claimKind           STANDARD | CONSOLIDATED_MASTER | CONSOLIDATED_ALLOCATION
FoodItem.quantityDescription  optional display text ("12 trays")
AuditArea += CONSOLIDATED_COLLECTIONS   (reuse AuditLog)
```

### 4.1 Why this shape (important for every developer)
- A **site contribution is a real `FoodListing`** (`consolidatedRole = CONTRIBUTION`). This means food
  details, photos, allergens, "Your Listings", "Updates" and site impact all reuse existing code.
  Contributions are **never** visible or claimable by charities.
- The **charity-facing listing is a real `FoodListing`** (`consolidatedRole = MASTER`). The whole existing
  charity discovery, claim, driver and rating flow works on it unchanged. Each master `FoodItem` maps 1:1
  to one source contribution `FoodItem` through `ConsolidatedItem`.
- **Impact without double counting:**
  - The charity's claim on the master listing (`claimKind = CONSOLIDATED_MASTER`) is the operational
    record: one pickup, one rating. It is **excluded from all impact and reporting queries**.
  - On completion, the system writes one `FoodClaim` per contributing site on that site's contribution
    listing (`claimKind = CONSOLIDATED_ALLOCATION`, status `COLLECTED`, claimant = the charity), with the
    **accepted** kg. Existing impact code (keyed on `listing.siteId` for donors and `claimantSiteId` for
    charities) then counts every kg exactly once on each side.
  - Allocation claims are **hidden from charity-facing lists** (My claims, history, updates), so the charity
    sees one pickup.

### 4.2 Claim filters (must be applied everywhere — see BACKEND_GUIDE §B9)

| Context | Rule |
|---|---|
| Impact, insights, enterprise reporting, admin kg totals | exclude `claimKind = CONSOLIDATED_MASTER` |
| Charity/farmer operational lists (my claims, history, updates, pickups) | exclude `claimKind = CONSOLIDATED_ALLOCATION` |
| Business listing lists (org/site listings, recent) | exclude listings with `consolidatedRole = MASTER` (managers see them in the dashboard) |
| Discovery (nearby, inbox, search, push fan-out, expiry sweep) | exclude listings with `consolidatedRole = CONTRIBUTION` |
| Counting "pickups/collections" (number of events) | count STANDARD + MASTER, never ALLOCATION |

---

## 5. Status models

### 5.1 Collection (`ConsolidatedCollectionStatus`)

```
SCHEDULED ──(opensAt)──► OPEN ──(submissionsCloseAt or manager closes)──► SUBMISSIONS_CLOSED
                          ▲                                                  │
                          └──── manager reopens (until time) ◄───────────────┤
                                                                             │ manager publishes
                                                                             ▼
                                                                         PUBLISHED ──(charity claims)──► CLAIMED
                                                                             │                            │ pickup done
                                                                             │                            ▼
                                                                             │            AWAITING_ITEM_CHECK (driver/no check yet)
                                                                             │                            │ charity submits item check
                                                                             ▼                            ▼
                                                                         EXPIRED                      COMPLETED
Any non-final state ──(manager cancels)──► CANCELLED
OPEN/SUBMISSIONS_CLOSED/PUBLISHED with pickupEndAt passed and not claimed ──► EXPIRED
Final states: COMPLETED, CANCELLED, EXPIRED
```

Note: a claim cancelled by the charity before pickup returns the collection CLAIMED → PUBLISHED
(the master listing becomes ACTIVE again if the pickup window is still open).

### 5.2 Contribution (`ConsolidatedContributionStatus`)

```
SUBMITTED ──► HANDED_OVER ──► RECEIVED ──► (on completion) COMPLETED
    │              │              └─► (manager) EXCLUDED (reason)
    │              └─► NOT_RECEIVED
    ├─► WITHDRAWN (site, before publish)
    ├─► LATE_PENDING_APPROVAL ──► SUBMITTED (approved) | REJECTED_LATE
    └─► NOT_RECEIVED (manager may mark without handover)
NO_CONTRIBUTION — auto-created at close for participating sites that submitted nothing
Collection CANCELLED → every open contribution → CANCELLED
```
Receipt may be recorded on SUBMITTED (the site forgot to tap handover) or HANDED_OVER.
"Handed over" is **never** treated as "received".

### 5.3 Item ledger (`ConsolidatedItem`), per source food item
`submittedQtyKg` → `verifiedQtyKg` (receipt) → `acceptedQtyKg` + `rejectedQtyKg` + `unavailableQtyKg`
(= verified) and `outcome`: `PENDING | ACCEPTED | PARTIALLY_ACCEPTED | REJECTED | UNAVAILABLE | NOT_RECEIVED | EXCLUDED | CANCELLED`.

---

## 6. Declarations (final text, version `v1`)

| Type | Text |
|---|---|
| `SITE` | I confirm that the food and quantities recorded are accurate to the best of my knowledge, that the food is suitable for its intended redistribution, and that it has been handled and stored in accordance with applicable food safety requirements. |
| `MANAGER` | I confirm that the consolidated listing accurately reflects the food recorded and verified for this collection, and that the participating organisation remains responsible for applicable food safety and handling requirements. |
| `CHARITY` | I confirm that the quantities and condition of food accepted have been recorded, including rejected or unavailable items, and acknowledge responsibility for the safe handling, transport and use of accepted food following collection, in accordance with applicable requirements. |

The backend serves these (`GET /consolidated/declarations`). The client must send back
`{ version, accepted: true }`. The backend stores the actor, server timestamp, version, a text snapshot and the scope.
The manager declaration must **not** imply they inspected every item.
Note: the charity-facing text contains no forbidden words, so it is safe to show.

---

## 7. API contract (prefix `/api/v1/consolidated`, JWT required)

All times are ISO-8601 UTC in responses, plus a `timezone` (IANA) field for display.
Schedule inputs use local `"HH:mm"` and `"YYYY-MM-DD"` in the group's timezone.
Errors use the existing Nest format `{ statusCode, message }`.

### 7.1 Access
| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/me` | any business user | `{ canManage, managedGroupIds[], receiverGroupIds[], siteIdsWithOpenCollections[], siteIds, groups[] }` for UI gating |
| GET | `/declarations` | any | `{ SITE:{version,text}, MANAGER:{…}, CHARITY:{…} }` |
| GET | `/permissions` | org owner | users of the org with `canManageConsolidated` |
| PATCH | `/permissions/:userId` | org owner | body `{ canManageConsolidated: boolean }` |

### 7.2 Groups (setup)
| Method | Path | Body / query |
|---|---|---|
| GET | `/groups` | `?includeArchived=false` → list with site count and next collection |
| POST | `/groups` | `{ name, description?, hostSiteId, timezone?, siteIds[], members?: [{ userId, role: MANAGER\|RECEIVER }], collectionPoint:{ name, address, postcode?, lat, lng, directions? } }` (the creator is always a manager) |
| GET | `/groups/:id` | detail incl. points, sites, members |
| PATCH | `/groups/:id` | `{ name?, description?, hostSiteId?, timezone? }` |
| DELETE | `/groups/:id` | archives (blocked if open/published/claimed collections exist) |
| PUT | `/groups/:id/sites` | `{ siteIds[], hostSiteId? }` (removal is soft; history kept; `hostSiteId` required when the host is removed) |
| PUT | `/groups/:id/members` | `{ members: [{ userId, role: MANAGER\|RECEIVER }] }` (full list) |
| POST | `/groups/:id/points` | point body as above |
| PATCH | `/groups/:id/points/:pointId` | partial point body, `{ isActive?, isDefault? }` |
| GET | `/groups/eligible-sites` | sites the caller may add |
| GET | `/invitations` | pending site invitations the caller can answer (see §2.5a) |
| POST | `/invitations/:id/accept` | – site joins; added to the group's active schedules and its SCHEDULED/OPEN collections |
| POST | `/invitations/:id/decline` | `{ reason? }` – site leaves the group (history kept); the manager can invite it again |
| GET | `/groups/eligible-users` | org users for manager/receiver pickers (`canManage` flag included) |

### 7.3 Schedules and collections (operations)
| Method | Path | Body / query |
|---|---|---|
| POST | `/groups/:id/schedules` | `{ collectionPointId, method, recurrence: ONE_OFF\|DAILY\|WEEKLY\|SELECTED_WEEKDAYS\|CUSTOM_DATES, startDate, endDate?, daysOfWeek?: number[] (1=Mon..7=Sun), customDates?: string[], opensDaysBefore?: 0-30 (default 0), submissionsCloseTime, handoverStartTime, handoverEndTime, pickupStartTime, pickupEndTime ("HH:mm"), contactName, contactPhone, instructions?, suitabilityNotes, participatingSiteIds?: number[] (default all group sites) }` → `{ schedule, collectionsCreated }` |
| GET | `/groups/:id/schedules` | active schedules of the group |
| GET | `/schedules/:id` | – |
| PATCH | `/schedules/:id` | same fields; applies to **future** collections that are still SCHEDULED/OPEN; returns affected ids |
| POST | `/schedules/:id/end` | `{ fromDate }` cancels future collections of the series (notifies) |
| GET | `/collections` | `?tab=upcoming\|active\|past&groupId=&page=&limit=` (manager/receiver view) |
| GET | `/collections/:id` | **dashboard** payload (§7.6) |
| PATCH | `/collections/:id` | edit this occurrence only: `collectionPointId?`, `…Time` fields ("HH:mm"), contact, instructions, suitability. After claim → material-change rules apply. |
| POST | `/collections/:id/cancel` | `{ reason }` |
| POST | `/collections/:id/close` | – (creates NO_CONTRIBUTION rows) |
| POST | `/collections/:id/reopen` | `{ until: ISO }` (not past the end of handover) |
| POST | `/collections/:id/remind` | `{ siteIds?: number[] }` (default: sites with no contribution) |
| GET | `/collections/:id/publish-preview` | items to publish, totals, warnings (e.g. best-before before pickup end) |
| POST | `/collections/:id/publish` | `{ declaration:{ version, accepted:true } }` → master listing id |
| GET | `/collections/:id/audit` | audit entries (manager only) |

### 7.4 Site contributions
| Method | Path | Body |
|---|---|---|
| GET | `/sites/:siteId/open-collections` | collections this site can list into now (status OPEN, or reopened, site participating) |
| POST | `/collections/:id/contributions` | **multipart or JSON**, same fields as `POST /food-listings` **except** pickup address/lat/lng/times (taken from the collection) + `siteId`, `declaration:{version,accepted:true}`, items may carry `quantityDescription`. After close → creates `LATE_PENDING_APPROVAL`. |
| GET | `/contributions/:id` | own-site view (site user) or full view (manager) |
| GET | `/contributions/by-listing/:listingId` | same, looked up by contribution listing id |
| PATCH | `/contributions/:id` | food items/flags/notes/photos. Before publish → applied. After publish → returns `{ changeRequestId, status:'PENDING_APPROVAL' }` |
| POST | `/contributions/:id/withdraw` | `{ reason? }` before publish only |
| POST | `/contributions/:id/handover` | – (server records time, actor, method) |

### 7.5 Manager / receiver actions
| Method | Path | Body |
|---|---|---|
| POST | `/contributions/:id/receipt` | `{ received: boolean, items?: [{ itemId, verifiedQtyKg }], note? }` — `itemId` is the ledger id from the dashboard item (items omitted = all as submitted; any lower qty = "Adjust Quantity") |
| POST | `/contributions/:id/exclude` | `{ reason }` (before publish; after publish → treated as a change) |
| POST | `/contributions/:id/approve-late` | – |
| POST | `/contributions/:id/reject-late` | `{ reason }` |
| GET | `/collections/:id/change-requests` (alias `/change-requests?collectionId=`) | pending site change requests |
| POST | `/change-requests/:id/approve` | – (applies; may create a material change) |
| POST | `/change-requests/:id/reject` | `{ reason }` |

### 7.6 Dashboard payload (`GET /collections/:id`)
```jsonc
{
  "id": 41, "status": "OPEN", "method": "SITE_DROP_OFF", "timezone": "Australia/Melbourne",
  "group": { "id": 3, "name": "Melbourne Park Precinct" },
  "point": { "id": 5, "name": "Loading Dock B", "address": "…", "lat": -37.8, "lng": 144.9, "directions": "…" },
  "times": { "opensAt": "…", "submissionsCloseAt": "…", "handoverStartAt": "…", "handoverEndAt": "…",
             "pickupStartAt": "…", "pickupEndAt": "…", "reopenedUntil": null },
  "contact": { "name": "…", "phone": "…" }, "instructions": "…", "suitabilityNotes": "…",
  "totals": { "submittedKg": 22.5, "verifiedKg": 18, "acceptedKg": null, "rejectedKg": null, "unavailableKg": null },
  "counts": { "participating": 6, "submitted": 4, "handedOver": 3, "received": 3, "notReceived": 0, "noContribution": 2, "late": 1 },
  "contributions": [{
      "id": 90, "site": { "id": 12, "name": "Kiosk 1" }, "listingId": 501, "status": "RECEIVED",
      "submittedAt": "…", "submittedBy": { "id": 7, "name": "…" }, "isLate": false,
      "handover": { "at": "…", "by": { "id": 7, "name": "…" } },
      "receipt": { "status": "RECEIVED", "at": "…", "by": { "id": 2, "name": "…" }, "note": null },
      "declaration": { "version": "v1", "at": "…" },
      "items": [{ "foodItemId": 801, "name": "Sandwiches", "category": "Prepared meals",
                  "quantityDescription": "3 trays", "submittedQtyKg": 4, "verifiedQtyKg": 3.5,
                  "acceptedQtyKg": null, "rejectedQtyKg": null, "unavailableQtyKg": null, "rejectionReason": null,
                  "bestBefore": "…" }],
      "storage": { "refrigeration": true, "ambient": false, "freezer": false, "hot": false, "reheating": false },
      "allergens": ["gluten"], "pendingChangeRequestId": null, "exceptions": ["LATE_HANDOVER"]
  }],
  "sitesWithoutContribution": [{ "id": 14, "name": "Kiosk 3" }],
  "publication": { "masterListingId": null, "publishedAt": null, "publishedBy": null, "declarationVersion": null },
  "claim": null,              // { id, charityName, claimedAt, driverPickup: {...}|null, status }
  "pendingMaterialChange": null,
  "permissions": { "canManage": true, "canReceive": true, "canPublish": false, "publishBlockers": ["2 contributions awaiting receipt"] }
}
```
For a **site user**, the same endpoint returns the event info plus **only their own site's** contributions,
and no `totals`, `counts` or `sitesWithoutContribution`.

### 7.7 Charity
| Method | Path | Purpose |
|---|---|---|
| (existing) | `GET /food-listings/nearby`, `GET /food-listings/:id`, `POST /claims` | unchanged, but master listings carry `requiresItemCheck: true` and the claim is forced to FULL |
| (existing) | `GET /claims/my` | master claims carry `requiresItemCheck: true`, `itemCheckDone: boolean`, `pendingChangeId` |
| GET | `/charity/claims/:claimId/item-check` | items `{ masterFoodItemId, name, category, quantityDescription, qtyKg, storage, allergens }`, declaration, pending change |
| POST | `/charity/changes/:changeId/acknowledge` | acknowledge a material change |
| POST | `/charity/claims/:claimId/item-check` | `{ items:[{ masterFoodItemId, acceptedQtyKg, rejectedQtyKg, unavailableQtyKg, rejectionReason? }], declaration:{version,accepted:true}, rating?, ratingNote? }` → marks collected (if not already) and completes |
| (existing) | `PATCH /claims/:id/collected` | **rejected (400)** for master claims: "Use item check" |

Rejection reasons (enum `ConsolidatedRejectionReason`): `QUALITY`, `TEMPERATURE`, `PACKAGING_DAMAGED`,
`PAST_DATE`, `NOT_AS_DESCRIBED`, `CANNOT_TRANSPORT`, `CANNOT_STORE`, `OTHER` (requires `rejectionNote`).

### 7.8 Reporting
| Method | Path | Query | Returns |
|---|---|---|---|
| GET | `/reports/summary` | `groupId?, siteId?, from, to, category?` | combined totals + per-site rows: listed, verified, accepted, rejected, unavailable kg, collections count, rejection reasons breakdown |
| GET | `/reports/collections` | same + `page`, `pageSize` | per-collection rows (`date`, status, totals) |

Existing `/impact/*` endpoints keep working. Site impact automatically includes accepted consolidated food.

### 7.9 Push notification `data.type` values (for deep links)
`consolidated_scheduled`, `consolidated_closing_soon`, `consolidated_late_request`, `consolidated_handover`,
`consolidated_overdue`, `consolidated_received`, `consolidated_not_received`, `consolidated_change_request`,
`consolidated_change_decided`, `consolidated_published`, `consolidated_claimed`, `consolidated_pickup_soon`,
`consolidated_completed`, `consolidated_cancelled`.
Charity-facing pushes reuse **existing** types (`new_listing_nearby`, etc.) plus `pickup_change` (material
change) with neutral wording.
Payload: `{ type, collectionId?, contributionId?, listingId?, claimId?, changeId?, deepLink }`.

---

## 8. Notifications (Phase 1)

| Trigger | To | Text (example) |
|---|---|---|
| Collection(s) scheduled | users of participating sites | "Food collection scheduled at Loading Dock B, Fri 13 Nov. List by 1:30 pm." |
| 60 min before submissions close | sites with no contribution yet | "Collection closes in 1 hour — add your surplus food." |
| Late contribution submitted | managers | "Kiosk 2 submitted after the deadline — review." |
| Handover confirmed | managers + receivers | "Kiosk 1 dropped off 4 kg." |
| Handover window ended, not handed over | managers + the site | "Kiosk 3 has not handed over food." |
| Receipt recorded | the site | "Your food was received at Loading Dock B (3.5 kg verified)." / "… marked not received." |
| Site change request | managers | "Kiosk 1 requested a change — approve or reject." |
| Change request decided | the site | "Your change was approved/rejected." |
| Published | managers + contributing sites | "Collection published to charities." Charities: existing new-listing push |
| Claimed | managers + receivers + contributing sites | "A charity will collect at 2 pm." |
| 30 min before pickup | charity (existing style), receivers | "Pickup at Loading Dock B in 30 minutes." |
| Material change | charity | "Your pickup has changed — please review and confirm." |
| Completed | each site (own accepted kg), managers (totals) | "4 kg of your food was collected. 0.5 kg was not accepted." |
| Cancelled | sites, receivers, charity if claimed | "Collection on Fri 13 Nov was cancelled." |

---

## 9. Non-functional requirements (acceptance)

- **Permissions:** a user outside scope gets 403/404. Site users never see other sites' operational data.
- **Integrity:** contributions, items, ledger and audit survive edits, cancels and schedule changes.
  Removing a site from a group never deletes history.
- **Time:** server timestamps only. Schedule maths in the group's IANA timezone, DST-safe (reuse
  `connections/connection.schedule.ts` helpers).
- **Safety:** no contribution without a site declaration, no publish without a manager declaration,
  and no completion without a charity declaration. All are versioned and stored.
- **Collection:** exactly one claimable listing per collection. One pickup reconciles many sites.
- **Method:** one method per collection. Labels, reminders and buttons follow it.
- **Exceptions:** missing sites, late handover, not received, damaged/rejected food, partial pickup,
  charity cancel, and collection cancel are all handled and never inflate impact.
- **Regression:** direct listings, animal listings, Connections, claims, driver flow, ratings, insights and
  Enterprise reports are unchanged (existing tests pass, and new filter tests prove it).
- **Usability:** a site lists into a collection with at most **one extra tap** (choosing the collection) compared with a
  direct listing. Recurring schedules need no weekly re-setup.

---

## 10. Phases

**Phase 1 (build now):** permission flag; groups, points, sites, members; schedules (one-off, daily,
weekly, weekdays, custom dates); auto open/close; reminders; site contribution create/edit/withdraw;
late submission + approval; change requests after publish; handover; receipt (received / not received /
adjust); exclude; publish (after submissions close **and** every submitted contribution has a receipt
decision); charity full claim; driver pickup; item check; allocations and impact; material-change detection
+ acknowledgement (basic); cancel; site and manager reporting; essential notifications; audit.

**Phase 2 (later, design for it but don't build):** early publication before receipt; advanced post-claim
change management (charity can decline changes, partial re-publish); multi-charity claims; advanced
exceptions; the Enterprise web portal UI (API already shared); configurable thresholds per organisation.

---

## 11. Assumptions (decided by the dev team; change only if the client says otherwise)

| # | Assumption |
|---|---|
| A1 | The org owner (`SUPER_ADMIN`) always has `canManageConsolidated`. They grant it to others in Manage Access. |
| A2 | The master listing's `siteId` is the group's **host site** (chosen at group creation; must be one of the participating sites). It only drives ownership. Master claims are excluded from impact. |
| A3 | One contribution per site per collection. A site edits it to add more items (before publish) or via a change request (after). |
| A4 | Collections are generated **14 days ahead** by a sweep. Changes to a series affect future SCHEDULED/OPEN occurrences only. |
| A5 | Submissions open at 00:00 local on the collection date, unless `opensDaysBefore` is set. |
| A6 | Time order: `submissionsClose ≤ handoverEnd`, `handoverStart < handoverEnd ≤ pickupStart < pickupEnd`, all on the collection date (no overnight windows in Phase 1). |
| A7 | Publish requires: submissions closed, ≥1 RECEIVED contribution with verified kg > 0, every SUBMITTED/HANDED_OVER contribution has a receipt decision or is excluded, and no included item's best-before is before `pickupEndAt` (those must be excluded or adjusted). |
| A8 | Master `bestBefore` = the earliest best-before of the included contribution listings. Storage flags = OR. Allergens = union. Photos = union (max 5). Notes = instructions + suitability text. |
| A9 | If a driver completes the pickup, the collection goes to `AWAITING_ITEM_CHECK`. The charity completes the item check in the app. If it is not done within **24 h after pickupEnd**, managers get a reminder. Impact is only attributed after the item check. |
| A10 | "Category reduced >20%" uses `FoodItem.category`. Items without a category are grouped as "Uncategorised". |
| A11 | Rejected and unavailable quantities stay on the contribution listing as non-redistributed. The site may create a new direct listing manually. Nothing is automatic. |
| A12 | The farmer/animal pathway is out of scope. Contributions are always `listingType = HUMAN`, `recoveryPathway = FOOD_FOR_PEOPLE`. |
