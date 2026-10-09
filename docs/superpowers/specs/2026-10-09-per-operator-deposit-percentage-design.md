# Per-Operator Deposit Percentage — Design

## Goal

Let an operator set their own deposit percentage, overriding the
platform-wide default, and show that percentage to the customer at
quote-selection time so it factors into their decision — without
restricting what operators can set it to.

## Background

Field data (2026-10-09): of 24 operator units visited by the field PM, 11
were actually reached and pitched, 10 of those refused to sign up citing
the flat 10% deposit, and only 1 completed registration.

The direction matters and was initially misread during scoping: operators
are not asking for a *lower* deposit to ease onboarding friction. They want
the option to require a *higher* deposit than the platform's flat 10% —
10% feels like too little commitment from the customer, and operators bear
the cost (fuel, time) of driving out to a no-show. Confirmed directly by
the user after an initial wrong assumption in brainstorming.

Business-logic context that shapes this whole design: the deposit is money
the *platform* collects from the *customer* as an upfront commitment
signal. It is never money paid to the operator early — operators are only
ever paid out on job completion, today and after this change, regardless
of what deposit % applies. Changing the deposit percentage changes nothing
about operator payout timing or mechanics; it only changes how much of the
total price the customer commits upfront before an operator is confirmed.

Explicit product decision: no floor or ceiling beyond the trivial 0–100
range. The user was explicit that imposing a business-judgment restriction
(e.g. "no lower than 5%") would hand operators looking for a reason not to
adopt the platform exactly that reason. The one exception is a technical
floor behavior, not a business restriction — see "The 0% edge case" below.

## Section 1: Data model

Add to `model Operator` in `prisma/schema.prisma`:

```prisma
depositPercentOverride Decimal? @default(null)
```

