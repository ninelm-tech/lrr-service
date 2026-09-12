# Operator-Submitted Quotes & Shortlist — Design

Status: Approved
Date: 2026-08-08

## Background

The current build dispatches jobs at a **fixed, hardcoded price** (₦5,000
deposit + ₦45,000 balance = ₦50,000 total, or ₦50,000 in full for
exhausted-subscriber cases) — the first matched operator to reply `YES`
gets the job. This contradicts the operator-owned-pricing decision made
early in this project ("Operators sets price now... does not own pricing
anymore" — meaning admin does *not* set price, operators do) and the
updated PRD, which describes operators submitting their own lump-sum
quotes and motorists choosing from a shortlist.

Two PRD versions exist with conflicting pricing models. This spec follows
the **updated PRD** (`PRODUCT REQUIREMENT DOCUMENT - LAGOS ROADSIDE
RESCUE.pdf`, referencing an "Updated PRD" Google Doc), which is consistent
with the operator-owned-pricing decision: operators submit quotes,
motorists pick from a shortlist, LRR monitors quotes for compliance
without setting fares itself. The earlier, superseded PRD's "LRR Admin sets
a lump-sum price" model is not used.

The updated PRD describes operators submitting quotes through a **web
portal** link. This spec deliberately deviates from that one detail: all
decision-relevant information (vehicle type, destination, distance,
location, and — since the media-capture-forwarding spec shipped —
photo/video/audio links) is already included directly in the WhatsApp
dispatch offer message. Operators quote by replying to that message; the
portal remains available but optional, not a required step to bid.

## Goal

Operators reply to the WhatsApp dispatch offer with a price instead of
`YES`/`NO`; ETA is always the system's location-based estimate, never typed
by the operator. Once the batch of offered
operators has responded, the motorist receives a shortlist of quotes and
picks one via WhatsApp. LRR adds a configurable service fee on top of each
quote; the deposit is a configurable percentage of the resulting total.

## Non-goals

- Any change to truck-class/vehicle-type matching, media capture, or
  anything else already shipped — unchanged.
- A minimum-quote-count requirement before showing a shortlist — one quote
  is enough to proceed.
- Automatic cheapest-quote selection on motorist timeout — timeout cancels
  the shortlist instead (see Motorist shortlist section).
- Building a ratings/reviews system — none exists today. Shortlist ranking
  uses price and ETA only (see Motorist shortlist section).

## Data model changes (`prisma/schema.prisma`)

- `DispatchOffer` gains one nullable field: `quotedPrice Int?` (kobo). ETA
  is never operator-supplied (see WhatsApp flow section below), so it is
  computed at shortlist-build time from `Operator`/`RescueRequest`
  location, not stored on the offer.
- `RescueRequest` gains one nullable field: `serviceFeeAmount Int?` (kobo).
  The existing `depositAmount`/`balanceAmount` fields are reused to store
  the *computed* split (see Payment section) rather than the old fixed
  constants. Together, `depositAmount + balanceAmount` is the frozen total
  the motorist agreed to (quote + service fee) — always derivable, never
  recomputed from `PlatformConfig` after selection.
- `DispatchOfferStatus` gains three values, alongside the existing
  `PENDING`/`DECLINED`/`TIMED_OUT`:
  - `QUOTED` — operator submitted a price within the response window.
  - `SELECTED_PENDING_PAYMENT` — motorist picked this quote, but the
    deposit hasn't been confirmed yet (see Payment section — this is not
    the same as being awarded the job).
  - `NOT_SELECTED` — quoted, but the motorist picked a different operator.
  `ACCEPTED` (existing value) is now reached only after deposit payment
  confirms, not at the moment of motorist selection.
- New singleton-row model `PlatformConfig`:
  ```prisma
  model PlatformConfig {
    id                String  @id @default(cuid())
    serviceFeePercent Decimal @default(10.0)
    depositPercent    Decimal @default(10.0)
    updatedAt         DateTime @updatedAt
  }
  ```
  Exactly one row exists, seeded by the migration. Read fresh (not cached)
  at quote-finalization time — a config change via the admin endpoint takes
  effect on the next motorist selection, no redeploy or cache invalidation
  needed.
