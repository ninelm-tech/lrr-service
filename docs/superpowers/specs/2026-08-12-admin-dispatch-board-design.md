# Admin Dispatch Board — Design

**Status:** Approved for planning
**Repos:** `lrr-service` (backend), `lrr-web` (admin UI)

## Problem

Admins currently have no purpose-built view of the live dispatch process —
which operators were offered a given rescue request, in what round, who
accepted/declined/timed out, and why a request might be stuck. The existing
admin Requests tab shows all requests in a flat table with a per-request
detail modal (built for the quote-compliance feature), but nothing surfaces
the *in-flight* dispatch state across requests at a glance, and there's no
way for an admin to intervene when the automatic dispatch cycle is stuck or
slow.

## Goals

- Give admins a live (polling) view of every rescue request currently being
  dispatched, plus a recent-history window so a just-resolved dispatch
  doesn't disappear from view immediately.
- Per request, show which operators were offered, their response status,
  quoted price, and timing — the same shape of data the per-request detail
  modal already surfaces, but across all active dispatches at once.
- Let admins intervene: cancel a stuck dispatch, force an early radius
  expansion instead of waiting for the automatic retry timer, or manually
  offer the job to a specific operator (bypassing the ranking algorithm).

## Non-goals

- Websocket/push-based real-time — this codebase polls everywhere
  (`PendingOffers.tsx`'s established pattern); the board follows suit.
- Changing the automatic dispatch/ranking algorithm itself — this is a
  visibility and manual-override layer on top of it, not a redesign.
- A generic "reassign after acceptance" flow — intervention here is scoped
  to the *dispatching* phase, before an operator has been assigned.

## Data model

No schema changes. Everything needed already exists:
- `RescueRequest.status` (`DISPATCHING` = live; `OPERATOR_ASSIGNED` /
  `CANCELLED` within the last 60 minutes = recent history).
- `DispatchOffer` rows per request (operator, status, quotedPrice,
  offeredAt, respondedAt) — already the exact shape the per-request admin
  detail modal (`detailForUser`) surfaces.
- `WhatsAppSession.dispatchRound` (DB-backed, keyed by customer `userId`) —
  gives the current round number for display and for computing the radius
  to use in the force-expand action (see below).

## Backend

### `GET /rescue-requests/dispatch-board` (new, admin-only)

Returns an array of board rows:

```typescript
interface DispatchBoardRow {
  id: string;                    // rescueRequestId
  status: string;                // DISPATCHING | OPERATOR_ASSIGNED | CANCELLED
  vehicleType: string | null;
  destination: string | null;
  round: number;                 // from WhatsAppSession.dispatchRound
  createdAt: string;
  offers: Array<{
    operatorId: string;
    businessName: string;
    status: string;              // DispatchOfferStatus
    quotedPrice: number | null;
    offeredAt: string;
    respondedAt: string | null;
  }>;
}
```

Query: `RescueRequest.findMany` where `status = DISPATCHING` OR
(`status IN (OPERATOR_ASSIGNED, CANCELLED)` AND `updatedAt >= now - 60min`),
`include: { dispatchOffers: { include: { operator: true } } }`. The round
number comes from a second query against `WhatsAppSession` keyed by each
row's `customerId`, batched (`findMany` with `userId: { in: [...] }`) rather
than one query per row.

Must be declared before the existing `@Get(':id')` route in
`RescueRequestController` (same param-shadowing rule the file's `offers/mine`
route already documents) — as a literal path segment, `dispatch-board` would
otherwise be swallowed as an `:id` value.

### `PATCH /:id/cancel` (existing, unchanged)

Already admin-only, already does exactly what "cancel a stuck dispatch"
needs. The board's Cancel button calls this directly — no backend change.

### Concurrency: only one active dispatch round per request

Both new actions below start a fresh "round" for a request that may already
have one in flight. `resolveBatch` already implements a single mutex for
this — `batchTimers: Map<rescueRequestId, NodeJS.Timeout>` — where the
timer holder is the only one allowed to resolve that round (`get` the
timer, `clearTimeout`, `delete` the map entry; anything that later finds no
timer under that key silently no-ops as "already resolved by the other
path"). Tracing through this mutex surfaces a real bug either new action
would introduce if it started a new round without also clearing the old
one's timer: a still-pending `setTimeout` from the *old* round (either its
main batch timer or its `graceTimers` entry) would eventually fire,
`get` the map entry — which by then holds the *new* round's timer — and
incorrectly `clearTimeout` it while resolving with the *old* round's
`batchOperatorIds`. The new round's own timer would silently never fire.

So both `expand-radius` and `offer-to/:operatorId` must, before starting
their replacement round:
1. If `batchTimers.has(rescueRequestId)`, `clearTimeout` and delete it.
2. If `graceTimers.has(rescueRequestId)`, `clearTimeout` and delete it
   (same cleanup `resolveBatch` already does for itself).
3. Mark every currently-`PENDING` `DispatchOffer` for this
   `rescueRequestId` as `TIMED_OUT`. This makes a late response to the
   superseded round inert: `handleOperatorQuoteOrDecline` looks up the
   operator's most recent `PENDING` offer and silently no-ops
   (`if (!offer) return this.xmlOk()`) if it finds none — the same path
   already used for genuinely expired offers, so this isn't new behavior,
   just applying it a round early.

This is implemented once as a private `supersedeActiveRound(rescueRequestId)`
helper, called by both actions before they proceed.

### `POST /:id/expand-radius` (new, admin-only)

Calls `supersedeActiveRound`, then triggers `startDispatch` immediately
with an expanded radius, instead of waiting for the automatic
`DISPATCH_RETRY_MINUTES` timer. Since `extraRadiusKm` isn't persisted
anywhere between rounds today (only held in a `setTimeout` closure —
confirmed via an existing code comment), this endpoint approximates the
current radius as `session.dispatchRound * RADIUS_EXPANSION_KM` and calls
`startDispatch` with that value plus one more `RADIUS_EXPANSION_KM`
increment. This is the same approximation the automatic path already
effectively produces each round, so it's consistent, not a new source of
drift. Returns `400` if the request is not currently `DISPATCHING`.

### `POST /:id/offer-to/:operatorId` (new, admin-only)

New `RescueRequestService.manualOfferToOperator(rescueRequestId, operatorId)`
treats the manual offer as a single-operator dispatch round — not a
special-cased side-channel — so it participates in the exact same
quote/decline/resolution logic every other round uses:

1. Validates the request is `DISPATCHING` and the operator exists and is
   `ACTIVE` — `400`/`404` otherwise.
2. Calls `supersedeActiveRound(rescueRequestId)` (see above) — a manual
   offer takes over the round slot from whatever automatic round was
   active, rather than running alongside it.
3. Creates a single `DispatchOffer` row for that operator with a fresh
   `expiresAt = now + 5 minutes` (bypassing `findAndRankCandidates`
   entirely — this is an explicit admin override).
4. Sends the same WhatsApp offer message template `startDispatch`'s batch
   path uses, to just this one operator.
5. Appends the operator's ID to `WhatsAppSession.offeredOperatorIds` so the
   automatic batch cycle doesn't independently re-offer them later.
6. Schedules a timer identical in shape to the normal batch timer —
   `setTimeout(() => void this.resolveBatch(rescueRequestId, [operatorId], customerId, 0), 5 * 60 * 1000)`
   — stored in the same `batchTimers` map under `rescueRequestId`.

No bespoke quote-handling code is needed beyond this: `processQuoteOrDecline`
already resolves "the batch" as whichever `DispatchOffer` rows share the
same `rescueRequestId` + `expiresAt` (see `maybeResolveBatchEarly`'s query),
which for a manual offer is just the one row. When the operator quotes,
`maybeResolveBatchEarly` sees zero still-`PENDING` offers in that "batch"
and resolves immediately — the standard path from there (`resolveBatch` →
`sendQuoteShortlist`) requires no changes. A decline or timeout falls
through to `resolveBatch`'s existing "no quotes this round" branch, which
calls `startDispatch` again — automatic dispatch resumes normally after a
manual offer that didn't pan out.

## Frontend — `DispatchBoardTab.tsx`

New admin nav item (`/dispatch-board`, same `RequireRole`/`PORTAL_NAV`
pattern as `/payouts`). Polls `GET /rescue-requests/dispatch-board` every 5
seconds, matching `PendingOffers.tsx`'s existing interval.

One card per row: customer/vehicle summary, round number, a small table of
offered operators (business name, status badge, quoted price, response
time), and three actions:
- **Cancel** — confirms, then calls `PATCH /:id/cancel`.
- **Expand radius** — calls `POST /:id/expand-radius`, disabled once the
  request leaves `DISPATCHING`.
- **Offer to operator** — opens a small picker backed by
  `useOperatorApi().fetchAll()` (already used by `OperatorsTab.tsx`, no new
  endpoint needed), filtered client-side to `status: ACTIVE`. Since this
  bypasses the ranking algorithm entirely, the picker lists each operator's
  `truckClasses` and `address`/distance-from-request alongside their name —
  an admin should be able to see at a glance that they're not about to send
  a heavy-trailer job to a light-duty operator. Calls
  `POST /:id/offer-to/:operatorId` with the chosen one.

Resolved rows (`OPERATOR_ASSIGNED`/`CANCELLED`, within the 60-minute
window) render the same card without action buttons — visibility only,
since intervention doesn't apply to a resolved dispatch.

## Error handling

| Situation | Response |
|---|---|
| `expand-radius` / `offer-to` called on a non-`DISPATCHING` request | `400 BadRequestException` |
| `offer-to` targets a non-existent or non-`ACTIVE` operator | `404`/`400` |
| Board poll fails (network blip) | Frontend keeps showing the last successful fetch, retries next interval — same resilience pattern as `PendingOffers.tsx` |

## Testing

Unit tests for `manualOfferToOperator` (happy path — offer created, WhatsApp
sent, timer scheduled under `batchTimers`; non-`DISPATCHING` rejection;
missing/inactive operator rejection; a quote against the manual offer
resolves immediately via the existing shared path) and for
`supersedeActiveRound` specifically (an active `batchTimers`/`graceTimers`
entry is cleared; pending offers from the old round flip to `TIMED_OUT`; a
late response to one of those old-round offers is a no-op, not a crash or
a resolution using stale data). Plus the radius-expansion endpoint's
round-based radius computation. The dispatch-board query itself is tested
at the service level (correct status/time filtering, round lookup joined
correctly) rather than needing a dedicated e2e test, matching this
codebase's existing test-depth pattern for list endpoints.
