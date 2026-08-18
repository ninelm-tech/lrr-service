# Dispute Handling — Design

**Date:** 2026-08-18
**Repos:** lrr-service, lrr-web

## Problem

Product feedback: when a customer disputes a job (replies `DISPUTE` on WhatsApp during
completion confirmation), nothing meaningful happens today. The customer gets a WhatsApp
acknowledgement, but the event is otherwise invisible — no DB record, no admin alert, no
dashboard indicator. Product wants:

- A dispute to be immediately visible in the admin dashboard (red).
- A notification that "pops" so staff notice it without having to go looking.
- Quick-attention alerting outside the dashboard too, since staff won't always have it open.
- A way to mark a dispute resolved, which then shows green (not just reverts to normal).

## Current state (confirmed via code read)

- No `DISPUTED` status and no `Dispute` model. `RescueRequestStatus` has 11 values, none
  dispute-related.
- The `DISPUTE` WhatsApp handler (`rescue-request.service.ts:149-157`) writes nothing to the
  DB. It calls `alertAdminNoOperator(...)`, which is a dead stub — `console.warn` only, with a
  comment admitting it's unwired ("Hook to admin notification service when available").
- No operator notification, no Sentry alert, on this path.
- lrr-web's admin Requests tab (`RescueRequestsTabAdmin.tsx`) has zero dispute awareness —
  confirmed via grep, no matches anywhere in lrr-web.
- No global toast/notification system exists. Existing dashboard tabs poll every 15s
  (`DispatchBoardTab.tsx`, `PendingOffers.tsx`) and re-render; toasts that do exist
  (`OperatorsTab.tsx`, `OperatorMembersTab.tsx`) are local, component-scoped `useState` +
  `setTimeout`, not a shared provider.

## Scope for this pass

In scope:
- Persisting dispute state on `RescueRequest`.
- WhatsApp alert to a configurable staff number the moment a dispute is raised.
- Dashboard: red badge + "Resolve Dispute" button on disputed rows; green "Dispute Resolved"
  badge once resolved; an in-page toast when the Requests tab's poll detects a newly-disputed
  row.

Explicitly out of scope for this pass (parked, not decided against):
- Email alerting to a dedicated address.
- SMS alerting (would require a new integration — no general SMS-sending capability exists
  today; Termii is NG-OTP-only, Twilio here is WhatsApp-only).
- A global, app-wide notification system that pops regardless of which tab is open. This
  pass's notification only fires while the Requests tab itself is open and polling — the
  WhatsApp alert is the channel that reaches staff regardless of whether the dashboard is open.
- Capturing a dispute *reason* from the customer. Today `DISPUTE` is a bare keyword with no
  free-text reason collected; the WhatsApp alert and dashboard will show the job ref and a
  dashboard link, not a "why" (there is no "why" captured yet).

## Data model

Dispute state lives directly on `RescueRequest` — it's orthogonal to the job's normal status
progression (a dispute can be raised while a request is, e.g., `ARRIVED`), so it's tracked as
flags rather than folded into `RescueRequestStatus` or a separate table:

```prisma
model RescueRequest {
  // ...existing fields...
  disputed         Boolean   @default(false)
  disputeRaisedAt  DateTime?
  disputeResolvedAt DateTime?
}
```

Three UI states fall out of two fields:
- `disputed = false` → normal row, no badge.
- `disputed = true, disputeResolvedAt = null` → **red** "Disputed" badge + Resolve button.
- `disputed = true, disputeResolvedAt != null` → **green** "Dispute Resolved" badge, no button.

Resolving never clears `disputed` — it's a permanent record that the job had one. This is what
lets the green state persist rather than the row silently reverting to looking untouched.

`PlatformConfig` gets one new optional field, following the existing pattern
(`dispatchWindowMinutes`, `serviceFeePercent`):

```prisma
model PlatformConfig {
  // ...existing fields...
  disputeAlertPhoneNumber String?
}
```

Optional and nullable: if unset, the WhatsApp alert step is simply skipped (no error) — matches
how the rest of dispatch already treats missing optional config.

## Backend flow

**Raising a dispute** (`rescue-request.service.ts`, replacing the current `DISPUTE` branch) —
three cases, made explicit so repeat `DISPUTE` messages can't corrupt the state:

1. **Not currently disputed** (`disputed = false`, the normal case): set `disputed: true,
   disputeRaisedAt: new Date()`. Send the customer acknowledgement. If
   `platformConfig.disputeAlertPhoneNumber` is set, send the staff WhatsApp alert (see content
   below) — best-effort, log-and-continue on failure, matching the `GeocodingService` pattern
   used elsewhere this session.
2. **Already disputed, unresolved** (`disputed = true, disputeResolvedAt = null`): a repeat
   `DISPUTE` from the same customer while it's still open. No DB write, no re-alert — just
   reply "This request is already flagged as disputed — our team is on it." Prevents duplicate
   staff pings and prevents `disputeRaisedAt` drifting forward on every repeat message.
