# Roles and Permissions — Design

**Status:** Approved for planning
**Repos:** `lrr-service` (backend), `lrr-web` (admin UI)

## Problem

Admins have no way to add a staff account and assign it a role — there is
no "create user" capability in the admin portal at all. Investigating this
surfaced a deeper gap: `ADMIN` and `SUPER_ADMIN` are functionally
**identical everywhere** in the codebase today — every single `@Roles(...)`
gate across every controller treats them as the same bucket, and the
frontend's `ADMINS` nav constant bundles both into every admin-only nav
item. The two-tier naming exists but enforces nothing. Fixing "admin can
add a user" properly requires first giving the role tiers real meaning.

Also surfaced: `POST /auth/register` is a fully **unauthenticated**
endpoint, commented `(for testing/admin)`, with zero callers in either
repo. It can't currently set a role (always creates `CUSTOMER`), so it
isn't a privilege-escalation path today, but it's dead, unguarded
user-creation code with a misleading comment — removed as part of this
work rather than left as a trap for a future reader.

## Goals

- Give the role tiers real, distinct meaning, reviewed against every
  actual capability the backend exposes (not just the two items that
  originally prompted this: staff creation and Platform Settings).
- Let `SUPER_ADMIN` create staff accounts and assign them a role.
- Add a `PRODUCT` role: broad visibility, no money, no staff/operator
  management.
- Remove the dead, unauthenticated `POST /auth/register` endpoint.

## Non-goals

