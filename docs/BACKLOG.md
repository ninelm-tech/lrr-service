# Product Backlog

## Preserve Location Signals for Pricing Intelligence

**Status:** Deferred

Account deletion currently clears `RescueRequest.latitude`,
`RescueRequest.longitude`, and `RescueRequest.destination`. Revisit this before
building pricing intelligence so deleting a customer account does not also
destroy the non-identity signals needed to model regional demand and pricing.

The future design should:

- define a documented retention period and access policy for exact request
  coordinates;
- create a customer-detached pricing observation when a request is completed;
- retain only the useful pricing features, such as a coarse pickup zone,
  destination zone or journey distance, issue and vehicle type, time bucket,
  accepted quote, fees, payout, quote count, response time, and outcome;
- exclude customer identifiers, contact details, media, payment references, and
  free-text statements from the pricing dataset;
- decide when exact coordinates are converted to a coarse zone and removed from
  the operational request record; and
- update the account-deletion notice and retention policy before changing the
  current deletion behavior.

Do not change latitude or longitude deletion until this retention and
de-identification design is approved.

## Operator-Initiated Disputes & Mid-Job Price Increases

**Status:** Not doing (decided 2026-09-19)

Today only the customer/motorist can raise a dispute — `DisputeService.raiseDispute`
is called exclusively from the customer WhatsApp flow; the operator flow has no
DISPUTE command at all. Separately, dispute resolution can only settle the balance
at 1-100% of the original amount (`resolve-dispute.dto.ts`'s `@Max(100)`, mirrored
in the admin UI slider) — staff can discount or leave the price unchanged, but
never increase it.

This came up when a tester asked: what if something happens mid-job (extra
winching, vehicle stuck in a ditch, a longer haul than agreed) and the operator
legitimately needs to charge *more*? There is currently no path for that.

This is not a considered-and-rejected decision — it was never in scope. The
dispute feature (`docs/superpowers/specs/2026-09-08-dispute-resolution-balance-adjustment-design.md`)
was designed entirely around one scenario: the customer disputing because the
job under-delivered, and staff granting a discount. An operator needing to
charge more was never modeled.

If this is picked up in the future: don't just widen `balanceAdjustmentPercent`
past 100%. A dispute protects the customer from being overcharged; a price
increase protects the operator's right to be paid for extra work — opposite
trust models. Conflating them risks an operator "disputing" their way to a
higher price through the same lever a customer uses for a refund. Model it as
a separate, evidence-backed operator-initiated amendment flow (its own
WhatsApp keyword or admin action, its own bounded ceiling e.g. 150%) instead.

## Live Operator Location Tracking

**Status:** Not doing (raised 2026-09-19)

Customers cannot currently see a live position, or any position, of their
assigned operator. `Operator.latitude`/`longitude` is a one-time registration
address used only to rank dispatch candidates by distance — it's never
updated once a job starts. The only location sharing that actually happens
runs the other way: the customer's own request location is sent to the
operator at dispatch time (`dispatch.service.ts`, `payment-events.service.ts`),
so they know where to go.

This isn't just unbuilt, it's structurally hard: operators only interact
through WhatsApp, and the WhatsApp Business API (via Twilio) only supports a
single static location pin, not continuous live-location sharing the way
WhatsApp's own consumer app supports between two people. Real live tracking
needs GPS pushed from a device we control — a new operator-facing client (a
lightweight web view/PWA is enough, not necessarily a native app), a
location-ingest endpoint, and a public customer-facing tracking page. This is
a new client surface and new infrastructure, not a backend-only change.

This surfaced because ninelm.com's landing page claimed customers can "track
your operator until they arrive" and get "your operator's location link when
they're dispatched" — both false. Fixed 2026-09-19 to describe what's real
instead (WhatsApp arrival/completion updates, a one-time quoted ETA per
operator). If live tracking is picked up later, re-check the website's
feature claims again at that point too.