Nullable `Decimal`, no default value (unlike `PlatformConfig.depositPercent`,
which defaults to `10.0`). `null` means "use the platform default"; any set
value overrides it for that operator only, with the same 0–100 inclusive
bounds already enforced on `PlatformConfig.depositPercent`
(`PlatformConfigService`'s existing `dto.depositPercent < 0 ||
dto.depositPercent > 100` check is the pattern to match).

**Freezing the percentage the customer actually sees.** This was a real gap
in the first draft of this spec, found in review and verified directly
against the code: `deliverQuoteShortlist` and `handleQuoteSelected` each
independently resolve `operator.depositPercentOverride ??
config.depositPercent` at different times, separated by up to the full
`QUOTE_SELECTION_WINDOW_MS` (5 minutes — confirmed in
`dispatch.constants.ts`). If an operator changes their override via the new
self-service endpoint during that window, a customer who saw "Deposit 20%"
on the shortlist and replies "1" would be charged whatever percentage is
*current* at selection time, not what they saw. The same risk exists even
for an operator using the platform default, if an admin changes the
platform-wide `depositPercent` during that window.

Fix: add `depositPercentSnapshot Decimal?` to `model DispatchOffer`. When
`deliverQuoteShortlist` builds the shortlist, it persists each quoted
offer's effective percentage (`operator.depositPercentOverride ??
config.depositPercent`) onto that offer at the same time, and renders the
snapshot value it just wrote — not a value it computes and discards.
`handleQuoteSelected` then reads `selectedOffer.depositPercentSnapshot`
for its calculation, never re-resolving the operator's current setting.
What the customer saw is what they pay, regardless of what changes in
between.

This snapshot requirement is specific to the customer-facing
quote-shortlist-then-select flow, because that is the only path with a
real time gap between "percentage shown" and "percentage charged."
`RescueRequestAdminService.assignOperator` (the staff-driven manual
assignment path) has no preceding shortlist shown to anyone — staff pick
an operator and set a price in one action — so it has nothing to freeze
against and continues to resolve `operator.depositPercentOverride ??
config.depositPercent` live, at the moment of assignment.

**The 0% edge case, fully specified.** With no floor, an operator can set
exactly 0%. Verified against the actual code that this needs more than "go
straight to OPERATOR_ASSIGNED" — `handleQuoteSelected`'s real transaction
(`whatsapp-customer-flow.service.ts`, inside the quote-selection
`$transaction`) unconditionally does all of the following before any
Paystack call happens: claims the request to `WAITING_FOR_DEPOSIT` with a
`depositWindowExpiresAt` deadline, moves the selected offer to
`SELECTED_PENDING_PAYMENT`, and calls `paymentLedger.create({ type:
'DEPOSIT', amount: depositAmount, ... })` — creating a real `DEPOSIT`
`Payment` row even at `amount: 0`. The code immediately after the
transaction then unconditionally calls `paystackService.initializePayment`
with that amount. `RescueRequestAdminService.assignOperator` does the
equivalent shape. Neither method has ever had a reason to branch on
`depositAmount === 0` before this feature.

The actual 0%-deposit branch, in both methods:
- Claim the request directly to `RescueRequestStatus.OPERATOR_ASSIGNED`
  (not `WAITING_FOR_DEPOSIT`) — no `depositWindowExpiresAt`.
- Move the selected offer directly to `DispatchOfferStatus.ACCEPTED` (not
  `SELECTED_PENDING_PAYMENT`).
- Do not call `paymentLedger.create` for a `DEPOSIT` payment, and do not
  call `paystackService.initializePayment` — no Payment row, no Paystack
  call, ever, for a ₦0 deposit.
- `depositAmount = 0`, `balanceAmount = total` persisted as normal.
- Losing/pending offers are still closed out exactly as today (the
  `NOT_SELECTED`/`TIMED_OUT` updates are unaffected by this branch).
- Customer and operator receive the normal "operator confirmed, job is
  live" notifications (the same shape `confirmDeposit` sends today once a
  deposit actually lands) instead of a payment-link message — there is no
  deposit to pay, so there is nothing to link to.

This applies at both calculation sites. It is a low-probability path given
the real driver here is operators raising their percentage, not lowering
it to zero, but "no restriction" technically reaches it (and was already
technically reachable before this feature, if the platform-wide default
itself were ever set to 0%), so it needs defined behavior rather than an
unhandled edge.

**The 100% edge case, fully specified — the symmetric gap, also found in
review.** The spec's first draft only handled the 0%-deposit edge and
missed that 100% deposit produces the mirror problem on the *balance* side:
`balanceAmount = total - depositAmount = 0`.

Verified against the actual code that this is not a theoretical risk —
it is an existing, real bug this feature would expose for the first time.
`markJobCompleted` (customer's `CONFIRM` reply, `payment-events.service.ts`)
always sets `status: COMPLETED` first, then calls
`sendBalancePaymentLink` whenever no succeeded `BALANCE` payment exists
yet — which is always true for a 100%-deposit job. Inside
`sendBalancePaymentLink`, the guard `if (!balanceAmount) { ...
Sentry.captureMessage('...missing balanceAmount'...); return; }` treats
`balanceAmount === 0` identically to a missing/corrupted value in
JavaScript — so today, a 100%-deposit job's `CONFIRM` would silently send
the customer nothing at all, fire a false "missing balanceAmount" Sentry
error for a perfectly legitimate state, and never reach a Paystack call
either way (the guard returns before that point).

The deeper problem: the method that does the *real* settlement work —
`confirmBalance` (status→`COMPLETED` again, ends the chat relay, sends the
customer their paid-in-full confirmation + rating prompt, sends the
operator their release-the-vehicle + rating prompt, and triggers
`payoutService.createAndProcessPayout`) — only ever runs when a real
`BALANCE` `Payment` row settles via the Paystack webhook. A 100%-deposit
job never creates that Payment row, so `confirmBalance` would never run at
all — no payout trigger, no rating prompts, nothing — regardless of how
the `!balanceAmount` guard above is patched.

There are two callers of `sendBalancePaymentLink`, not one — this matters
for where the fix belongs. `markJobCompleted` is the normal path. But
`DisputeService.resolveDispute` also calls `sendBalancePaymentLink`
directly, with `settledBalance = Math.round((originalBalance *
balanceAdjustmentPercent) / 100)` — and if the disputed request's
`originalBalance` is already 0 (a 100%-deposit job that got disputed),
`settledBalance` is 0 regardless of the adjustment percentage, hitting the
exact same false-alarm bug through a second path this spec's first draft
missed entirely. Verified directly: `resolveDispute` passes a spread of its
own `rescueRequest` (fetched with `customer`/`assignedOperator` included)
into `sendBalancePaymentLink`, but `sendBalancePaymentLink`'s own parameter
type, `BalancePaymentTarget`, deliberately excludes `assignedOperator` —
its own doc comment explains this exists specifically because the two
callers pass structurally different things. So neither caller can be
trusted to always hand `sendBalancePaymentLink` an operator-populated
record, and patching only `markJobCompleted`'s call site would leave
`resolveDispute` broken for this case.

Fix, placed one level deeper so both callers get it automatically: extract
`confirmBalance`'s body (everything after its initial `findUniqueOrThrow`)
into a new method, `finalizeJobSettlement(rescueRequestId: string):
Promise<void>`, that does its own fetch —
`findUniqueOrThrow({ where: { id: rescueRequestId }, include: { customer:
true, assignedOperator: true } })` — identical to what `confirmBalance`
already does today, rather than trusting a caller-provided object.
`confirmBalance(payment)` becomes a one-line wrapper:
`return this.finalizeJobSettlement(payment.rescueRequestId);` — unchanged
behavior for every existing case. `sendBalancePaymentLink` itself gains the
branch: distinguish "balance genuinely missing" (`balanceAmount == null`,
keep today's error-log-and-return) from "balance is legitimately zero"
(`balanceAmount === 0`, call `this.finalizeJobSettlement(rescueRequest.id)`
and return) before falling through to the existing Payment/Paystack logic
for every amount above zero. Both `markJobCompleted` and
`resolveDispute` call `sendBalancePaymentLink` exactly as they do today —
neither needs its own special case, because the one place they both
already funnel through is where the fix lives.

No `BALANCE` `Payment` row is ever created and no Paystack call is ever
made for a ₦0 balance, in either caller, and the customer gets the exact
same payout/notification/rating-prompt experience as every other completed
job. The platform still held the customer's full 100% deposit from the
start; this changes nothing about operators being paid only on completion.

## Section 2: Backend — endpoint, audit log, calculation sites

**New endpoint**, matching the existing `bank-details` precedent (financially
sensitive, already split out from the general profile-update endpoint in
this codebase) rather than folding into `UpdateOperatorProfileDto`:

```
PATCH /operators/:id/deposit-percent
Body: { depositPercentOverride: number | null }
```

Permission check: `assertCanManageOperator(req.user, id)` — the same check
`saveBankDetails` already uses (admins, or OWNER/MANAGER members of that
specific operator). This is deliberately the same access level as bank
details, not a narrower one — matches the user's explicit answer that both
staff and operators themselves should be able to set this.

Validation: 0–100 inclusive, or `null` to clear the override back to the
platform default. Reject anything outside that range with
`BadRequestException`, same as `PlatformConfigService`.

**Audit logging.** Every change writes an entry via the existing
`AuditLogService.record()`:
- `category: 'deposit_percent_changed'`
- `details`: operator id, before value, after value
- `actorId`: the staff member or the operator's own user id, whichever made
  the change

This is a genuine gap-filler over folding the field into the general
profile update: a deposit change gets its own clean history (who changed
what, from what %, to what %, when) instead of blending into generic
profile-update noise.

**The two existing calculation sites change differently from each other** —
see "Freezing the percentage the customer actually sees" above for why.

Both sites need one more thing neither code sample had until this review
caught it: `depositPercentOverride` and `depositPercentSnapshot` are
`Decimal` columns, same as `Operator.latitude`/`longitude` elsewhere in
this codebase — and every existing read of those is wrapped in `Number(...)`
before arithmetic (`Number(rescueRequest.latitude)` appears this way at
several call sites in `dispatch.service.ts`). `config.depositPercent` is
*already* a plain `number` by the time it reaches these sites —
`PlatformConfigService.getConfig()` converts it via `.toNumber()` — but
the two new fields are read straight off the Prisma model with no such
conversion. Left as `Decimal | number`, `Math.round((total *
depositPercent) / 100)` would do arithmetic against a raw `Decimal`
instance on one branch of the `??` and silently produce the wrong thing.
Both sites wrap the whole resolved value in `Number(...)`, matching the
codebase's existing convention exactly:

`WhatsAppCustomerFlowService.handleQuoteSelected` (currently line ~962)
reads the *snapshot* taken when the shortlist was built, never the
operator's current setting:
```ts
const depositPercent = Number(selectedOffer.depositPercentSnapshot ?? config.depositPercent);
const depositAmount = Math.round((total * depositPercent) / 100);
```
(The `?? config.depositPercent` here is a defensive fallback for a
snapshot that should always be populated by `deliverQuoteShortlist` in the
normal flow — not a second live-resolution path.)

`RescueRequestAdminService.assignOperator` (currently line ~173) has no
preceding shortlist to freeze against, so it resolves live, at the moment
of assignment:
```ts
const depositPercent = Number(operator.depositPercentOverride ?? config.depositPercent);
const depositAmount = Math.round((total * depositPercent) / 100);
```

The same conversion is needed anywhere either field crosses into an API
response DTO — the `PATCH /operators/:id/deposit-percent` response, the
operator detail/list responses that will surface the current override, and
the quote-shortlist's own per-line percentage — so the frontend never
receives a raw `Decimal` (which does not serialize to a clean JSON number)
instead of a plain one.

Both existing customer-facing messages that announce the deposit amount —
`WhatsAppCustomerFlowService.handleQuoteSelected`'s "🚗 Operator selected!
... Deposit: ₦X now" message, and the equivalent message in
`RescueRequestAdminService.assignOperator` — need no changes beyond this
calculation fix. Both already display whatever `depositAmount` was
computed with, so once that computation uses the operator's real
percentage, these messages automatically show the correct number.

## Section 3: Customer-facing quote shortlist

Before this change, there is exactly one place a customer ever learns
about the deposit at all: the post-selection "Operator selected! Deposit:
₦X now... tap the link... you have 5 minutes" message, sent *after* they've
already committed to a specific operator. No percentage or amount is shown
anywhere before that point today — a customer picks between quotes by
price and ETA alone, blind to what they'll actually owe upfront.

This design adds the operator's effective deposit percentage to every line
of the WhatsApp quote shortlist (`DispatchService.deliverQuoteShortlist`),
making it visible at the point it can actually inform the decision rather
than after:

```
1️⃣ ₦28,000 · ETA 12 min · Deposit 15% · Swift Towing
2️⃣ ₦26,500 · ETA 18 min · Deposit 10% · Raheem Towing
```

Every line shows its percentage, not only the ones with a custom override,
so every option is comparable on equal footing. No special treatment for
high percentages — no warning badge, no flagging — just the plain number,
consistent with not restricting what operators choose.

`deliverQuoteShortlist` is where the snapshot in Section 1 actually gets
written: for each quoted offer, it computes
`Number(offer.operator.depositPercentOverride ?? config.depositPercent)`
(no new query — `offer.operator` is already a full-row include via
`include: { operator: true }`; the `Number(...)` wrap is the same
Decimal-to-plain-number conversion described in Section 2) and persists it
onto that `DispatchOffer` via `depositPercentSnapshot` *before* building
the message — then the `forRanking`/display mapping reads the plain-number
value it just wrote, not a recomputed one, so the `Deposit X%` line
interpolates a real number rather than a raw `Decimal`. This is what makes
the number the customer sees and the number `handleQuoteSelected` later
charges provably the same value.

Ranking order is unchanged — still purely by `quotedPrice`, per the
existing `rankQuotes` comment ("markup is a uniform % and never changes
order"). Deposit percentage is information for the *customer* to weigh
manually; the system does not factor it into automatic ordering.

## Section 4: Where staff and operators set it

Both surfaces call the same `PATCH /operators/:id/deposit-percent`
endpoint, so there is one source of truth and one audit trail regardless
of who made the change.

**Staff side (lrr-web):** a deposit % field added to `OperatorsTab.tsx`'s
`StatsModal`, matching its existing inline-edit pattern already used for
address and service radius. Shows the current effective percentage —
override value, or "using platform default" annotated with the *actual*
current default fetched from platform settings, never a hardcoded number,
since `PlatformConfig.depositPercent` is itself admin-editable and can be
anything, not always 10 — editable, with a "reset to default" action that
sends `null`. Also addable as an optional field on the admin-onboarding
modal (`OnboardOperatorModal`) for
setting it at signup time, since that's where the field PM's pitch
actually happens.

**Operator self-service (lrr-web):** a new field in
`OperatorProfileForm.tsx`, calling the deposit-percent endpoint directly —
the same shape as that form's existing `saveBankDetails` call (its own
save action, not folded into the general profile save), since
`OperatorProfileForm.tsx` already establishes this pattern for the other
financially-sensitive field on that page.

## Section 5: Testing & error handling

- Unit tests for `PATCH :id/deposit-percent`: permission checks (admin
  allowed; OWNER/MANAGER member of that operator allowed; unrelated
  operator member rejected; unauthenticated rejected), validation (0–100
  bounds enforced, `null` clears to default), audit log entry written with
  the correct before/after values and actor.
- Unit test proving the freeze: `deliverQuoteShortlist` writes
  `depositPercentSnapshot` onto each quoted offer; a test that changes
  `operator.depositPercentOverride` *between* shortlist delivery and a
  simulated `handleQuoteSelected` call confirms the charged amount still
  matches the snapshot taken at shortlist time, not the operator's
  now-current setting.
- Unit tests for the 0%-deposit branch in both `handleQuoteSelected` and
  `assignOperator`: no `DEPOSIT` `Payment` row created, `paystackService`
  never called, request claimed straight to `OPERATOR_ASSIGNED`, offer
  moved straight to `ACCEPTED`, the "job is live" notification sent
  instead of a payment-link message.
- Unit tests for the 100%-deposit (`balanceAmount === 0`) branch: a test
  driving `markJobCompleted` and a separate test driving
  `DisputeService.resolveDispute` with a disputed 100%-deposit request,
  each confirming `sendBalancePaymentLink` routes to
  `finalizeJobSettlement` — no `BALANCE` `Payment` row, no Paystack call,
  but the payout (`payoutService.createAndProcessPayout`), the
  customer/operator notifications, and the rating-prompt session states
  all still fire exactly as they do for a normal settled balance payment.
  A regression test confirming `confirmBalance(payment)` is still
  byte-for-byte equivalent to calling `finalizeJobSettlement` directly,
  for the ordinary non-zero-balance case, so the extraction is provably
  behavior-preserving.
- Unit test for `deliverQuoteShortlist` confirming the correct per-operator
  percentage appears in each shortlist line.
- One integration test against real Postgres covering the full
  non-edge-case path: set an override on an operator, drive a request
  through quote selection, confirm the actual Paystack-initialized deposit
  amount matches the override, not the platform default.
- One integration test against real Postgres covering the 0% path
  end-to-end: operator with `depositPercentOverride: 0`, drive a request
  through quote selection, confirm the request lands on
  `OPERATOR_ASSIGNED` with zero `Payment` rows of type `DEPOSIT`.

Error handling: invalid percentage (outside 0–100) throws
`BadRequestException`, same pattern as `PlatformConfigService`'s own
validation. The only other new failure-adjacent behavior is the
0%/100%-balance branches above, which are deliberate, tested paths, not
error conditions — every other step reuses existing payment and
assignment error paths unchanged.

## Explicitly rejected

**Folding the field into the general `UpdateOperatorProfileDto` /
`PATCH /operators/:id` instead of a dedicated endpoint.** Simpler, but
loses the clean audit trail a financially-sensitive setting deserves, and
breaks from the `bank-details` precedent this codebase already
established for exactly this category of field.

**Any floor or ceiling beyond 0–100.** Explicit user decision: a
business-judgment restriction (e.g. "no lower than 5%") undermines the
entire point of this feature, which is giving operators who feel
unrepresented by a flat platform-wide number the latitude to set their
own. The 0% and 100% boundary behaviors specified in Section 1 are
technical necessities at those exact boundaries (no ₦0 Paystack charge
either direction), not restrictions on what operators can choose — both
ends of the full 0–100 range stay fully reachable.

**Deposit percentage affecting quote ranking order.** The system still
ranks purely by price. Deposit is surfaced for the customer to weigh
themselves, not folded into an automated score.

## Non-goals

Two related ideas came up during brainstorming and are explicitly out of
scope for this spec:

- **Tappable buttons for customer quote selection** (replying 1/2/3 by
  tapping instead of typing). Not pursued: the number of quotes shown
  isn't reliably capped low enough — `dispatchBatchSize` is
  admin-configurable up to 20 and the shortlist accumulates across
  dispatch rounds, while quick-reply buttons cap at 3 (unapproved) and
  list messages at 10. Typing a single digit is also already low-friction
  compared to the problems buttons solved for ARRIVED/DONE.
- **Tappable decline buttons for operators with multiple open job offers**,
  and **eliminating the job-ref-prefix requirement when quoting a price**.
  Real, separate ideas raised in the same conversation, not part of this
  deposit-percentage feature. Worth their own scoping pass later if wanted.