3. **Already disputed, resolved** (`disputed = true, disputeResolvedAt != null`) — a **reopen**:
   a customer disputing again after resolution is new information, not noise. Set
   `disputeResolvedAt: null` (back to red) and `disputeRaisedAt: new Date()` (new raise time —
   the original resolution is overwritten, not kept as history; no audit trail beyond "current
   dispute state" in this pass). Send the staff alert again, same as case 1. Send the customer
   an acknowledgement that distinguishes this from a first-time raise (e.g. "Your dispute has
   been reopened — our team is on it.").

Remove the dead `alertAdminNoOperator` call from this path (it stays as-is for its original
zero-candidates use case elsewhere — only the dispute branch stops calling it).

**Staff WhatsApp alert content:** job ref, current `RescueRequestStatus`, assigned operator's
business name (if any), and the relevant amount (`balanceAmount` if balance is outstanding,
else `depositAmount`) — enough for staff to gauge severity without opening the dashboard.
Includes a dashboard link built from the existing `FRONTEND_URL` config value (already the
configured base URL for the customer/admin web app — no new env var needed; e.g.
`${FRONTEND_URL}/requests?highlight={id}`), not hardcoded.

Note: `disputeAlertPhoneNumber` is intentionally single-recipient for this pass. If multiple
staff need to be alerted, that's a follow-up (e.g. a comma-separated list or a proper
recipients table) — flagging so it's a known, deliberate limitation, not an oversight.

**Resolving a dispute:** new endpoint, admin-only (role check consistent with other
admin-mutating endpoints in `rescue-request.controller.ts`), e.g.
`PATCH /rescue-requests/:id/resolve-dispute`. Idempotent — safe to retry (double-click,
frontend retry after a dropped response, etc.) — three cases:
- **Never disputed** (`disputed = false`): reject with a clear error. Resolving something never
  disputed would produce `disputeResolvedAt` set while `disputed` is false, which breaks the
  three-state model the whole feature is built on.
- **Already resolved** (`disputed = true, disputeResolvedAt != null`): return the current
  request successfully, no DB write, no notifications re-sent. Makes the endpoint safe to call
  more than once for the same resolution.
- **Disputed, unresolved** (`disputed = true, disputeResolvedAt = null`) — the real case: sets
  `disputeResolvedAt: new Date()`, then attempts a WhatsApp message to **both** the customer and
  the assigned operator (if one exists) confirming the dispute is resolved. This matters
  operationally: the original dispute message told the customer "Do NOT release the vehicle
  until you hear from us" — silence on resolution would leave them stuck indefinitely.
  Notifications are best-effort, same as the staff alert on raise: persist the resolution first,
  then attempt to notify, log-and-continue on failure — an admin successfully resolving a
  dispute should never get a 500 because Twilio hiccuped after the DB write already succeeded.

**Resolution message wording:** kept deliberately non-instructive — "The dispute on request
{jobRef} has been marked as resolved. Our team has completed the dispute review." NOT
"you may proceed," since what "proceed" means differs by party (release vehicle vs. make
payment vs. complete the job) and this pass doesn't capture a resolution outcome. If a specific
next action is needed, staff communicate it directly — this message is just the formal
close-out, not first notice of an outcome.

No note/reason field on the resolve action itself — one-click resolve per your call.

## Dashboard (lrr-web)

- `RescueRequestsTabAdmin.tsx`: add a badge next to the status pill — red "Disputed" (with a
  "Resolve Dispute" button) when unresolved, green "Dispute Resolved" when resolved — using the
  same inline-style color-map pattern already used for status (`STALLED: {bg:"#fff3cd", ...}`).
- The tab's existing polling loop (extending the 15s pattern from `DispatchBoardTab.tsx`) diffs
  the incoming list against the previous poll. The condition is **transition into unresolved
  dispute** — `disputed && !disputeResolvedAt` now, where that wasn't true on the last poll —
  not "is disputed now vs. wasn't before." `disputed` stays `true` forever once set, so a plain
  "wasn't disputed → now is" check would miss a reopen (which goes `disputed=true,
  disputeResolvedAt=<timestamp>` → `disputed=true, disputeResolvedAt=null`); the
  unresolved-transition framing catches both a first-time raise and a reopen with one rule.
  Reuses the existing local toast pattern from `OperatorsTab.tsx` rather than building a new
  shared provider — out of scope per above.
- **The initial fetch establishes the known dispute state and generates no toasts.** Only
  transitions detected on subsequent polls fire one — otherwise opening the Requests tab would
  immediately fire a toast for every pre-existing unresolved dispute, however old.
- "Resolve Dispute" button visible only to admin-role dashboard users, per your call that this
  isn't something any logged-in role should be able to do.

## Testing

- Backend: unit tests for all three DISPUTE branches — first raise (DB update + staff alert +
  customer ack), repeat while unresolved (no DB write, no re-alert, distinct customer reply),
  and reopen after resolution (`disputeResolvedAt` cleared, `disputeRaisedAt` refreshed,
  re-alerts staff, distinct "reopened" customer reply). Also: staff alert is skipped cleanly
  when `disputeAlertPhoneNumber` is unset, and its message content includes status/operator/
  amount. For resolve: asserts `disputeResolvedAt` is set on first resolution and both parties
  are notified; rejects when `disputed = false`; is a no-op (no DB write, no re-notification)
  when called again on an already-resolved request; admin-role guard; and that a Twilio failure
  during notification doesn't surface as an error once the DB write has already succeeded.
- Frontend: no existing test suite for lrr-web (confirmed earlier this session — no `test`
  script in `package.json`); verification is `tsc`/`next build` plus a manual click-through, as
  with the rest of this session's lrr-web changes.
