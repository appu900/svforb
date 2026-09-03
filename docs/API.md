# Saveful for Business — API Reference

202 endpoints across 29 areas. 177 require a bearer token; 25 are public.

All paths are prefixed `/api/v1`. Authenticate with `Authorization: Bearer <token>` from `POST /auth/login`.

> Generated from the running application. Regenerate with `npm run docs:openapi`.


## Contents

- [Admin · Sites](#admin-sites) — 1 endpoints
- [Auth](#auth) — 12 endpoints
- [Billing](#billing) — 10 endpoints
- [Charity](#charity) — 15 endpoints
- [Claims](#claims) — 10 endpoints
- [Driver](#driver) — 12 endpoints
- [Driver Search](#driver-search) — 2 endpoints
- [Enterprise · Activation (public)](#enterprise-activation-public) — 2 endpoints
- [Enterprise · Contracts & Invoices (admin)](#enterprise-contracts-invoices-admin) — 9 endpoints
- [Enterprise · Invitations](#enterprise-invitations) — 3 endpoints
- [Enterprise · Invoices (customer)](#enterprise-invoices-customer) — 1 endpoints
- [Enterprise · Organisation Profile](#enterprise-organisation-profile) — 2 endpoints
- [Enterprise · Provisioning (Saveful admin)](#enterprise-provisioning-saveful-admin) — 10 endpoints
- [Enterprise · Reporting](#enterprise-reporting) — 10 endpoints
- [Enterprise · Roles & Permissions](#enterprise-roles-permissions) — 1 endpoints
- [Enterprise · Sites (Saveful admin)](#enterprise-sites-saveful-admin) — 2 endpoints
- [Enterprise · Structure](#enterprise-structure) — 28 endpoints
- [Enterprise · Users](#enterprise-users) — 8 endpoints
- [Farmer & Consumer](#farmer-consumer) — 8 endpoints
- [Food Listings](#food-listings) — 10 endpoints
- [Geo Search](#geo-search) — 1 endpoints
- [Health](#health) — 1 endpoints
- [Impact](#impact) — 8 endpoints
- [Notification](#notification) — 12 endpoints
- [Organization](#organization) — 2 endpoints
- [Proximity](#proximity) — 4 endpoints
- [Sites](#sites) — 10 endpoints
- [Stripe Webhook](#stripe-webhook) — 1 endpoints
- [Subscriptions](#subscriptions) — 7 endpoints


## Admin · Sites

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/admin/sites` | Bearer | List |


### `GET` /api/v1/admin/sites

List

**Auth:** Bearer token required


## Auth

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/v1/auth/forgot-password` | Public | Forgot password |
| `POST` | `/api/v1/auth/login` | Public | Login |
| `GET` | `/api/v1/auth/profile` | Bearer | Get profile |
| `PATCH` | `/api/v1/auth/profile` | Bearer | Update profile |
| `POST` | `/api/v1/auth/register/business` | Public | Register business |
| `POST` | `/api/v1/auth/register/charity` | Public | Register charity |
| `POST` | `/api/v1/auth/register/farmer-consumer` | Public | Register farmer consumer |
| `POST` | `/api/v1/auth/register/farmer-producer` | Public | Register farmer producer |
| `POST` | `/api/v1/auth/register/platform-admin` | Public | Register platform admin |
| `POST` | `/api/v1/auth/resend-verification` | Public | Send verification otp |
| `POST` | `/api/v1/auth/reset-password` | Public | Reset password |
| `POST` | `/api/v1/auth/verify-email` | Public | Verify email |


### `POST` /api/v1/auth/forgot-password

Forgot password

**Auth:** Public — no token

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `email` | `string (email)` | yes | — |


### `POST` /api/v1/auth/login

Login

**Auth:** Public — no token

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `email` | `string (email)` | yes | — |
| `password` | `string` | yes | — |


### `GET` /api/v1/auth/profile

Get profile

**Auth:** Bearer token required


### `PATCH` /api/v1/auth/profile

Update profile

**Auth:** Bearer token required

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `phoneNumber` | `string` | yes | — |


### `POST` /api/v1/auth/register/business

Register business

**Auth:** Public — no token

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `firstName` | `string` | yes | — |
| `lastName` | `string` | yes | — |
| `email` | `string (email)` | yes | — |
| `password` | `string` | yes | min length 8 |
| `mobile` | `string` | yes | — |
| `businessName` | `string` | yes | — |
| `businessAddress` | `string` | yes | — |
| `registrationNumber` | `string` | no | — |
| `brandName` | `string` | no | — |
| `venueType` | `CAFE_RESTAURANT | BAKERY | CATERER | GROCERY_STORE | FOOD_TRUCK | CATERING_SERVICE | HOTEL | WEDDING_VENUE | CLOUD_KITCHEN | FARM | PRODUCE_MARKET_GARDEN | LIVESTOCK_FARM | MIXED_FARM | ORCHARD | PROCESSING_FACILITY | OTHER` | no | — |
| `orgType` | `BUSINESS_SINGLE | BUSINESS_MULTI | CHARITY | CHARITY_SINGLE | CHARITY_MULTI | FARMER_PRODUCER | FARMER_CONSUMER` | yes | — |
| `region` | `IN | US | AU` | yes | — |
| `latitude` | `number` | yes | — |
| `longitude` | `number` | yes | — |


### `POST` /api/v1/auth/register/charity

Register charity

**Auth:** Public — no token

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `firstName` | `string` | yes | — |
| `lastName` | `string` | yes | — |
| `email` | `string (email)` | yes | — |
| `password` | `string` | yes | min length 8 |
| `mobile` | `string` | no | — |
| `charityName` | `string` | yes | — |
| `charityAddress` | `string` | yes | — |
| `registrationNumber` | `string` | no | — |
| `brandName` | `string` | no | — |
| `region` | `IN | US | AU` | yes | — |
| `latitude` | `number` | no | — |
| `longitude` | `number` | no | — |
| `charityType` | `BUSINESS_SINGLE | BUSINESS_MULTI | CHARITY | CHARITY_SINGLE | CHARITY_MULTI | FARMER_PRODUCER | FARMER_CONSUMER` | yes | — |
| `pickupPostCode` | `string` | no | — |
| `pickupRadiusKm` | `number` | no | — |


### `POST` /api/v1/auth/register/farmer-consumer

Register farmer consumer

**Auth:** Public — no token

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `firstName` | `string` | yes | — |
| `lastName` | `string` | yes | — |
| `email` | `string (email)` | yes | — |
| `password` | `string` | yes | min length 8 |
| `mobile` | `string` | no | — |
| `farmName` | `string` | yes | — |
| `businessName` | `string` | yes | — |
| `address` | `string` | yes | — |
| `brandName` | `string` | no | — |
| `venueType` | `CAFE_RESTAURANT | BAKERY | CATERER | GROCERY_STORE | FOOD_TRUCK | CATERING_SERVICE | HOTEL | WEDDING_VENUE | CLOUD_KITCHEN | FARM | PRODUCE_MARKET_GARDEN | LIVESTOCK_FARM | MIXED_FARM | ORCHARD | PROCESSING_FACILITY | OTHER` | no | — |
| `region` | `IN | US | AU` | yes | — |
| `latitude` | `number` | yes | — |
| `longitude` | `number` | yes | — |


### `POST` /api/v1/auth/register/farmer-producer

Register farmer producer

**Auth:** Public — no token

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `firstName` | `string` | yes | — |
| `lastName` | `string` | yes | — |
| `email` | `string (email)` | yes | — |
| `password` | `string` | yes | min length 8 |
| `mobileNumber` | `string` | no | — |
| `businessName` | `string` | yes | — |
| `businessAddress` | `string` | yes | — |
| `brandName` | `string` | no | — |
| `venueType` | `CAFE_RESTAURANT | BAKERY | CATERER | GROCERY_STORE | FOOD_TRUCK | CATERING_SERVICE | HOTEL | WEDDING_VENUE | CLOUD_KITCHEN | FARM | PRODUCE_MARKET_GARDEN | LIVESTOCK_FARM | MIXED_FARM | ORCHARD | PROCESSING_FACILITY | OTHER` | no | — |
| `orgType` | `BUSINESS_SINGLE | BUSINESS_MULTI | CHARITY | CHARITY_SINGLE | CHARITY_MULTI | FARMER_PRODUCER | FARMER_CONSUMER` | yes | — |
| `region` | `IN | US | AU` | yes | — |
| `latitude` | `number` | yes | — |
| `longitude` | `number` | yes | — |


### `POST` /api/v1/auth/register/platform-admin

Register platform admin

**Auth:** Public — no token

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `firstName` | `string` | yes | — |
| `lastName` | `string` | yes | — |
| `email` | `string (email)` | yes | — |
| `password` | `string` | yes | min length 8 |


### `POST` /api/v1/auth/resend-verification

Send verification otp

**Auth:** Public — no token

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `email` | `string` | yes | — |


### `POST` /api/v1/auth/reset-password

Reset password

**Auth:** Public — no token

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `email` | `string (email)` | yes | — |
| `otp` | `string` | yes | — |
| `newPassword` | `string` | yes | min length 8 |


### `POST` /api/v1/auth/verify-email

Verify email

**Auth:** Public — no token

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `email` | `string (email)` | yes | — |
| `otp` | `string` | yes | — |


## Billing

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/v1/billing/cancel` | Bearer | Ends the plan at the close of the paid period — access continues until then. |
| `POST` | `/api/v1/billing/change-plan` | Bearer | Switches an already-subscribed org between plans. Upgrades bill the |
| `DELETE` | `/api/v1/billing/change-plan/pending` | Bearer | Cancel pending change |
| `POST` | `/api/v1/billing/change-plan/preview` | Bearer | Dry run of `change-plan` — backs the confirmation dialog. |
| `POST` | `/api/v1/billing/checkout` | Bearer | Returns a Stripe-hosted Checkout URL for the client to redirect to. |
| `POST` | `/api/v1/billing/enterprise-enquiry` | Bearer | Enterprise enquiry |
| `GET` | `/api/v1/billing/payments` | Bearer | List payments |
| `POST` | `/api/v1/billing/portal` | Bearer | Stripe billing portal — card updates, invoices, self-serve cancellation. |
| `POST` | `/api/v1/billing/resume` | Bearer | Undoes a scheduled cancellation before the period closes. |
| `POST` | `/api/v1/billing/trial` | Bearer | Starts the 30-day trial. Returns a Checkout URL — no card is required up |


### `POST` /api/v1/billing/cancel

Ends the plan at the close of the paid period — access continues until then.

**Auth:** Bearer token required


### `POST` /api/v1/billing/change-plan

Switches an already-subscribed org between plans. Upgrades bill the

**Auth:** Bearer token required

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `planId` | `number` | yes | — |
| `billingCycle` | `MONTHLY | ANNUAL` | no | — |


### `DELETE` /api/v1/billing/change-plan/pending

Cancel pending change

**Auth:** Bearer token required


### `POST` /api/v1/billing/change-plan/preview

Dry run of `change-plan` — backs the confirmation dialog.

**Auth:** Bearer token required

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `planId` | `number` | yes | — |
| `billingCycle` | `MONTHLY | ANNUAL` | no | — |


### `POST` /api/v1/billing/checkout

Returns a Stripe-hosted Checkout URL for the client to redirect to.

**Auth:** Bearer token required

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `planId` | `number` | yes | — |
| `billingCycle` | `MONTHLY | ANNUAL` | yes | — |


### `POST` /api/v1/billing/enterprise-enquiry

Enterprise enquiry

**Auth:** Bearer token required

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `firstName` | `string` | yes | — |
| `lastName` | `string` | yes | — |
| `businessName` | `string` | yes | — |
| `businessType` | `string` | yes | — |
| `mobile` | `string` | yes | — |
| `locationBand` | `BAND_10_25 | BAND_26_50 | BAND_51_100 | BAND_100_PLUS` | yes | — |
| `contactWindow` | `ASAP | MORNING | AFTERNOON | ANY_TIME` | yes | — |
| `message` | `string` | no | max length 2000 |


### `GET` /api/v1/billing/payments

List payments

**Auth:** Bearer token required


### `POST` /api/v1/billing/portal

Stripe billing portal — card updates, invoices, self-serve cancellation.

**Auth:** Bearer token required


### `POST` /api/v1/billing/resume

Undoes a scheduled cancellation before the period closes.

**Auth:** Bearer token required


### `POST` /api/v1/billing/trial

Starts the 30-day trial. Returns a Checkout URL — no card is required up

**Auth:** Bearer token required

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `planId` | `number` | yes | — |
| `billingCycle` | `MONTHLY | ANNUAL` | no | — |


## Charity

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/charity/locations` | Bearer | List locations |
| `POST` | `/api/v1/charity/locations` | Bearer | Add location |
| `GET` | `/api/v1/charity/locations/{id}` | Bearer | Get location |
| `PATCH` | `/api/v1/charity/locations/{id}` | Bearer | Update location |
| `DELETE` | `/api/v1/charity/locations/{id}` | Bearer | Deactivate location |
| `POST` | `/api/v1/charity/locations/{id}/activate` | Bearer | Reactivate location |
| `GET` | `/api/v1/charity/users` | Bearer | List users |
| `POST` | `/api/v1/charity/users` | Bearer | Add member |
| `GET` | `/api/v1/charity/users/{userId}` | Bearer | Get user |
| `PATCH` | `/api/v1/charity/users/{userId}` | Bearer | Update user |
| `DELETE` | `/api/v1/charity/users/{userId}` | Bearer | Delete user |
| `POST` | `/api/v1/charity/users/{userId}/activate` | Bearer | Activate user |
| `POST` | `/api/v1/charity/users/{userId}/deactivate` | Bearer | Deactivate user |
| `DELETE` | `/api/v1/charity/users/{userId}/locations/{locationId}` | Bearer | Remove user from location |
| `POST` | `/api/v1/charity/users/{userId}/resend-invite` | Bearer | Resend invite |


### `GET` /api/v1/charity/locations

List locations

**Auth:** Bearer token required


### `POST` /api/v1/charity/locations

Add location

**Auth:** Bearer token required

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `locationName` | `string` | yes | — |
| `address` | `string` | yes | — |
| `postcode` | `string` | yes | — |
| `adminContactName` | `string` | yes | — |
| `adminEmail` | `string (email)` | yes | — |
| `adminMobile` | `string` | yes | — |
| `adminPassword` | `string` | yes | min length 8 |
| `radiusKm` | `number` | no | — |
| `latitude` | `number` | no | — |
| `longitude` | `number` | no | — |


### `GET` /api/v1/charity/locations/{id}

Get location

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |


### `PATCH` /api/v1/charity/locations/{id}

Update location

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `locationName` | `string` | no | — |
| `address` | `string` | no | — |
| `postcode` | `string` | no | — |
| `contactName` | `string` | no | — |
| `contactEmail` | `string (email)` | no | — |
| `contactMobile` | `string` | no | — |
| `radiusKm` | `number` | no | — |
| `pickupRadiusKm` | `number` | no | — |
| `latitude` | `number` | no | — |
| `longitude` | `number` | no | — |


### `DELETE` /api/v1/charity/locations/{id}

Deactivate location

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |


### `POST` /api/v1/charity/locations/{id}/activate

Reactivate location

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |


### `GET` /api/v1/charity/users

List users

**Auth:** Bearer token required


### `POST` /api/v1/charity/users

Add member

**Auth:** Bearer token required

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `firstName` | `string` | yes | — |
| `lastName` | `string` | yes | — |
| `email` | `string (email)` | yes | — |
| `mobile` | `string` | no | — |
| `role` | `HEAD_OFFICE_ADMIN | HEAD_OFFICE | LOCATION_ADMIN | TEAM_MEMBER | DRIVER` | yes | — |
| `password` | `string` | yes | min length 8 |
| `locationId` | `number` | no | — |
| `canClaimPickupsDirectly` | `boolean` | no | — |


### `GET` /api/v1/charity/users/{userId}

Get user

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `userId` | path | yes | number |


### `PATCH` /api/v1/charity/users/{userId}

Update user

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `userId` | path | yes | number |

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `firstName` | `string` | no | — |
| `lastName` | `string` | no | — |
| `mobile` | `string` | no | — |
| `canClaimPickupsDirectly` | `boolean` | no | — |


### `DELETE` /api/v1/charity/users/{userId}

Delete user

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `userId` | path | yes | number |


### `POST` /api/v1/charity/users/{userId}/activate

Activate user

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `userId` | path | yes | number |


### `POST` /api/v1/charity/users/{userId}/deactivate

Deactivate user

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `userId` | path | yes | number |


### `DELETE` /api/v1/charity/users/{userId}/locations/{locationId}

Remove user from location

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `userId` | path | yes | number |
| `locationId` | path | yes | number |


### `POST` /api/v1/charity/users/{userId}/resend-invite

Resend invite

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `userId` | path | yes | number |

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `newPassword` | `string` | yes | min length 8 |


## Claims

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/v1/claims` | Bearer | Claim |
| `GET` | `/api/v1/claims/listing/{listingId}` | Bearer | Get listing claims |
| `GET` | `/api/v1/claims/listing/{listingId}/activity` | Bearer | Get claim activity |
| `GET` | `/api/v1/claims/my` | Bearer | Get my claims |
| `DELETE` | `/api/v1/claims/{id}` | Bearer | Cancel |
| `PATCH` | `/api/v1/claims/{id}/collected` | Bearer | Mark collected |
| `PATCH` | `/api/v1/claims/{id}/confirm` | Bearer | Confirm |
| `PATCH` | `/api/v1/claims/{id}/provider-feedback` | Bearer | Restaurant confirms collection and rates the charity/farmer. |
| `PATCH` | `/api/v1/claims/{id}/rating` | Bearer | Submit / update feedback for a collected claim. |
| `POST` | `/api/v1/claims/{id}/request-driver` | Bearer | Request driver |


### `POST` /api/v1/claims

Claim

**Auth:** Bearer token required

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `listingId` | `number` | yes | — |
| `claimMode` | `PARTIAL | FULL` | yes | — |
| `claimItems` | `ClaimItemDto[]` | no | — |
| `claimItems[].foodItemId` | `number` | yes | — |
| `claimItems[].qtyKg` | `number` | yes | min 1 |


### `GET` /api/v1/claims/listing/{listingId}

Get listing claims

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `listingId` | path | yes | number |


### `GET` /api/v1/claims/listing/{listingId}/activity

Get claim activity

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `listingId` | path | yes | number |


### `GET` /api/v1/claims/my

Get my claims

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `status` | query | no | string |
| `limit` | query | no | any |
| `page` | query | no | any |


### `DELETE` /api/v1/claims/{id}

Cancel

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |


### `PATCH` /api/v1/claims/{id}/collected

Mark collected

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `rating` | `number` | no | min 1, max 5 |
| `ratingNote` | `string` | no | — |


### `PATCH` /api/v1/claims/{id}/confirm

Confirm

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |


### `PATCH` /api/v1/claims/{id}/provider-feedback

Restaurant confirms collection and rates the charity/farmer.

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `didCollect` | `boolean` | yes | — |
| `rating` | `number` | no | min 1, max 5 |
| `ratingNote` | `string` | no | — |


### `PATCH` /api/v1/claims/{id}/rating

Submit / update feedback for a collected claim.

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `rating` | `number` | yes | min 1, max 5 |
| `ratingNote` | `string` | no | — |


### `POST` /api/v1/claims/{id}/request-driver

Request driver

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |


## Driver

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/v1/drivers/live` | Bearer | Go live |
| `DELETE` | `/api/v1/drivers/live` | Bearer | Go offline |
| `POST` | `/api/v1/drivers/pickup/accept` | Bearer | Accept pickup |
| `GET` | `/api/v1/drivers/pickups` | Bearer | Get my pickups |
| `POST` | `/api/v1/drivers/pickups/assign` | Bearer | Assign driver |
| `GET` | `/api/v1/drivers/pickups/{id}` | Bearer | Get pickup details |
| `POST` | `/api/v1/drivers/pickups/{id}/complete` | Bearer | Complete pickup |
| `PATCH` | `/api/v1/drivers/pickups/{id}/respond` | Bearer | Respond to assignment |
| `PATCH` | `/api/v1/drivers/pickups/{id}/status` | Bearer | Update status |
| `GET` | `/api/v1/drivers/site/{siteId}/drivers` | Bearer | All drivers for a site with online/offline status. |
| `GET` | `/api/v1/drivers/site/{siteId}/live` | Bearer | List drivers currently live on a site (for charity/farmer assignment UI). |
| `GET` | `/api/v1/drivers/unclaimed-claims` | Bearer | Claims owned by the org that still need a driver (assign dropdown). |


### `POST` /api/v1/drivers/live

Go live

**Auth:** Bearer token required

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `siteId` | `number` | yes | — |
| `lat` | `number` | yes | min -90, max 90 |
| `lng` | `number` | yes | min -180, max 180 |
| `vehicleType` | `string` | no | — |


### `DELETE` /api/v1/drivers/live

Go offline

**Auth:** Bearer token required

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `siteId` | `number` | yes | — |


### `POST` /api/v1/drivers/pickup/accept

Accept pickup

**Auth:** Bearer token required

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `claimId` | `number` | yes | — |
| `listingId` | `number` | yes | — |


### `GET` /api/v1/drivers/pickups

Get my pickups

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `filter` | query | no | string |


### `POST` /api/v1/drivers/pickups/assign

Assign driver

**Auth:** Bearer token required

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `claimId` | `number` | yes | — |
| `listingId` | `number` | yes | — |
| `driverId` | `number` | yes | — |


### `GET` /api/v1/drivers/pickups/{id}

Get pickup details

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |


### `POST` /api/v1/drivers/pickups/{id}/complete

Complete pickup

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `notes` | `string` | no | — |
| `rating` | `number` | no | min 1, max 5 |


### `PATCH` /api/v1/drivers/pickups/{id}/respond

Respond to assignment

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `accept` | `boolean` | yes | — |


### `PATCH` /api/v1/drivers/pickups/{id}/status

Update status

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `status` | `CANCELLED | COLLECTED | ASSIGNED | ACCEPTED | EN_ROUTE | ARRIVED` | yes | — |


### `GET` /api/v1/drivers/site/{siteId}/drivers

All drivers for a site with online/offline status.

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `siteId` | path | yes | number |


### `GET` /api/v1/drivers/site/{siteId}/live

List drivers currently live on a site (for charity/farmer assignment UI).

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `siteId` | path | yes | number |


### `GET` /api/v1/drivers/unclaimed-claims

Claims owned by the org that still need a driver (assign dropdown).

**Auth:** Bearer token required


## Driver Search

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/v1/search/driver/add-driver` | Public | Add driver |
| `GET` | `/api/v1/search/driver/nearby-driver` | Public | Get nearby drivers |


### `POST` /api/v1/search/driver/add-driver

Add driver

**Auth:** Public — no token


### `GET` /api/v1/search/driver/nearby-driver

Get nearby drivers

**Auth:** Public — no token


## Enterprise · Activation (public)

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/enterprise/invitations/{token}` | Public | What the activation screen shows before the password form: the Enterprise |
| `POST` | `/api/v1/enterprise/invitations/{token}/accept` | Public | Creates the account with the user's own password and marks it Active. |


### `GET` /api/v1/enterprise/invitations/{token}

What the activation screen shows before the password form: the Enterprise

**Auth:** Public — no token

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `token` | path | yes | string |


### `POST` /api/v1/enterprise/invitations/{token}/accept

Creates the account with the user's own password and marks it Active.

**Auth:** Public — no token

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `token` | path | yes | string |

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `password` | `string` | yes | min length 10, max length 128 |
| `acceptTerms` | `boolean` | yes | — |


## Enterprise · Contracts & Invoices (admin)

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/enterprise/admin/contracts` | Bearer | List contracts |
| `POST` | `/api/v1/enterprise/admin/contracts` | Bearer | Create contract |
| `GET` | `/api/v1/enterprise/admin/contracts/{organisationId}` | Bearer | Get contract |
| `PATCH` | `/api/v1/enterprise/admin/contracts/{organisationId}` | Bearer | Update contract |
| `GET` | `/api/v1/enterprise/admin/invoices` | Bearer | List invoices |
| `POST` | `/api/v1/enterprise/admin/invoices/generate` | Bearer | Raise an invoice now rather than waiting for the cron. |
| `GET` | `/api/v1/enterprise/admin/invoices/{id}` | Bearer | Get invoice |
| `POST` | `/api/v1/enterprise/admin/invoices/{id}/cancel` | Bearer | Cancel invoice |
| `POST` | `/api/v1/enterprise/admin/invoices/{id}/mark-paid` | Bearer | Records an offline payment — bank transfer reference, cheque, etc. |


### `GET` /api/v1/enterprise/admin/contracts

List contracts

**Auth:** Bearer token required


### `POST` /api/v1/enterprise/admin/contracts

Create contract

**Auth:** Bearer token required

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `organisationId` | `number` | yes | — |
| `ratePerSite` | `number` | yes | min 0 |
| `currency` | `string` | no | max length 3 |
| `billingFrequency` | `MONTHLY | ANNUAL | QUARTERLY` | no | — |
| `contractedSiteCount` | `number` | no | — |
| `taxRatePercent` | `number` | no | min 0 |
| `startDate` | `string` | yes | — |
| `endDate` | `string` | no | — |
| `paymentTermsDays` | `number` | no | min 0 |
| `notes` | `string` | no | max length 2000 |


### `GET` /api/v1/enterprise/admin/contracts/{organisationId}

Get contract

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `organisationId` | path | yes | number |


### `PATCH` /api/v1/enterprise/admin/contracts/{organisationId}

Update contract

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `organisationId` | path | yes | number |

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `ratePerSite` | `number` | no | min 0 |
| `billingFrequency` | `MONTHLY | ANNUAL | QUARTERLY` | no | — |
| `contractedSiteCount` | `number` | no | — |
| `taxRatePercent` | `number` | no | min 0 |
| `endDate` | `string` | no | — |
| `status` | `ACTIVE | EXPIRED | DRAFT | TERMINATED` | no | — |
| `paymentTermsDays` | `number` | no | min 0 |
| `notes` | `string` | no | max length 2000 |


### `GET` /api/v1/enterprise/admin/invoices

List invoices

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `organisationId` | query | no | string |
| `status` | query | no | string |


### `POST` /api/v1/enterprise/admin/invoices/generate

Raise an invoice now rather than waiting for the cron.

**Auth:** Bearer token required

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `organisationId` | `number` | yes | — |
| `periodStart` | `string` | no | — |


### `GET` /api/v1/enterprise/admin/invoices/{id}

Get invoice

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |


### `POST` /api/v1/enterprise/admin/invoices/{id}/cancel

Cancel invoice

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |


### `POST` /api/v1/enterprise/admin/invoices/{id}/mark-paid

Records an offline payment — bank transfer reference, cheque, etc.

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `paymentReference` | `string` | yes | max length 120 |
| `paidAt` | `string` | no | — |
| `notes` | `string` | no | max length 2000 |


## Enterprise · Invitations

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/enterprise/invites` | Bearer | List |
| `DELETE` | `/api/v1/enterprise/invites/{invitationId}` | Bearer | Revoke |
| `POST` | `/api/v1/enterprise/invites/{invitationId}/resend` | Bearer | Resend |


### `GET` /api/v1/enterprise/invites

List

**Auth:** Bearer token required


### `DELETE` /api/v1/enterprise/invites/{invitationId}

Revoke

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `invitationId` | path | yes | number |


### `POST` /api/v1/enterprise/invites/{invitationId}/resend

Resend

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `invitationId` | path | yes | number |


## Enterprise · Invoices (customer)

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/enterprise/invoices` | Bearer | List mine |


### `GET` /api/v1/enterprise/invoices

List mine

**Auth:** Bearer token required


## Enterprise · Organisation Profile

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/enterprise/profile` | Bearer | Returns editable and read-only fields separately, so the UI can lock the latter. |
| `PATCH` | `/api/v1/enterprise/profile` | Bearer | Update |


### `GET` /api/v1/enterprise/profile

Returns editable and read-only fields separately, so the UI can lock the latter.

**Auth:** Bearer token required


### `PATCH` /api/v1/enterprise/profile

Update

**Auth:** Bearer token required

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `enterpriseName` | `string` | no | max length 160 |
| `primaryContactName` | `string` | no | max length 120 |
| `primaryContactEmail` | `string (email)` | no | — |
| `primaryContactPhone` | `string` | no | max length 30 |
| `logoUrl` | `string` | no | max length 500 |
| `timezone` | `string` | no | max length 80 |
| `measurementUnit` | `METRIC | IMPERIAL` | no | — |


## Enterprise · Provisioning (Saveful admin)

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/admin/enterprise` | Bearer | List |
| `POST` | `/api/v1/admin/enterprise/logo` | Bearer | Upload logo |
| `POST` | `/api/v1/admin/enterprise/provision` | Bearer | Creates the Enterprise and invites its first Super Admin. |
| `GET` | `/api/v1/admin/enterprise/sites` | Bearer | List sites |
| `GET` | `/api/v1/admin/enterprise/users` | Bearer | List all users |
| `GET` | `/api/v1/admin/enterprise/{organisationId}` | Bearer | Get one |
| `PATCH` | `/api/v1/admin/enterprise/{organisationId}/provisioning` | Bearer | Account status, country, timezone, currency and units. |
| `GET` | `/api/v1/admin/enterprise/{organisationId}/structure` | Bearer | Get structure |
| `GET` | `/api/v1/admin/enterprise/{organisationId}/users` | Bearer | List users |
| `POST` | `/api/v1/admin/enterprise/{organisationId}/users` | Bearer | Invite user |


### `GET` /api/v1/admin/enterprise

List

**Auth:** Bearer token required


### `POST` /api/v1/admin/enterprise/logo

Upload logo

**Auth:** Bearer token required


### `POST` /api/v1/admin/enterprise/provision

Creates the Enterprise and invites its first Super Admin.

**Auth:** Bearer token required

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `enterpriseName` | `string` | yes | max length 160 |
| `enterpriseId` | `string` | no | max length 40 |
| `address` | `string` | yes | max length 200 |
| `country` | `string` | yes | max length 80 |
| `timezone` | `string` | yes | max length 80 |
| `currency` | `string` | no | max length 3 |
| `measurementUnit` | `METRIC | IMPERIAL` | no | — |
| `region` | `IN | US | AU` | no | — |
| `logoUrl` | `string` | no | max length 500 |
| `adminFirstName` | `string` | yes | max length 80 |
| `adminLastName` | `string` | yes | max length 80 |
| `adminEmail` | `string (email)` | yes | — |
| `adminMobile` | `string` | no | max length 30 |


### `GET` /api/v1/admin/enterprise/sites

List sites

**Auth:** Bearer token required


### `GET` /api/v1/admin/enterprise/users

List all users

**Auth:** Bearer token required


### `GET` /api/v1/admin/enterprise/{organisationId}

Get one

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `organisationId` | path | yes | number |


### `PATCH` /api/v1/admin/enterprise/{organisationId}/provisioning

Account status, country, timezone, currency and units.

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `organisationId` | path | yes | number |

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `accountStatus` | `ACTIVE | PENDING | CLOSED | SUSPENDED` | no | — |
| `country` | `string` | no | max length 80 |
| `timezone` | `string` | no | max length 80 |
| `currency` | `string` | no | max length 3 |
| `measurementUnit` | `METRIC | IMPERIAL` | no | — |


### `GET` /api/v1/admin/enterprise/{organisationId}/structure

Get structure

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `organisationId` | path | yes | number |


### `GET` /api/v1/admin/enterprise/{organisationId}/users

List users

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `organisationId` | path | yes | number |


### `POST` /api/v1/admin/enterprise/{organisationId}/users

Invite user

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `organisationId` | path | yes | number |

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `firstName` | `string` | yes | max length 80 |
| `lastName` | `string` | yes | max length 80 |
| `email` | `string (email)` | yes | — |
| `mobile` | `string` | no | max length 30 |
| `role` | `SUPER_ADMIN | ENTERPRISE_ADMIN | REPORTING_USER | GROUP_ADMIN | CLUSTER_ADMIN | SITE_ADMIN | SITE_USER` | yes | — |
| `scopes` | `ScopeGrantDto[]` | no | — |
| `scopes[].scopeType` | `ENTERPRISE | GROUP | CLUSTER | TERRITORY | SITE` | yes | — |
| `scopes[].scopeId` | `number` | no | — |
| `siteAdminForSiteId` | `number` | no | — |


## Enterprise · Reporting

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/enterprise/reports/breakdown` | Bearer | One level down from the Enterprise — impact per group. |
| `GET` | `/api/v1/enterprise/reports/clusters/{id}/breakdown` | Bearer | Cluster breakdown |
| `GET` | `/api/v1/enterprise/reports/clusters/{id}/impact` | Bearer | Cluster impact |
| `GET` | `/api/v1/enterprise/reports/dashboard` | Bearer | Dashboard |
| `GET` | `/api/v1/enterprise/reports/groups/{id}/breakdown` | Bearer | Group breakdown |
| `GET` | `/api/v1/enterprise/reports/groups/{id}/impact` | Bearer | Group impact |
| `GET` | `/api/v1/enterprise/reports/impact` | Bearer | Enterprise impact |
| `GET` | `/api/v1/enterprise/reports/sites/rankings` | Bearer | Site league table plus active / inactive / never-used / deactivated counts. |
| `GET` | `/api/v1/enterprise/reports/sites/{id}/impact` | Bearer | Site impact |
| `GET` | `/api/v1/enterprise/reports/territories/{id}/impact` | Bearer | Territory impact |


### `GET` /api/v1/enterprise/reports/breakdown

One level down from the Enterprise — impact per group.

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `startDate` | query | no | string |
| `endDate` | query | no | string |


### `GET` /api/v1/enterprise/reports/clusters/{id}/breakdown

Cluster breakdown

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |
| `startDate` | query | no | string |
| `endDate` | query | no | string |


### `GET` /api/v1/enterprise/reports/clusters/{id}/impact

Cluster impact

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |
| `startDate` | query | no | string |
| `endDate` | query | no | string |


### `GET` /api/v1/enterprise/reports/dashboard

Dashboard

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `startDate` | query | no | string |
| `endDate` | query | no | string |


### `GET` /api/v1/enterprise/reports/groups/{id}/breakdown

Group breakdown

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |
| `startDate` | query | no | string |
| `endDate` | query | no | string |


### `GET` /api/v1/enterprise/reports/groups/{id}/impact

Group impact

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |
| `startDate` | query | no | string |
| `endDate` | query | no | string |


### `GET` /api/v1/enterprise/reports/impact

Enterprise impact

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `startDate` | query | no | string |
| `endDate` | query | no | string |


### `GET` /api/v1/enterprise/reports/sites/rankings

Site league table plus active / inactive / never-used / deactivated counts.

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `scopeType` | query | no | string |
| `scopeId` | query | no | string |
| `startDate` | query | no | string |
| `endDate` | query | no | string |


### `GET` /api/v1/enterprise/reports/sites/{id}/impact

Site impact

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |
| `startDate` | query | no | string |
| `endDate` | query | no | string |


### `GET` /api/v1/enterprise/reports/territories/{id}/impact

Territory impact

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |
| `startDate` | query | no | string |
| `endDate` | query | no | string |


## Enterprise · Roles & Permissions

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/enterprise/roles` | Bearer | List |


### `GET` /api/v1/enterprise/roles

List

**Auth:** Bearer token required


## Enterprise · Sites (Saveful admin)

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/v1/admin/enterprise/{organisationId}/sites` | Bearer | Create site |
| `POST` | `/api/v1/admin/enterprise/{organisationId}/sites/{siteId}/assign-admin` | Bearer | Assign existing site admin |


### `POST` /api/v1/admin/enterprise/{organisationId}/sites

Create site

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `organisationId` | path | yes | number |

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `siteName` | `string` | yes | max length 160 |
| `address` | `string` | yes | — |
| `postcode` | `string` | no | max length 20 |
| `siteCode` | `string` | no | max length 40 |
| `contactName` | `string` | no | max length 120 |
| `contactEmail` | `string (email)` | no | — |
| `phoneNumber` | `string` | no | max length 30 |
| `latitude` | `number` | yes | — |
| `longitude` | `number` | yes | — |
| `collectionDays` | `mon | tue | wed | thu | fri | sat | sun[]` | no | — |
| `collectionStartTime` | `string` | no | — |
| `collectionEndTime` | `string` | no | — |
| `collectionInstructions` | `string` | no | max length 500 |
| `groupId` | `number` | no | — |
| `clusterId` | `number` | no | — |
| `territoryId` | `number` | no | — |


### `POST` /api/v1/admin/enterprise/{organisationId}/sites/{siteId}/assign-admin

Assign existing site admin

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `organisationId` | path | yes | number |
| `siteId` | path | yes | number |

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `userId` | `number` | yes | — |


## Enterprise · Structure

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/enterprise/clusters` | Bearer | List clusters |
| `POST` | `/api/v1/enterprise/clusters` | Bearer | Create cluster |
| `DELETE` | `/api/v1/enterprise/clusters/sites/{siteId}` | Bearer | Unassign site from cluster |
| `GET` | `/api/v1/enterprise/clusters/{id}` | Bearer | Get cluster |
| `PATCH` | `/api/v1/enterprise/clusters/{id}` | Bearer | Update cluster |
| `DELETE` | `/api/v1/enterprise/clusters/{id}` | Bearer | Delete cluster |
| `POST` | `/api/v1/enterprise/clusters/{id}/deactivate` | Bearer | Deactivate cluster |
| `POST` | `/api/v1/enterprise/clusters/{id}/reactivate` | Bearer | Reactivate cluster |
| `POST` | `/api/v1/enterprise/clusters/{id}/sites` | Bearer | Assign sites to cluster |
| `GET` | `/api/v1/enterprise/groups` | Bearer | List groups |
| `POST` | `/api/v1/enterprise/groups` | Bearer | Create group |
| `DELETE` | `/api/v1/enterprise/groups/sites/{siteId}` | Bearer | Unassign site from group |
| `GET` | `/api/v1/enterprise/groups/{id}` | Bearer | Get group |
| `PATCH` | `/api/v1/enterprise/groups/{id}` | Bearer | Update group |
| `DELETE` | `/api/v1/enterprise/groups/{id}` | Bearer | Refused where history or sites exist — deactivate those instead. |
| `POST` | `/api/v1/enterprise/groups/{id}/deactivate` | Bearer | Retires a group without touching the sites in it. |
| `POST` | `/api/v1/enterprise/groups/{id}/reactivate` | Bearer | Reactivate group |
| `POST` | `/api/v1/enterprise/groups/{id}/sites` | Bearer | Assign sites to group |
| `GET` | `/api/v1/enterprise/structure` | Bearer | All three dimensions side by side, plus what is unplaced in each. |
| `GET` | `/api/v1/enterprise/territories` | Bearer | List territories |
| `POST` | `/api/v1/enterprise/territories` | Bearer | Create territory |
| `DELETE` | `/api/v1/enterprise/territories/sites/{siteId}` | Bearer | Unassign site from territory |
| `GET` | `/api/v1/enterprise/territories/{id}` | Bearer | Get territory |
| `PATCH` | `/api/v1/enterprise/territories/{id}` | Bearer | Update territory |
| `DELETE` | `/api/v1/enterprise/territories/{id}` | Bearer | Delete territory |
| `POST` | `/api/v1/enterprise/territories/{id}/deactivate` | Bearer | Deactivate territory |
| `POST` | `/api/v1/enterprise/territories/{id}/reactivate` | Bearer | Reactivate territory |
| `POST` | `/api/v1/enterprise/territories/{id}/sites` | Bearer | Assign sites to territory |


### `GET` /api/v1/enterprise/clusters

List clusters

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `includeInactive` | query | no | boolean |
| `search` | query | no | string |


### `POST` /api/v1/enterprise/clusters

Create cluster

**Auth:** Bearer token required

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `name` | `string` | yes | max length 120 |
| `code` | `string` | no | max length 40 |
| `description` | `string` | no | max length 500 |


### `DELETE` /api/v1/enterprise/clusters/sites/{siteId}

Unassign site from cluster

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `siteId` | path | yes | number |


### `GET` /api/v1/enterprise/clusters/{id}

Get cluster

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |


### `PATCH` /api/v1/enterprise/clusters/{id}

Update cluster

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `name` | `string` | no | max length 120 |
| `code` | `string` | no | max length 40 |
| `description` | `string` | no | max length 500 |


### `DELETE` /api/v1/enterprise/clusters/{id}

Delete cluster

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |


### `POST` /api/v1/enterprise/clusters/{id}/deactivate

Deactivate cluster

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |


### `POST` /api/v1/enterprise/clusters/{id}/reactivate

Reactivate cluster

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |


### `POST` /api/v1/enterprise/clusters/{id}/sites

Assign sites to cluster

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `siteIds` | `number[]` | yes | min 1 item(s) |


### `GET` /api/v1/enterprise/groups

List groups

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `includeInactive` | query | no | boolean |
| `search` | query | no | string |


### `POST` /api/v1/enterprise/groups

Create group

**Auth:** Bearer token required

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `name` | `string` | yes | max length 120 |
| `code` | `string` | no | max length 40 |
| `description` | `string` | no | max length 500 |


### `DELETE` /api/v1/enterprise/groups/sites/{siteId}

Unassign site from group

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `siteId` | path | yes | number |


### `GET` /api/v1/enterprise/groups/{id}

Get group

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |


### `PATCH` /api/v1/enterprise/groups/{id}

Update group

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `name` | `string` | no | max length 120 |
| `code` | `string` | no | max length 40 |
| `description` | `string` | no | max length 500 |


### `DELETE` /api/v1/enterprise/groups/{id}

Refused where history or sites exist — deactivate those instead.

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |


### `POST` /api/v1/enterprise/groups/{id}/deactivate

Retires a group without touching the sites in it.

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |


### `POST` /api/v1/enterprise/groups/{id}/reactivate

Reactivate group

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |


### `POST` /api/v1/enterprise/groups/{id}/sites

Assign sites to group

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `siteIds` | `number[]` | yes | min 1 item(s) |


### `GET` /api/v1/enterprise/structure

All three dimensions side by side, plus what is unplaced in each.

**Auth:** Bearer token required


### `GET` /api/v1/enterprise/territories

List territories

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `includeInactive` | query | no | boolean |
| `search` | query | no | string |


### `POST` /api/v1/enterprise/territories

Create territory

**Auth:** Bearer token required

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `name` | `string` | yes | max length 120 |
| `code` | `string` | no | max length 40 |
| `description` | `string` | no | max length 500 |


### `DELETE` /api/v1/enterprise/territories/sites/{siteId}

Unassign site from territory

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `siteId` | path | yes | number |


### `GET` /api/v1/enterprise/territories/{id}

Get territory

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |


### `PATCH` /api/v1/enterprise/territories/{id}

Update territory

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `name` | `string` | no | max length 120 |
| `code` | `string` | no | max length 40 |
| `description` | `string` | no | max length 500 |


### `DELETE` /api/v1/enterprise/territories/{id}

Delete territory

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |


### `POST` /api/v1/enterprise/territories/{id}/deactivate

Deactivate territory

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |


### `POST` /api/v1/enterprise/territories/{id}/reactivate

Reactivate territory

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |


### `POST` /api/v1/enterprise/territories/{id}/sites

Assign sites to territory

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `siteIds` | `number[]` | yes | min 1 item(s) |


## Enterprise · Users

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/enterprise/users` | Bearer | Everyone in the Enterprise — members and people still on an invitation — |
| `POST` | `/api/v1/enterprise/users` | Bearer | Invite |
| `GET` | `/api/v1/enterprise/users/{userId}` | Bearer | Get |
| `PATCH` | `/api/v1/enterprise/users/{userId}` | Bearer | Update |
| `POST` | `/api/v1/enterprise/users/{userId}/activate` | Bearer | Activate |
| `POST` | `/api/v1/enterprise/users/{userId}/deactivate` | Bearer | Deactivate |
| `POST` | `/api/v1/enterprise/users/{userId}/resend-invite` | Bearer | Reissues an activation link for a member. No password is ever set here. |
| `PUT` | `/api/v1/enterprise/users/{userId}/scopes` | Bearer | Replaces the user's scope grants wholesale. |


### `GET` /api/v1/enterprise/users

Everyone in the Enterprise — members and people still on an invitation —

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `page` | query | no | number |
| `pageSize` | query | no | number |
| `search` | query | no | string |
| `role` | query | no | SUPER_ADMIN | ENTERPRISE_ADMIN | REPORTING_USER | GROUP_ADMIN | CLUSTER_ADMIN | SITE_ADMIN | SITE_USER |
| `status` | query | no | ACTIVE | INVITED | DEACTIVATED |
| `scopeType` | query | no | ENTERPRISE | GROUP | CLUSTER | TERRITORY | SITE |
| `scopeId` | query | no | number |


### `POST` /api/v1/enterprise/users

Invite

**Auth:** Bearer token required

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `firstName` | `string` | yes | max length 80 |
| `lastName` | `string` | yes | max length 80 |
| `email` | `string (email)` | yes | — |
| `mobile` | `string` | no | max length 30 |
| `role` | `SUPER_ADMIN | ENTERPRISE_ADMIN | REPORTING_USER | GROUP_ADMIN | CLUSTER_ADMIN | SITE_ADMIN | SITE_USER` | yes | — |
| `scopes` | `ScopeGrantDto[]` | no | — |
| `scopes[].scopeType` | `ENTERPRISE | GROUP | CLUSTER | TERRITORY | SITE` | yes | — |
| `scopes[].scopeId` | `number` | no | — |
| `siteAdminForSiteId` | `number` | no | — |


### `GET` /api/v1/enterprise/users/{userId}

Get

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `userId` | path | yes | number |


### `PATCH` /api/v1/enterprise/users/{userId}

Update

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `userId` | path | yes | number |

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `firstName` | `string` | no | — |
| `lastName` | `string` | no | — |
| `mobile` | `string` | no | — |
| `role` | `SUPER_ADMIN | ENTERPRISE_ADMIN | REPORTING_USER | GROUP_ADMIN | CLUSTER_ADMIN | SITE_ADMIN | SITE_USER` | no | — |


### `POST` /api/v1/enterprise/users/{userId}/activate

Activate

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `userId` | path | yes | number |


### `POST` /api/v1/enterprise/users/{userId}/deactivate

Deactivate

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `userId` | path | yes | number |


### `POST` /api/v1/enterprise/users/{userId}/resend-invite

Reissues an activation link for a member. No password is ever set here.

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `userId` | path | yes | number |


### `PUT` /api/v1/enterprise/users/{userId}/scopes

Replaces the user's scope grants wholesale.

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `userId` | path | yes | number |

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `scopes` | `ScopeGrantDto[]` | yes | — |
| `scopes[].scopeType` | `ENTERPRISE | GROUP | CLUSTER | TERRITORY | SITE` | yes | — |
| `scopes[].scopeId` | `number` | no | — |


## Farmer & Consumer

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/farmer-consumer/users` | Bearer | List users |
| `POST` | `/api/v1/farmer-consumer/users` | Bearer | Add member |
| `GET` | `/api/v1/farmer-consumer/users/{userId}` | Bearer | Get user |
| `PATCH` | `/api/v1/farmer-consumer/users/{userId}` | Bearer | Update user |
| `DELETE` | `/api/v1/farmer-consumer/users/{userId}` | Bearer | Delete user |
| `POST` | `/api/v1/farmer-consumer/users/{userId}/activate` | Bearer | Activate user |
| `POST` | `/api/v1/farmer-consumer/users/{userId}/deactivate` | Bearer | Deactivate user |
| `POST` | `/api/v1/farmer-consumer/users/{userId}/resend-invite` | Bearer | Resend invite |


### `GET` /api/v1/farmer-consumer/users

List users

**Auth:** Bearer token required


### `POST` /api/v1/farmer-consumer/users

Add member

**Auth:** Bearer token required

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `firstName` | `string` | yes | — |
| `lastName` | `string` | yes | — |
| `email` | `string (email)` | yes | — |
| `mobile` | `string` | no | — |
| `role` | `ADMIN | TEAM_MEMBER | DRIVER` | yes | — |
| `password` | `string` | yes | min length 8 |
| `canClaimPickupsDirectly` | `boolean` | no | — |


### `GET` /api/v1/farmer-consumer/users/{userId}

Get user

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `userId` | path | yes | number |


### `PATCH` /api/v1/farmer-consumer/users/{userId}

Update user

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `userId` | path | yes | number |

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `firstName` | `string` | no | — |
| `lastName` | `string` | no | — |
| `mobile` | `string` | no | — |
| `canClaimPickupsDirectly` | `boolean` | no | — |


### `DELETE` /api/v1/farmer-consumer/users/{userId}

Delete user

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `userId` | path | yes | number |


### `POST` /api/v1/farmer-consumer/users/{userId}/activate

Activate user

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `userId` | path | yes | number |


### `POST` /api/v1/farmer-consumer/users/{userId}/deactivate

Deactivate user

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `userId` | path | yes | number |


### `POST` /api/v1/farmer-consumer/users/{userId}/resend-invite

Resend invite

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `userId` | path | yes | number |

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `newPassword` | `string` | yes | min length 8 |


## Food Listings

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/v1/food-listings` | Bearer | Create |
| `GET` | `/api/v1/food-listings/nearby` | Bearer | Available Food feed — pull-based nearby listings. |
| `GET` | `/api/v1/food-listings/notifications` | Bearer | Get notification inbox |
| `PATCH` | `/api/v1/food-listings/notifications/read-all` | Bearer | Mark all read |
| `PATCH` | `/api/v1/food-listings/notifications/{id}/read` | Bearer | Mark read |
| `GET` | `/api/v1/food-listings/org/{orgId}` | Bearer | Get by org |
| `GET` | `/api/v1/food-listings/recent` | Bearer | Get recent |
| `GET` | `/api/v1/food-listings/site` | Bearer | Get listing by site id |
| `GET` | `/api/v1/food-listings/{id}` | Bearer | Get one |
| `DELETE` | `/api/v1/food-listings/{id}` | Bearer | Cancel |


### `POST` /api/v1/food-listings

Create

**Auth:** Bearer token required

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `siteId` | `number` | yes | — |
| `listingType` | `HUMAN | ANIMAL | BOTH` | yes | — |
| `pickupAddress` | `string` | yes | — |
| `pickupPostcode` | `string` | no | — |
| `pickupLat` | `number` | yes | — |
| `pickupLng` | `number` | yes | — |
| `bestBefore` | `string` | yes | — |
| `pickupFromTime` | `string` | no | — |
| `pickupByTime` | `string` | no | — |
| `needsRefrigeration` | `boolean` | no | — |
| `needsAmbient` | `boolean` | no | — |
| `needsFreezer` | `boolean` | no | — |
| `needsHot` | `boolean` | no | — |
| `needsReheating` | `boolean` | no | — |
| `isSafeForDonation` | `boolean` | no | — |
| `allergens` | `string[]` | no | — |
| `photoUrls` | `string[]` | no | — |
| `foodItems` | `CreateFoodItemDto[]` | yes | — |
| `foodItems[].name` | `string` | yes | — |
| `foodItems[].totalQtyKg` | `number` | yes | min 1 |
| `foodItems[].unit` | `string` | no | — |
| `foodItems[].category` | `string` | no | — |


### `GET` /api/v1/food-listings/nearby

Available Food feed — pull-based nearby listings.

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `radiusKm` | query | no | number |
| `limit` | query | no | any |
| `page` | query | no | any |


### `GET` /api/v1/food-listings/notifications

Get notification inbox

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `limit` | query | no | any |
| `page` | query | no | any |


### `PATCH` /api/v1/food-listings/notifications/read-all

Mark all read

**Auth:** Bearer token required


### `PATCH` /api/v1/food-listings/notifications/{id}/read

Mark read

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |


### `GET` /api/v1/food-listings/org/{orgId}

Get by org

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `orgId` | path | yes | number |
| `status` | query | no | string |
| `limit` | query | no | any |
| `page` | query | no | any |


### `GET` /api/v1/food-listings/recent

Get recent

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `limit` | query | no | any |
| `page` | query | no | any |


### `GET` /api/v1/food-listings/site

Get listing by site id

**Auth:** Bearer token required


### `GET` /api/v1/food-listings/{id}

Get one

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |


### `DELETE` /api/v1/food-listings/{id}

Cancel

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |


## Geo Search

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/geo/nearby-charities` | Public | Get nearby charities |


### `GET` /api/v1/geo/nearby-charities

Get nearby charities

**Auth:** Public — no token

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `lat` | query | yes | number |
| `lng` | query | yes | number |
| `radiusKm` | query | yes | number |
| `region` | query | yes | string |


## Health

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1` | Public | Get hello |


### `GET` /api/v1

Get hello

**Auth:** Public — no token


## Impact

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/impact/organisations/{orgId}` | Bearer | Get org impact |
| `GET` | `/api/v1/impact/organisations/{orgId}/range` | Bearer | Get org impact by range |
| `GET` | `/api/v1/impact/organisations/{orgId}/recipients` | Bearer | Partner organisations for the period: who a business donated to, how many |
| `GET` | `/api/v1/impact/organisations/{orgId}/top-foods` | Bearer | Get top foods |
| `GET` | `/api/v1/impact/sites/{siteId}` | Bearer | Get site impact |
| `GET` | `/api/v1/impact/sites/{siteId}/range` | Bearer | Get site impact by range |
| `GET` | `/api/v1/impact/sites/{siteId}/recipients` | Bearer | Get recipients by site |
| `GET` | `/api/v1/impact/sites/{siteId}/top-foods` | Bearer | Get top foods by site |


### `GET` /api/v1/impact/organisations/{orgId}

Get org impact

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `orgId` | path | yes | number |
| `period` | query | no | week | month | year | lifetime |


### `GET` /api/v1/impact/organisations/{orgId}/range

Get org impact by range

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `orgId` | path | yes | number |
| `startDate` | query | yes | string |
| `endDate` | query | no | string |


### `GET` /api/v1/impact/organisations/{orgId}/recipients

Partner organisations for the period: who a business donated to, how many

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `orgId` | path | yes | number |
| `startDate` | query | no | string |
| `endDate` | query | no | string |


### `GET` /api/v1/impact/organisations/{orgId}/top-foods

Get top foods

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `orgId` | path | yes | number |
| `startDate` | query | no | string |
| `endDate` | query | no | string |


### `GET` /api/v1/impact/sites/{siteId}

Get site impact

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `siteId` | path | yes | number |
| `period` | query | no | week | month | year | lifetime |


### `GET` /api/v1/impact/sites/{siteId}/range

Get site impact by range

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `siteId` | path | yes | number |
| `startDate` | query | yes | string |
| `endDate` | query | no | string |


### `GET` /api/v1/impact/sites/{siteId}/recipients

Get recipients by site

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `siteId` | path | yes | number |
| `startDate` | query | no | string |
| `endDate` | query | no | string |


### `GET` /api/v1/impact/sites/{siteId}/top-foods

Get top foods by site

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `siteId` | path | yes | number |
| `startDate` | query | no | string |
| `endDate` | query | no | string |


## Notification

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/notifications` | Bearer | Get notifications |
| `POST` | `/api/v1/notifications/dispatch/{id}` | Bearer | Dispatch notification |
| `GET` | `/api/v1/notifications/ping` | Public | Ping |
| `POST` | `/api/v1/notifications/queue/drain` | Bearer | Drain queue |
| `POST` | `/api/v1/notifications/queue/retry-failed` | Bearer | Retry failed |
| `GET` | `/api/v1/notifications/queue/stats` | Bearer | Get queue stats |
| `POST` | `/api/v1/notifications/send` | Bearer | Send notification |
| `GET` | `/api/v1/notifications/stats` | Bearer | Get stats |
| `POST` | `/api/v1/notifications/token` | Bearer | Register token |
| `DELETE` | `/api/v1/notifications/token` | Bearer | Unregister token |
| `DELETE` | `/api/v1/notifications/tokens/all` | Bearer | Unregister all tokens |
| `GET` | `/api/v1/notifications/{id}` | Bearer | Get notification |


### `GET` /api/v1/notifications

Get notifications

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `page` | query | no | string |
| `limit` | query | no | string |
| `status` | query | no | string |


### `POST` /api/v1/notifications/dispatch/{id}

Dispatch notification

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |


### `GET` /api/v1/notifications/ping

Ping

**Auth:** Public — no token


### `POST` /api/v1/notifications/queue/drain

Drain queue

**Auth:** Bearer token required


### `POST` /api/v1/notifications/queue/retry-failed

Retry failed

**Auth:** Bearer token required


### `GET` /api/v1/notifications/queue/stats

Get queue stats

**Auth:** Bearer token required


### `POST` /api/v1/notifications/send

Send notification

**Auth:** Bearer token required

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `title` | `string` | yes | max length 200 |
| `body` | `string` | yes | max length 4096 |
| `data` | `object` | no | — |
| `deepLink` | `string` | no | — |
| `imageUrl` | `string` | no | — |
| `priority` | `low | normal | high` | no | — |
| `targetUserIds` | `string[]` | no | — |
| `isBroadcast` | `boolean` | no | — |
| `scheduledAt` | `string` | no | — |
| `targetPlatform` | `all | ios | android` | no | — |
| `targetApp` | `business | driver` | no | — |


### `GET` /api/v1/notifications/stats

Get stats

**Auth:** Bearer token required


### `POST` /api/v1/notifications/token

Register token

**Auth:** Bearer token required

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `token` | `string` | yes | — |
| `platform` | `ios | android` | yes | — |
| `tokenType` | `apns | fcm | expo` | yes | — |
| `tokenMode` | `prod | dev` | no | — |
| `appVersion` | `string` | no | — |
| `appBuild` | `string` | no | — |
| `appBundle` | `string` | no | — |
| `targetApp` | `business | driver` | no | — |


### `DELETE` /api/v1/notifications/token

Unregister token

**Auth:** Bearer token required

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `token` | `string` | yes | — |


### `DELETE` /api/v1/notifications/tokens/all

Unregister all tokens

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `targetApp` | query | no | string |


### `GET` /api/v1/notifications/{id}

Get notification

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |


## Organization

| Method | Path | Auth | Description |
|---|---|---|---|
| `PATCH` | `/api/v1/organization/ccordinates/{organizationId}` | Public | Update organization location |
| `PATCH` | `/api/v1/organization/{orgId}` | Bearer | Update organization |


### `PATCH` /api/v1/organization/ccordinates/{organizationId}

Update organization location

**Auth:** Public — no token

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `organizationId` | path | yes | number |

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `longitude` | `number` | yes | — |
| `latitude` | `number` | yes | — |


### `PATCH` /api/v1/organization/{orgId}

Update organization

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `orgId` | path | yes | number |

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `brandName` | `string` | no | — |
| `registrationNumber` | `string` | no | — |
| `venueType` | `CAFE_RESTAURANT | BAKERY | CATERER | GROCERY_STORE | FOOD_TRUCK | CATERING_SERVICE | HOTEL | WEDDING_VENUE | CLOUD_KITCHEN | FARM | PRODUCE_MARKET_GARDEN | LIVESTOCK_FARM | MIXED_FARM | ORCHARD | PROCESSING_FACILITY | OTHER` | no | — |


## Proximity

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/proximity/charities` | Public | Get nearby charities |
| `GET` | `/api/v1/proximity/fix-locations` | Public | Fix locations |
| `GET` | `/api/v1/proximity/listings` | Public | Get nearby listings |
| `GET` | `/api/v1/proximity/search/charities` | Public | Get near by charities |


### `GET` /api/v1/proximity/charities

Get nearby charities

**Auth:** Public — no token

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `lat` | query | yes | number |
| `lng` | query | yes | number |
| `region` | query | yes | string |


### `GET` /api/v1/proximity/fix-locations

Fix locations

**Auth:** Public — no token


### `GET` /api/v1/proximity/listings

Get nearby listings

**Auth:** Public — no token

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `lat` | query | yes | number |
| `lng` | query | yes | number |
| `region` | query | yes | string |


### `GET` /api/v1/proximity/search/charities

Get near by charities

**Auth:** Public — no token


## Sites

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/v1/sites` | Bearer | POST /sites |
| `GET` | `/api/v1/sites/organisation` | Bearer | GET /sites/organisation |
| `PATCH` | `/api/v1/sites/{siteId}` | Bearer | PATCH /sites/:siteId |
| `DELETE` | `/api/v1/sites/{siteId}` | Bearer | DELETE /sites/:siteId/access/:userId |
| `DELETE` | `/api/v1/sites/{siteId}/access/{userId}` | Bearer | Remove access |
| `POST` | `/api/v1/sites/{siteId}/assign-admin` | Bearer | POST /sites/:siteId/assign-admin |
| `POST` | `/api/v1/sites/{siteId}/assign-manager` | Bearer | POST /sites/:siteId/assign-manager |
| `GET` | `/api/v1/sites/{siteId}/details` | Bearer | GET /sites/:siteId/details |
| `GET` | `/api/v1/sites/{siteId}/staff` | Bearer | GET /sites/:siteId/staff |
| `POST` | `/api/v1/sites/{siteId}/staff` | Bearer | POST /sites/:siteId/staff |


### `POST` /api/v1/sites

POST /sites

**Auth:** Bearer token required

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `siteName` | `string` | yes | max length 160 |
| `address` | `string` | yes | — |
| `postcode` | `string` | no | max length 20 |
| `siteCode` | `string` | no | max length 40 |
| `contactName` | `string` | no | max length 120 |
| `contactEmail` | `string (email)` | no | — |
| `phoneNumber` | `string` | no | max length 30 |
| `latitude` | `number` | yes | — |
| `longitude` | `number` | yes | — |
| `collectionDays` | `mon | tue | wed | thu | fri | sat | sun[]` | no | — |
| `collectionStartTime` | `string` | no | — |
| `collectionEndTime` | `string` | no | — |
| `collectionInstructions` | `string` | no | max length 500 |
| `groupId` | `number` | no | — |
| `clusterId` | `number` | no | — |
| `territoryId` | `number` | no | — |


### `GET` /api/v1/sites/organisation

GET /sites/organisation

**Auth:** Bearer token required


### `PATCH` /api/v1/sites/{siteId}

PATCH /sites/:siteId

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `siteId` | path | yes | number |

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `siteName` | `string` | no | max length 160 |
| `address` | `string` | no | — |
| `postcode` | `string` | no | max length 20 |
| `siteCode` | `string` | no | max length 40 |
| `contactName` | `string` | no | — |
| `contactEmail` | `string (email)` | no | — |
| `phoneNumber` | `string` | no | — |
| `latitude` | `number` | no | — |
| `longitude` | `number` | no | — |
| `collectionDays` | `mon | tue | wed | thu | fri | sat | sun[]` | no | — |
| `collectionStartTime` | `string` | no | — |
| `collectionEndTime` | `string` | no | — |
| `collectionInstructions` | `string` | no | max length 500 |
| `groupId` | `number` | no | — |
| `clusterId` | `number` | no | — |
| `territoryId` | `number` | no | — |


### `DELETE` /api/v1/sites/{siteId}

DELETE /sites/:siteId/access/:userId

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `siteId` | path | yes | number |


### `DELETE` /api/v1/sites/{siteId}/access/{userId}

Remove access

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `siteId` | path | yes | number |
| `userId` | path | yes | number |


### `POST` /api/v1/sites/{siteId}/assign-admin

POST /sites/:siteId/assign-admin

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `siteId` | path | yes | number |

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `userId` | `number` | yes | — |


### `POST` /api/v1/sites/{siteId}/assign-manager

POST /sites/:siteId/assign-manager

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `siteId` | path | yes | number |

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `firstName` | `string` | yes | — |
| `lastName` | `string` | yes | — |
| `email` | `string (email)` | yes | — |
| `password` | `string` | yes | min length 8 |
| `phoneNumber` | `string` | no | — |


### `GET` /api/v1/sites/{siteId}/details

GET /sites/:siteId/details

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `siteId` | path | yes | number |


### `GET` /api/v1/sites/{siteId}/staff

GET /sites/:siteId/staff

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `siteId` | path | yes | number |


### `POST` /api/v1/sites/{siteId}/staff

POST /sites/:siteId/staff

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `siteId` | path | yes | number |

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `firstName` | `string` | yes | — |
| `lastName` | `string` | yes | — |
| `email` | `string (email)` | yes | — |
| `password` | `string` | yes | min length 8 |
| `phoneNumber` | `string` | no | — |


## Stripe Webhook

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/v1/billing/webhook/stripe` | Public | Handle stripe |


### `POST` /api/v1/billing/webhook/stripe

Handle stripe

**Auth:** Public — no token

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `stripe-signature` | header | yes | string |


## Subscriptions

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/subscriptions` | Public | Find all |
| `POST` | `/api/v1/subscriptions` | Bearer | Create |
| `GET` | `/api/v1/subscriptions/available` | Bearer | Plans offered to the caller's organisation type. |
| `GET` | `/api/v1/subscriptions/me` | Bearer | What the caller's organisation is currently allowed to do. |
| `GET` | `/api/v1/subscriptions/{id}` | Public | Find one |
| `PATCH` | `/api/v1/subscriptions/{id}` | Bearer | Update |
| `DELETE` | `/api/v1/subscriptions/{id}` | Bearer | Remove |


### `GET` /api/v1/subscriptions

Find all

**Auth:** Public — no token


### `POST` /api/v1/subscriptions

Create

**Auth:** Bearer token required

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `name` | `string` | yes | — |
| `displayName` | `string` | yes | — |
| `description` | `string` | no | — |
| `maxSites` | `number` | no | min 1 |
| `maxUserPerSite` | `number` | no | min 1 |
| `priceMonthly` | `number` | no | min 0 |
| `priceAnnual` | `number` | no | min 0 |
| `priceMonthlyInr` | `number` | no | min 0 |
| `priceAnnualInr` | `number` | no | min 0 |
| `isPerSite` | `boolean` | no | — |
| `contactSalesOnly` | `boolean` | no | — |
| `applicableOrgTypes` | `BUSINESS_SINGLE | BUSINESS_MULTI | CHARITY | CHARITY_SINGLE | CHARITY_MULTI | FARMER_PRODUCER | FARMER_CONSUMER[]` | no | — |
| `features` | `string[]` | yes | — |
| `isMostPopular` | `boolean` | no | — |
| `sortOrder` | `number` | no | — |


### `GET` /api/v1/subscriptions/available

Plans offered to the caller's organisation type.

**Auth:** Bearer token required


### `GET` /api/v1/subscriptions/me

What the caller's organisation is currently allowed to do.

**Auth:** Bearer token required


### `GET` /api/v1/subscriptions/{id}

Find one

**Auth:** Public — no token

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |


### `PATCH` /api/v1/subscriptions/{id}

Update

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |

**Request body**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `displayName` | `string` | no | — |
| `description` | `string` | no | — |
| `maxSites` | `number` | no | min 1 |
| `maxUserPerSite` | `number` | no | min 1 |
| `priceMonthly` | `number` | no | min 0 |
| `priceAnnual` | `number` | no | min 0 |
| `priceMonthlyInr` | `number` | no | min 0 |
| `priceAnnualInr` | `number` | no | min 0 |
| `isPerSite` | `boolean` | no | — |
| `contactSalesOnly` | `boolean` | no | — |
| `applicableOrgTypes` | `BUSINESS_SINGLE | BUSINESS_MULTI | CHARITY | CHARITY_SINGLE | CHARITY_MULTI | FARMER_PRODUCER | FARMER_CONSUMER[]` | no | — |
| `features` | `string[]` | no | — |
| `isMostPopular` | `boolean` | no | — |
| `sortOrder` | `number` | no | — |
| `isActive` | `boolean` | no | — |


### `DELETE` /api/v1/subscriptions/{id}

Remove

**Auth:** Bearer token required

**Parameters**

| Name | In | Required | Type |
|---|---|---|---|
| `id` | path | yes | number |
