# `rescue-request.service.ts` Decomposition — Design

**Date:** 2026-08-18
**Repo:** lrr-service

## Problem

`src/rescue-request/rescue-request.service.ts` is 2,541 lines — the WhatsApp bot's
entire brain (customer flow, operator flow, dispatch engine, payment webhook
handlers, disputes, admin/dashboard API, formatting helpers) in one class. No
other file in the codebase is close: the next largest is `operator.service.ts`
at 741 lines. Nothing this size is reviewable as a unit, and unrelated changes
(e.g. this session's dispute feature, destination-pin support) keep landing in
the same file as dispatch/payment logic they have nothing to do with.

No prior refactor of this shape exists to copy from — a similar oversized-file
problem was identified in a different product (Zalyx) but never actually
executed there, so this is a fresh design, not a repeat of an established
pattern.

## Current state

The file already has internal section-banner comments (`// ═══...`) marking
seven natural regions, which map almost 1:1 onto the proposed split below —
confirmed by reading every method against those banners:

- **WhatsApp inbound router + customer flow** (lines 114–877): `handleIncomingWhatsAppMessage`
  (top-level router — decides operator vs. customer vs. dispute/rating-reply
  routing), `captureMediaAttachment`, `handleMediaFinished`, `initiateDeposit`,
  `handleRatingReply`, `handleQuoteSelected`, `isSosMessage`, `mapIssueType`,
  `scheduleRatingTimeout`.
- **WhatsApp operator flow** (lines 474–718, interleaved with the above):
  `handleOperatorMessage`, `processQuoteOrDecline`, `handleOperatorQuoteOrDecline`,
  `handleOperatorArrived`, `handleOperatorJobDone`, `notifyPendingOperatorsOfCountdown`,
  `scheduleGraceResolve`.
- **Dispatch engine** (lines 1030–1435): `startDispatch`, `resolveBatch`,
  `maybeResolveBatchEarly`, `supersedeActiveRound`, `expandRadiusNow`,
  `manualOfferToOperator`, `sendQuoteShortlist`. Owns the in-memory
  `batchTimers`/`graceTimers` maps — the only state in the file that isn't
  DB-backed.
- **Payment webhook handlers** (lines 881–1025, 1812–1871):
  `handleDepositPaymentConfirmed`, `handleBalancePaymentConfirmed`,
  `markJobCompleted`, `sendBalancePaymentLink`.
- **Disputes** (lines 2259–2337): `raiseDispute`, `sendStaffDisputeAlert`,
  `resolveDispute` — already a clean, recently-built, self-contained cluster.
- **Admin/dashboard REST API** (lines 1876–2240): `adminList`, `assignOperator`,
  `updateStatus`, `cancel`, `operatorList`, `operatorDetail`, `listForUser`,
  `detailForUser`, `getDispatchBoard`, `buildListResponse`, `mapToDetailDto`.
  No WhatsApp involvement at all — this is what `lrr-web` actually calls.
- **Formatting helpers** (lines 2470–2538): `formatIssueType`, `formatStatus`,
  `formatJobRef`, `formatLocationSection`, `buildMediaLinksSection`, `reply`,
  `xmlOk` — pure, framework-free string formatting used across several of the
  groups above.

**External callers** (outside this module) — confirmed via grep, only two:
- `src/webhooks/webhooks.controller.ts:21` — calls `handleIncomingWhatsAppMessage`
  only.
- `src/payment/payment.service.ts:50,53` — calls `handleDepositPaymentConfirmed`
  and `handleBalancePaymentConfirmed` only. Both already inject
  `RescueRequestService` via `forwardRef`.

## Design

### New files

| File | Responsibility | Approx. source lines |
|---|---|---|
| `whatsapp-inbound.service.ts` | **New, not in the original split.** The top-level channel router only — decides operator vs. customer and delegates; that's the only channel-level decision that exists (dispute/rating are state-dependent customer-flow concerns, not routed here — see DI wiring). One operation, not a grab-bag of domain methods, so this doesn't recreate the facade problem the "no facade survives" rule exists to prevent. `WebhooksController` → `WhatsAppInboundService` → `WhatsAppOperatorFlowService`/`WhatsAppCustomerFlowService`. | ~20 lines of routing logic carved out of 114–150 |
| `whatsapp-customer-flow.service.ts` | Only the customer state machine: SOS intake → location → vehicle → destination → media → deposit-selection → rating. Does **not** own routing (moved to `WhatsAppInboundService` above) — genuinely just customer-flow behavior now. | 150–877 minus operator bits |
| `whatsapp-operator-flow.service.ts` | Operator's WhatsApp side: quote/decline, arrived, job-done, countdown notice. Thin — parses the inbound message, delegates the actual accept/decline decision to `DispatchService.processQuoteOrDecline` (the canonical domain operation, see below), formats the reply. | 474–718 |
| `dispatch.service.ts` | Matching/broadcast engine: batch creation, resolution, grace timers, radius expansion, manual offer, quote shortlist, `respondToOffer`/`listMyPendingOffers`, `getDispatchBoard`, and `alertAdminNoOperator` (moved here, not to shared — see rule below). Owns `batchTimers`/`graceTimers`. `processQuoteOrDecline` is the canonical accept/decline operation both channels call into — not reimplemented per-channel. `getDispatchBoard` belongs here rather than on the admin service because it's a projection of dispatch state (rounds/offers/timers), not general rescue-request CRUD — it'll evolve alongside the rest of this file, not alongside `adminList`/`cancel`/etc. | 1030–1435, 1737–1806, 2194–2240 |
| `payment-events.service.ts` | Paystack-webhook-triggered side effects: deposit/balance confirmed, job completion, balance payment link. Depends on `PaystackService` (the low-level integration) directly — **never** on `PaymentService` (the webhook orchestrator that already depends on this module via `forwardRef`), to avoid recreating that cycle one layer down. Confirmed safe: `sendBalancePaymentLink` already calls `this.paystackService` directly today, not `PaymentService`. | 881–1025, 1812–1871 |
| `dispute.service.ts` | Raise/resolve/staff-alert — already cohesive, lowest-risk extraction. | 2259–2337 |
| `rescue-request-admin.service.ts` | Dashboard-facing REST surface `lrr-web` calls: `adminList`, `assignOperator`, `updateStatus`, `cancel`, `operatorList`, `operatorDetail`, `listForUser`, `detailForUser`, `buildListResponse`, `mapToDetailDto`. No WhatsApp involvement, and no dispatch-board projection — that's `DispatchService`'s, per above. | 1876–2193, 2017–2049 |
| `domain/rescue-request-formatting.ts` | Pure exported functions, not NestJS-injected — matches the `domain/` convention already established elsewhere in this codebase (framework-free, unit-testable in isolation). | 2470–2538 |

`findOrCreateCustomer` is the only method that's genuinely cross-cutting (called
from customer flow, operator flow, and payment events alike) — it's what
`rescue-request-shared.service.ts` exists for. **Rule for what's allowed in
shared: infrastructure/domain primitives used by at least two extracted
services, never workflow orchestration.** `alertAdminNoOperator` looked like a
shared candidate at first glance, but all three of its call sites
(`rescue-request.service.ts:1107,1136,1147`) are inside the dispatch
zero-candidates/max-rounds path — it's dispatch behavior wearing a generic
name, and moves to `DispatchService` instead, not shared.