- Additive migration; no backfill needed (pilot has no production traffic
  depending on old accept/decline-only semantics surviving).

## WhatsApp flow — operator quote submission

Field research is the reason this flow is being simplified in the first
place — operators are not necessarily technical, so the reply stays a
single number. ETA is never typed by the operator; it's always the
system's location-based estimate. This can be improved later using real
arrival-time data once the platform has history to learn from — not an MVP
concern.

- The dispatch offer message's closing line changes from `Reply YES to
  accept or NO to decline` to:
  ```
  💰 Reply with your price to bid, e.g. "25000".
  Est. ETA: ~{estimatedMinutes} min based on your registered location.
  Reply NO to decline.
  You have {windowSeconds} seconds.
  ```
- `handleOperatorMessage` gains a new branch: if the message parses as a
  single number, treat it as a quote. Look up the operator's `PENDING`
  `DispatchOffer`, set `quotedPrice` (the number × 100, kobo), status →
  `QUOTED`.
- `NO`/`decline` still works exactly as today (status → `DECLINED`).
- The estimated ETA reuses the distance already computed for operator
  ranking (`ScoredOperator.distance`): `estimatedMinutes = round(distance /
  ASSUMED_AVG_SPEED_KMH * 60)`, where `ASSUMED_AVG_SPEED_KMH = 20` — a
  conservative urban-Lagos-traffic assumption (new small constant, no new
  infrastructure). Computed fresh at shortlist-build time (not stored) so
  it reflects the operator's location as of dispatch, not as of quoting.

## Dashboard quote submission (second quoting channel)

The existing operator dashboard's "pending offers" view (`listMyPendingOffers`/`respondToOffer`) currently exposes an Accept/Decline action wired to the *old* immediate-accept-at-fixed-price flow (`processOfferResponse`). Left untouched, this becomes a bypass around the entire quote system — an operator could accept a job at the old hardcoded price via the dashboard while WhatsApp quoting is in progress for the same offer. Rather than just blocking the old action, the dashboard becomes a second quoting channel with the same underlying logic as the WhatsApp path:

- The core "operator submitted a price / declined" logic (currently inline in the WhatsApp-only handler) is a single channel-agnostic method, mirroring how `processOfferResponse` was already shared between WhatsApp and the dashboard in the old flow. Both channels call the same core; only the input plumbing (WhatsApp text parsing vs. a dashboard form submission) differs.
- The dashboard's Accept/Decline buttons are replaced with a quote form: a price input + submit ("Quote"), and a separate "Decline" button — same two actions as WhatsApp (quote or decline), no third "instant accept" option.
- `listMyPendingOffers` (the endpoint the dashboard already uses to show pending jobs) is extended to include the information an operator needs to price a job: vehicle type, destination, and media links — today it only returns `issueType`/lat/long/`createdAt`. This closes the "required information" gap, matching what WhatsApp operators already see in the offer message.
- A new endpoint accepts a dashboard quote submission for a specific offer, calling into the same core logic the WhatsApp path uses (same `QUOTED`/`DECLINED` status transitions, same batch-early-resolution trigger).
- The old immediate-accept `processOfferResponse` path is retired for the dispatch-offer flow entirely — there is no longer an "instant accept" action anywhere, WhatsApp or dashboard. (`processOfferResponse` itself may still be referenced by unrelated code — the implementation plan verifies this before removing anything.)

## Batch/window changes — quote collection instead of first-accept

- `startDispatch`'s batch-offer creation is unchanged (still `BATCH_SIZE =
  3` operators per round). What changes is behavior *during* the window:
  operators can independently quote or decline any time before the window
  closes — no race to be first.
- **Whichever is sooner:** once every operator in the current batch has
  either quoted or declined, the batch resolves immediately rather than
  waiting out the remainder of the timer. The existing `setTimeout`-based
  window still fires as a fallback for stragglers (unresponsive operators'
  offers become `TIMED_OUT` as today).
- When the batch resolves (all responded, or window expired): gather all
  `QUOTED` offers for this `rescueRequestId`.
  - **Zero quotes** (nobody responded, or everyone declined): this reuses
    the *existing* no-quote path — radius expansion, retry, eventual admin
    alert / auto-cancel after `MAX_ROUNDS_BEFORE_AUTO_CANCEL` — unchanged.
  - **One or more quotes:** proceed to the shortlist step below, even if
    fewer than the full batch responded. No minimum quote count required.

## Motorist shortlist + selection

- Shortlist message lists each `QUOTED` offer, ranked by a **composite
  score** — not price alone. This preserves the spirit of the original
  design decision ("Quotes are ranked using a combination of price, ETA,
  and operator rating rather than a single factor"), adapted to what data
  actually exists: there is no ratings system anywhere in this codebase
  (no `Rating` model, no `averageRating` field) — building one is a
  separate feature, out of scope here. The composite score for this spec
  uses price and ETA only. Reusing the same normalize-and-weight pattern
  already used for operator broadcast ranking (`OperatorService`'s
  `WEIGHT_DISTANCE`/`WEIGHT_ACCEPTANCE_RATE`/`WEIGHT_RESPONSE_SPEED`), a new
  `rankQuotes` helper normalizes price (lower is better) and ETA (lower is
  better) into 0–1 scores each, then combines them:
  ```
  WEIGHT_PRICE = 0.60
  WEIGHT_ETA   = 0.40
  ```
  **Ranking uses the operator's raw `quotedPrice`, while the amount
  displayed to the motorist is `quotedPrice + applicable service fee`.**
  The service-fee percentage is a uniform markup, so it never changes the
  relative ordering between quotes — but the displayed figures must always
  be the real, motorist-facing amounts. A motorist must never see one
  number in the shortlist and a different, higher number at payment. Each
  line shows the marked-up total, ETA, and business name, in ranked order
  (not necessarily cheapest-first) — example at the default 10% service
  fee, operator quotes of ₦25,000/₦27,500/₦31,000 display as:
  ```
  🚗 Operator quotes received!

  1️⃣ ₦27,500 · ETA 25 min · Lagos Rescue Co
  2️⃣ ₦30,250 · ETA 18 min · Swift Towing
  3️⃣ ₦34,100 · ETA 12 min · QuickHaul

  Reply with the number of your choice.
  ```
- Motorist replies with the shortlist number. New session state
  `WAITING_FOR_QUOTE_SELECTION`.
- Selection reuses the existing race-guarded atomic-claim pattern
  (`prisma.rescueRequest.updateMany` gated on current status) — same
  safety property as today's "first accept wins" claim, just triggered by
  explicit motorist choice instead of an operator race.
- **On selection, the job is not yet awarded.** Chosen `DispatchOffer` →
  `SELECTED_PENDING_PAYMENT`; `RescueRequest` → the existing
  `WAITING_FOR_DEPOSIT` status. Every other `QUOTED` offer for this request
  → `NOT_SELECTED` immediately, and those operators are notified ("Sorry,
  the customer chose another quote — thanks for bidding!"). This is a
  deliberate simplification: if the selected operator's deposit times out
  (see Payment section), dispatch restarts as a fresh broadcast round
  rather than attempting to re-offer to the just-notified operators —
  consistent with how the existing accept-then-no-payment path already
  behaves today. Offers already `DECLINED` (operator explicitly said no)
  get no notification — they already know.
- The offer only becomes `ACCEPTED` — and the operator is only actually
  awarded the job — once the deposit payment webhook confirms success (see
  Payment section).
- **Motorist selection timeout:** reuses the existing 5-minute-window
  pattern already used elsewhere in this flow (e.g. deposit payment). If no
  selection within 5 minutes of the shortlist being sent, the shortlist is
  cancelled, all quoting operators are released (notified the customer
  didn't respond), and the motorist is prompted to send SOS again. No
  automatic cheapest-quote fallback — the motorist must actively choose,
  matching the "customer must actively confirm" principle already used for
  deposit payment.

## Payment / deposit calculation

Subscriptions are out of scope for this redesigned model — this spec does
not read or write `Subscription`, does not check tow allowances, and does
not include a deposit-skip path. Every motorist goes through the same
quote → select → deposit → dispatch → balance flow. (The existing
`SubscriptionService`/subscriber-check code is not touched or removed by
this spec; it simply isn't called from this flow. Retiring it fully is a
separate concern outside this design.)

On selection, compute once (reading the current `PlatformConfig` row) and
**immediately persist** onto the `RescueRequest` — `serviceFeeAmount`,
`depositAmount`, `balanceAmount` — in the same update that sets
`WAITING_FOR_DEPOSIT`:

```
serviceFee = round(quote.quotedPrice * config.serviceFeePercent / 100)
total      = quote.quotedPrice + serviceFee
deposit    = round(total * config.depositPercent / 100)
balance    = total - deposit
```

**This is a one-time computation, frozen at selection.** Every later step
in this job's lifecycle — generating the deposit payment link, generating
the balance payment link after completion, any receipt or admin report —
reads the persisted `depositAmount`/`balanceAmount`/`serviceFeeAmount` off
the `RescueRequest` row, never re-reads `PlatformConfig`. If an admin
changes `serviceFeePercent` from 10% to 15% while this job is in progress,
this job's terms stay exactly what the motorist selected; only the *next*
job's quotes are computed under the new percentage.

- These replace the fixed `DEPOSIT_AMOUNT_KOBO`/`BALANCE_AMOUNT_KOBO`/
  `FULL_AMOUNT_KOBO` constants for this flow.
- **The job is awarded on payment, not on selection.** Selection (previous
  section) moves the offer to `SELECTED_PENDING_PAYMENT` and the request to
  `WAITING_FOR_DEPOSIT`, and sends the motorist the deposit payment link
  (existing Paystack link generation, unchanged) for the computed
  `deposit` amount. Only once the deposit webhook confirms payment does the
  offer move to `ACCEPTED` and the request to `OPERATOR_ASSIGNED` (existing
  status) — mirroring exactly how today's accept-then-pay flow already
  gates on payment confirmation, just with the gate now sitting after
  motorist selection instead of after operator acceptance.
- The existing 5-minute deposit-payment timeout is unchanged in mechanism,
  but its failure path now targets the offer: if the deposit isn't
  confirmed in time, `SELECTED_PENDING_PAYMENT` → `TIMED_OUT`, the operator
  is notified they were released, and dispatch restarts as a fresh
  broadcast round (per the simplification noted in the previous section).
- **Mark-up model, not commission:** the operator's payout stays exactly
  `quote.quotedPrice` — the service fee is pure LRR margin on top and never
  touches the operator's payout math. (This deviates from the older docs'
  "deduct LRR's commission from the operator's payout" language —
  intentional, per this decision.)

## Admin config — service fee % and deposit % settings

- New `GET /api/v1/admin/settings` and `PATCH /api/v1/admin/settings`
  endpoints (admin/super-admin guarded, matching the existing admin-route
  pattern) — read/update the singleton `PlatformConfig` row. `PATCH`
  validates both percentages are within 0–100.
- New **Settings tab** in the admin dashboard (`lrr-web`), alongside the
  existing Overview/Rescue Requests/Operators/Payments/Manage Users tabs —
  a form with two numeric inputs (service fee %, deposit %) and a save
  button, following the existing tab-component pattern already in the
  dashboard.

## Rollout

- Additive migration: new `PlatformConfig` table (seeded with one default
  row, 10%/10%), new `DispatchOfferStatus` enum values, new nullable
  `DispatchOffer` columns.
- Repos touched: both `lrr-service` (schema, WhatsApp flow, dispatch/
  payment logic, admin API) and `lrr-web` (new Settings tab).