- Per-resource/attribute-level permissions (e.g. "can view but not edit
  operator X specifically") — this stays role-tier-based, matching the
  existing `RolesGuard` mechanism.
- Broader staff role set beyond `PRODUCT` (e.g. `SUPPORT`, `FINANCE`) —
  explicitly deferred; add roles one at a time as real need arises.
- Email-based invite flow — no email infrastructure exists in this
  codebase (WhatsApp/Twilio-only). New staff accounts get a temporary
  password set directly by `SUPER_ADMIN`, communicated out-of-band.
- Migrating existing `ADMIN`-role database rows — see Rollout below.

## Role matrix

Built from an inventory of every `@Roles(...)`-gated endpoint in the
backend. Both `GET` and `PATCH /platform-config` already had
`@Roles(ADMIN, SUPER_ADMIN)` before this change (an earlier draft of this
spec incorrectly claimed the `GET` was ungated) — this change narrows both
to `SUPER_ADMIN`, not newly guards either.

| Capability | CUSTOMER | OPERATOR | PRODUCT | ADMIN | SUPER_ADMIN |
|---|---|---|---|---|---|
| Payouts (view list, retry) | ❌ | ❌ | ❌ | ❌ | ✅ |
| Platform Config (view + edit service fee %, deposit %) | ❌ | ❌ | ❌ | ❌ | ✅ |
| Subscription cancel (admin-initiated) | ❌ | ❌ | ❌ | ❌ | ✅ |
| Dispatch board — view | ❌ | ❌ | ✅ | ✅ | ✅ |
| Dispatch board — cancel / expand-radius / manual-offer actions | ❌ | ❌ | ❌ | ✅ | ✅ |
| Rescue-request admin actions (assign-operator, status, cancel) | ❌ | ❌ | ❌ | ✅ | ✅ |
| Operators — view (listing, stats, profile) | ❌ | ❌ | ✅ | ✅ | ✅ |
| Operators — mutate (verify/suspend, bank-details admin-edit, availability) | ❌ | ❌ | ❌ | ✅ | ✅ |
| User listing — view | ❌ | ❌ | ❌ | ✅ | ✅ |
| Staff account creation (role: `ADMIN`/`PRODUCT` only — never `SUPER_ADMIN`, see below) | ❌ | ❌ | ❌ | ❌ | ✅ |
| Requests list, Payments view, Ratings — view | own only | own only | ✅ | ✅ | ✅ |

Design rules this table encodes:
- **`SUPER_ADMIN` is the only tier that touches money or can create
  staff.** This prevents `ADMIN` from creating a new `ADMIN`/`SUPER_ADMIN`
  account and escalating.
- **`SUPER_ADMIN` itself is never created or promoted through the UI.**
  `POST /auth/staff`'s `role` field only ever accepts `ADMIN` or
  `PRODUCT` — never `SUPER_ADMIN`, even though the caller creating the
  account is a `SUPER_ADMIN`. A compromised `SUPER_ADMIN` session must not
  be able to mint a second, permanent `SUPER_ADMIN` account through the
  API. For a small team, `SUPER_ADMIN` is expected to be one or two
  people; creating or promoting one is a deliberate, manual database
  operation outside this feature (a direct `UPDATE`/`INSERT`, same trust
  level as the Prisma-migration-consent pattern already used elsewhere in
  this codebase), not a self-service UI action.
- `ADMIN` keeps full day-to-day operational control (mutations on
  operators, dispatch, requests) but not money or staff creation.
- `PRODUCT` is visibility-heavy — sees dispatch state, requests, operator
  listing/stats, payments, ratings — but cannot mutate anything (no
  operator verification, no dispatch actions, no staff creation) and
  specifically cannot reach Platform Settings (the original ask that
  started this).

## Backend changes

### Schema

Add `PRODUCT` to the `UserRole` enum (Prisma migration, additive).

### Guard changes, by controller

- `src/payout/payout.controller.ts` — class-level `@Roles(ADMIN,
  SUPER_ADMIN)` → `@Roles(SUPER_ADMIN)`.
- `src/platform-config/platform-config.controller.ts` — both the `PATCH`
  (already `@Roles(ADMIN, SUPER_ADMIN)` → `@Roles(SUPER_ADMIN)`) **and**
  the `GET`, which currently has no `@Roles(...)` at all (any
  authenticated user — customer, operator, anyone — can read the
  platform's service fee and deposit percentages today). Add `@UseGuards(
  RolesGuard)` + `@Roles(SUPER_ADMIN)` to the `GET` too — this is a
  genuine tightening beyond what was asked, but leaving a
  business-sensitive config readable by every authenticated user while
  restricting who can *write* it is an inconsistent policy not worth
  preserving.
- `src/subscription/subscription.controller.ts` — the `DELETE :id` route's
  `@Roles(ADMIN, SUPER_ADMIN)` → `@Roles(SUPER_ADMIN)`.
- `src/operator/operator.controller.ts` — no changes needed. `PATCH
  :id/status` already stays `@Roles(ADMIN, SUPER_ADMIN)` (operator
  verification is a mutation, `PRODUCT` correctly excluded). The
  view-only routes (`GET /`, `GET /all-stats`, `GET /:id`, `GET
  /:id/stats`) have no `@Roles(...)` at all today — open to any
  authenticated user at the API level, with `ADMINS`-only access enforced
  purely by the frontend nav item — so `PRODUCT` already gets view access
  with zero backend change once the nav entry (below) includes it. The
  other mutation routes (`PATCH :id/bank-details`, `PATCH :id/availability`)
  aren't role-gated either; they call `assertCanManageOperator`/
  `assertIsMemberOrAdmin`, which allow `ADMIN`/`SUPER_ADMIN` unconditionally
  and otherwise require an `OperatorMember` row — a `PRODUCT` user has
  neither, so these already correctly reject `PRODUCT` by construction,
  with no design or code change required here.
- `src/rescue-request/rescue-request.controller.ts`:
  - `GET /dispatch-board` — `@Roles(ADMIN, SUPER_ADMIN)` →
    `@Roles(ADMIN, SUPER_ADMIN, PRODUCT)` (view access for PRODUCT).
  - `POST :id/expand-radius`, `POST :id/offer-to/:operatorId`,
    `PATCH :id/assign-operator`, `PATCH :id/status`, `PATCH :id/cancel` —
    stay `@Roles(ADMIN, SUPER_ADMIN)` (actions, not visibility; PRODUCT
    excluded per matrix).
- `src/auth/auth.controller.ts`:
  - `GET /users` — currently a manual `if (role !== SUPER_ADMIN && role
    !== ADMIN)` check inside the handler; leave as `ADMIN`/`SUPER_ADMIN`
    (matches the matrix's "User listing — view" row; convert to a
    `@Roles(...)` + `RolesGuard` decorator instead of the inline check
    while touching this file, for consistency with every other
    role-gated route in the codebase).
  - **Remove** `POST /register` entirely (dead, unauthenticated, zero
    callers in either repo — see Problem).
  - **Add** `POST /auth/staff` (new) — `@Roles(SUPER_ADMIN)` only. Body:
    `{ email, name, role, temporaryPassword }` where `role` is restricted
    to `ADMIN | PRODUCT` only — **`SUPER_ADMIN` is rejected even though
    the caller is a `SUPER_ADMIN`** (see the role-matrix rules above: no
    self-service path to a second `SUPER_ADMIN` account). Also rejects
    `CUSTOMER`/`OPERATOR` — those have their own dedicated self-service
    registration flows with phone-number requirements this endpoint
    doesn't replicate. Reuses
    `AuthService`'s existing password-hashing logic (the same path
    `register`/`registerCustomer`/`registerOperator` already use).
    Returns the created user's id/email/role — no auto-login token, since
    this is an admin creating an account for someone else, not a
    self-registration flow.

### New DTO for `POST /auth/staff`

New `src/auth/dto/create-staff.dto.ts`:

```typescript
import { IsEmail, IsEnum, IsNotEmpty, IsString, MinLength } from 'class-validator';
import { UserRole } from '@prisma/client';

export class CreateStaffDto {
  @IsEmail()
  email: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsEnum(UserRole)
  role: UserRole;

  @IsString()
  @MinLength(8)
  temporaryPassword: string;
}
```

Per this codebase's established gap (no global `ValidationPipe` — confirmed
during the rating-service and payout-automation work this session), the
controller must also manually validate `role` is one of `ADMIN`/`PRODUCT`
— explicitly rejecting **both** `CUSTOMER`/`OPERATOR` and `SUPER_ADMIN`
with a `400` — matching the manual-validation pattern already used
elsewhere (e.g. `RatingController`, `OperatorController.saveBankDetails`).

## Frontend changes (`lrr-web`)

### `app/components/portal/nav.ts`

Introduce two new role-group constants alongside the existing `ADMINS`:

```typescript
const SUPER_ADMIN_ONLY: UserRole[] = ["SUPER_ADMIN"];
const STAFF_VISIBILITY: UserRole[] = ["ADMIN", "SUPER_ADMIN", "PRODUCT"];
```

Re-tier `PORTAL_NAV`:
- `Dispatch Board` — `roles: ADMINS` → `roles: STAFF_VISIBILITY`.
- `Payouts` — `roles: ADMINS` → `roles: SUPER_ADMIN_ONLY`.
- `Platform Settings` — `roles: ADMINS` → `roles: SUPER_ADMIN_ONLY`.
- `Requests`, `Payments` (currently `roles: ALL` / `[...ADMINS,
  ...OPERATOR]`) — extend to include `PRODUCT` (visibility rows in the
  matrix).
- `Operators` — `roles: ADMINS` → `roles: STAFF_VISIBILITY` (view access
  for `PRODUCT` too — see `OperatorsTab.tsx` below for how mutation
  actions stay hidden from `PRODUCT` within the page).
- `Manage Users` — stays `roles: ADMINS` (per the matrix, `PRODUCT` has no
  access to user listing at all, unlike `Operators`).

### `DispatchBoardTab.tsx`

The page itself becomes reachable by `PRODUCT` (nav-level), but its three
action buttons (Cancel, Expand radius, Offer to operator) must not render
for `PRODUCT` — read `role` from `useAuthState()` and conditionally render
the `{isLive && (...)}` action-button block only when `role !== "PRODUCT"`.
This is UI-level hiding; the backend's unchanged `@Roles(ADMIN,
SUPER_ADMIN)` on the three action endpoints is the actual enforcement
(defense in depth — a `PRODUCT` user hitting the endpoint directly still
gets `403`).

### `OperatorsTab.tsx`

Same defense-in-depth pattern as `DispatchBoardTab.tsx`: the page becomes
reachable by `PRODUCT` (nav-level), but its mutation controls — status
change (verify/suspend), availability toggle, and the bank-details edit
block inside `StatsModal` — must not render for `PRODUCT`. Read `role`
from `useAuthState()` and conditionally hide those controls when `role
=== "PRODUCT"`. Since the underlying mutation endpoints already reject
`PRODUCT` server-side (see Backend changes above — either by explicit
`@Roles(ADMIN, SUPER_ADMIN)` or by falling through to the
membership-only check), this is UI polish for a coherent read-only
experience, not the actual security boundary.

### `ManageUsersTab.tsx`

- Currently read-only (list + role filter). Add an "Add staff" button,
  visible only to `SUPER_ADMIN` (check `useAuthState().role`), opening a
  small form (email, name, role dropdown offering only `ADMIN`/`PRODUCT`
  — `SUPER_ADMIN` is never a selectable option, matching the backend's
  rejection of it, so the form can't even attempt what the API will
  reject — and temporary password field) that calls the new `POST
  /auth/staff`.
- Per the matrix, `PRODUCT` has no access to User listing at all, so this
  tab's nav entry (`roles: ADMINS`) is unchanged — only `SUPER_ADMIN`
  additionally sees the "Add staff" button within it; plain `ADMIN` keeps
  its existing read-only view.

### New hook method

`app/hooks/useAuthApi.ts` gains `createStaff(data: { email: string; name:
string; role: string; temporaryPassword: string }): Promise<...>` calling
`POST /auth/staff`, following the existing hook file's established
try/catch/finally pattern (see any of this session's other new hook
methods, e.g. `usePayoutApi.ts`, for the exact shape to match).

## Rollout

This change makes `ADMIN` lose money/staff-creation access it currently
(functionally, if not intentionally) has. **Before this ships, review
every existing `ADMIN`-role user in the database and promote whoever
should retain payout/platform-config/staff-creation access to
`SUPER_ADMIN`.** This is a manual data step, not something this change
automates — the design doesn't know which current `ADMIN` accounts are
meant to be "real" super admins versus operational admins, and guessing
wrong would either lock out someone who needs Payouts access or leave
money-tier access broader than intended. Flagging this prominently rather
than silently deciding it.

## Testing

Unit tests for the new `POST /auth/staff` endpoint (happy path; rejects
non-`SUPER_ADMIN` callers via `RolesGuard` — covered structurally by the
same guard test pattern already used elsewhere, no need to re-test
`RolesGuard` itself; rejects `role: CUSTOMER`/`OPERATOR` with `400`).
Tests for each re-tiered `@Roles(...)` decorator are declarative (the
decorator itself is the enforcement) — no new runtime logic to unit test
beyond the values changing, but each changed controller's existing test
suite (if any) must still pass, confirming no regression in the
already-tested `ADMIN`/`SUPER_ADMIN` overlap cases that remain identical
(e.g. dispatch actions, operator status).