### DI wiring

Each new service is a real `@Injectable()`, registered in
`rescue-request.module.ts`, injecting whichever siblings it actually calls
(e.g. `DispatchService` injects `TwilioService` + `PlatformConfigService` +
the shared helpers; `WhatsAppCustomerFlowService` injects `DispatchService`
to trigger dispatch after media capture completes).

**`DisputeService` is a domain dependency of `WhatsAppCustomerFlowService`,
not something `WhatsAppInboundService` routes to.** The `DISPUTE` check lives
inside a state-dependent branch (`AWAITING_COMPLETION_CONFIRM`) at the same
structural layer as the rest of the customer state machine — it's not a
top-level channel decision like operator-vs-customer. Structurally identical
to rating handling, which stays in customer flow for the same reason.
`WhatsAppInboundService`'s routing tree is exactly three-way:

```
WhatsAppInboundService
  ├── WhatsAppOperatorFlowService   (phone matches an Operator)
  └── WhatsAppCustomerFlowService   (everything else)
```

`WhatsAppCustomerFlowService` internally calls `DisputeService` when its own
state machine sees a `dispute` reply during `AWAITING_COMPLETION_CONFIRM` —
same relationship it has with `DispatchService` for triggering dispatch.

**No facade `RescueRequestService` survives.** The two external callers are
updated directly rather than papered over:
- `webhooks.controller.ts` injects `WhatsAppInboundService` (the new thin
  router, not `WhatsAppCustomerFlowService` — the controller shouldn't need
  to know that customer-flow happens to be where the entry point currently
  lives) instead of `RescueRequestService`.
- `payment.service.ts` injects `PaymentEventsService` instead.

This is a deliberate call, not the path of least resistance: a facade that
re-exports every method would just recreate the god-object under a different
name and let it grow back. `WhatsAppInboundService` doesn't violate this rule
despite sitting in the same position architecturally — it exposes exactly one
channel-level operation (route this inbound message), not a grab-bag of ~40
domain methods. Both call sites are one-line `@Inject` swaps — low risk for
the clarity gained.

`rescue-request.controller.ts` (the dashboard API controller) is updated to
inject `RescueRequestAdminService` directly for most calls, plus
`DispatchService` directly for `listMyPendingOffers`/`respondToOffer` (see
below) and `getDispatchBoard`.

**`processQuoteOrDecline` is the canonical accept/decline operation, not
`respondToOffer` specifically.** Both channels reduce to the same call:
WhatsApp → parse the reply → `DispatchService.processQuoteOrDecline`; REST →
validate the DTO → `DispatchService.processQuoteOrDecline`. Neither channel
gets its own slightly-different implementation of "operator accepted/declined
a job" — `respondToOffer`/`listMyPendingOffers` and the WhatsApp operator
flow's quote handling both call through to the same core on `DispatchService`.

### Migration order

Smallest/most self-contained first, so each extraction is independently
verifiable before the riskier, more interdependent ones:

1. **`dispute.service.ts`** — self-contained, only calls `TwilioService` +
   `PlatformConfigService` + shared helpers. Lowest risk.
2. **`payment-events.service.ts`** — one external caller (`payment.service.ts`),
   well-isolated webhook handlers.
3. **`domain/rescue-request-formatting.ts`** — pure functions, extract early
   since steps 4-6 all depend on them; no behavior change possible (no DI, no
   side effects) makes this a safe, almost mechanical move.
4. **`rescue-request-admin.service.ts`** — no WhatsApp coupling, but touches
   the controller (real external caller) and `lrr-web`'s expectations
   indirectly via response shape — needs the DTO mapping (`mapToDetailDto`,
   `buildListResponse`) to move intact.
5. **`dispatch.service.ts`** — the most complex, but self-contained state
   (`batchTimers`/`graceTimers`); extract before the two WhatsApp-flow
   services since both of them call into it. Registered as a normal
   singleton provider in `rescue-request.module.ts`, exported from there and
   imported by any module that needs it — **never independently re-provided
   in a second module's `providers` array.** NestJS gives each module its own
   instance unless a provider is imported via the module system, and two
   independent `batchTimers`/`graceTimers` maps tracking the same rescue
   requests would produce exactly the kind of intermittent, hard-to-reproduce
   bug this refactor is supposed to reduce, not add. (Adding `OnModuleDestroy`
   cleanup for in-flight timers on shutdown would be a natural fit here later,
   but stays out of scope for this refactor per "no behavior changes.")
6. **`whatsapp-operator-flow.service.ts`** — depends on `DispatchService`
   (step 5) being done first.
7. **`whatsapp-customer-flow.service.ts`** — depends on step 5/6.
8. **`whatsapp-inbound.service.ts`** — genuinely last. It's the top-level
   router that ends up calling nearly everything else (customer flow,
   operator flow, dispute), so every service it delegates to must already
   exist. This is also the step that finally removes
   `handleIncomingWhatsAppMessage` from the old file and updates
   `webhooks.controller.ts`'s injection.

### Testing

`rescue-request.service.spec.ts` (1,274 lines) has ~10 independently-constructed
`TestingModule` blocks per describe group, already organized by method under
test — each block moves to a spec file alongside its new service, keeping the
same mock shapes and assertions. Full suite (`npx jest`) run after each of the
8 steps above, not just at the end — a broken step should be caught before the
next one builds on it.

**`tsc --noEmit` does NOT catch missing NestJS providers** — correcting the
original claim here. `constructor(private readonly dispatch: DispatchService)`
type-checks fine even if nobody registered `DispatchService` anywhere; the
failure only happens when Nest resolves the module graph at runtime
(`Nest can't resolve dependencies of X`). The real guard is a module
composition/smoke test: after each step, run `Test.createTestingModule({
imports: [RescueRequestModule] }).compile()` (or boot the actual `AppModule`)
and assert it resolves without throwing. This is the most important testing
addition beyond what the original draft called for — `tsc` stays as a useful
but insufficient check, not the DI-correctness check.

## Out of scope

- No behavior changes. This is a pure structural refactor — if any message
  text, status transition, or timing changes as a side effect of moving code,
  that's a bug to fix, not an intentional improvement bundled in.
- No change to `WhatsAppSessionStore`, `whatsapp-session.types.ts`, or any
  Prisma schema.
- Not touching `operator.service.ts`, `otp.service.ts`, or any other file —
  confirmed nothing else in the codebase is remotely close to this size.
- Not addressing `lrr-web`'s largest files (`OperatorsTab.tsx` 952 lines,
  `register/page.tsx` 790, `RescueRequestsTabAdmin.tsx` 735) — sizable but not
  in the same league, and a separate frontend concern.
