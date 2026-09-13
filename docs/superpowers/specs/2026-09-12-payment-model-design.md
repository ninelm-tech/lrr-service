# Payment Model Design

**Status:** approved design, not yet implemented
**Date:** 2026-09-12

## Goal

Make every movement of money a row in one table, with idempotency strong
enough that a lost network response can never cause a double payment, and
with a recovery path for any payment whose outcome we never learned.

## Why now

Four things went wrong at once, and they share a cause.

**A payout stuck in `PROCESSING` with nothing in Paystack's Transfers tab.**
`PayoutService.attemptPayout` sets `PROCESSING` only after `initiateTransfer`
returns a transfer code, so the transfer *was* accepted. Nothing in the
service ever revisits that row: the only exit is a `transfer.success` or
`transfer.failed` webhook. A missed webhook strands the payout permanently.
This is the same class of defect the durable-scheduling work removed
everywhere else — a state with no path out — and it survived because payments
were never part of that review.

**A stale failure reason.** `retryPayout` claims the row
(`PENDING|FAILED → PROCESSING`) but never clears `failureReason`, so the
previous attempt's text stays attached to the attempt now in flight. The row
represents "the payout" rather than "an attempt", so each retry overwrites
the history of the last one.

**A latent double-pay.** `generateReference('PAYOUT')` is called inline and
its result is never persisted — only Paystack's `transfer_code` is. If a
transfer reaches Paystack but the *response* is lost, the catch block records
`FAILED`, which is retryable, and the retry generates a **new** reference.
Paystack's idempotency is keyed on the reference, so it treats that as a
second, unrelated transfer. The operator is paid twice.

**Refunds that can never complete.** `PaystackService.refundTransaction`'s
own comment says Paystack "confirms via the refund.processed/refund.failed
webhook (see PaymentService)". `PaymentService` handles no refund events at
all — only `charge.success`, `transfer.success`, `transfer.failed` and
`transfer.reversed`; everything else falls through to an "unhandled event"
log. A refund set to `PENDING` today therefore never reaches `COMPLETED`,
and the comment points at code that does not exist.

The double-pay is the reason this is worth doing now rather than later. A
stranded payout or an uncompletable refund is an inconvenience; a duplicate
transfer is money out the door that has to be asked for back.

There is also no single view of a request's money. Deposit state lives on
`RescueRequest`, payouts live in `Payout`, refunds live in two more columns on
`RescueRequest`, and answering "what happened financially on this job" means
joining three shapes by hand.

## Scope

**In:** deposits, balance payments, refunds, operator payouts.

**Out:** subscriptions and memberships — see *Long term* below. They are
recorded there so the model does not have to change when they arrive, not
because they are being built.

## Model

```prisma
enum PaymentType   { DEPOSIT, BALANCE, REFUND, PAYOUT }
enum PaymentStatus { PENDING, SUBMITTED, BLOCKED, SUCCEEDED, FAILED, REVERSED }
enum PaymentBlockReason {
  // Never reached Paystack — we are the blocker. Safe to retry fresh.
  NO_BANK_DETAILS
  INSUFFICIENT_BALANCE
  // Reached Paystack, which is now waiting on a human. Never retry these:
  // the money movement already exists provider-side.
  AWAITING_OTP
  NEEDS_CUSTOMER_DETAILS
}

model Payment {
  id              String        @id @default(cuid())
  rescueRequestId String
  rescueRequest   RescueRequest @relation(fields: [rescueRequestId], references: [id])

  type            PaymentType
  status          PaymentStatus @default(PENDING)

  amount          Int           // kobo, always positive; `type` says which way it flows
  currency        String        @default("NGN")
  providerFee     Int?          // Paystack's cut, from the webhook payload
  netAmount       Int?          // what actually landed

  // Namespaced: `txn:123`, `refund:456`, `trf:TRF_ab12`. Paystack's
  // transaction ids and refund ids are independent numeric sequences, so a
  // bare id would let transaction 123 and refund 123 collide on this unique
  // index for no real reason.
  providerRef     String?       @unique
  operatorId      String?                // payouts only
  operator        Operator?     @relation(fields: [operatorId], references: [id])

  failureReason   String?
  blockReason     PaymentBlockReason?
  // NOT nullable, and defaulted, so a row is chaseable the instant it is
  // committed. If a new row could be inserted with this null, the crash
  // window between INSERT and the CAS would produce a payment the
  // reconciler's PENDING branch can never match — the branch exists
  // precisely for that window.
  verifyAfter     DateTime      @default(now())

  createdAt       DateTime      @default(now())
  settledAt       DateTime?

  @@index([rescueRequestId])
  @@index([status, verifyAfter])
}
```

### One row is one attempt

This is the load-bearing decision, and everything else follows from it.

A `Payment` row is never reused. A retry inserts a sibling; the failed row
keeps its status and its reason forever. The table is the audit trail, which
is why no separate failure-log table is needed — and why the stale
`failureReason` bug cannot recur, since nothing is ever overwritten.

### `id` is the reference

We deliberately do not carry a separate `reference` column. Two identifiers
for one attempt can drift, and there is nothing the second one buys. The
Paystack reference is formatted from the id at the call site:

```ts
const PREFIX: Record<PaymentType, string> = {
  DEPOSIT: 'DEP',      // unchanged — already live and already works
  BALANCE: 'BAL',      // unchanged
  PAYOUT:  'payout',   // lowercase: see below
  REFUND:  '',         // sends no reference at all — uses merchant_note
};
const reference = `${PREFIX[payment.type]}_${payment.id}`;   // DEP_cm3x…
```

On the way back the prefix is stripped and the row found by primary key.

**Keep `DEP_` and `BAL_` exactly as they are.** Renaming working, live
references to `DEPOSIT_`/`BALANCE_` would buy nothing and cost the
recognisability they already have in the Paystack dashboard. Only the
identifier *after* the prefix changes — from a timestamp-plus-random string
to the row's id.

**Payouts use a lowercase prefix.** Paystack documents transfer references as
lowercase alphanumerics plus `_` and `-`. In practice the current uppercase
`PAYOUT_…` has been accepted — the stuck payout came back with a
`transfer_code`, which only happens on acceptance — so this is alignment with
the documented constraint rather than a fix for a live break. It costs
nothing.

This is not cosmetic. Today's `` `${prefix}_${Date.now()}_${random}` `` is
produced *at call time* and therefore cannot be committed before the call —
which is precisely what makes the current code unable to distinguish a lost
response from a rejection. A cuid primary key exists the moment the row does.

**Exception — refunds.** Paystack's refund API accepts no `reference` field:
it takes the original transaction and returns its own id. The id still
travels, though — `merchant_note` is accepted on create and returned on read,
so it carries `Payment.id`:

```ts
await paystack.refundTransaction({ transaction, amount, merchant_note: payment.id });
```

That gives refunds the same property as everything else — a caller-chosen
identifier committed before the call — through a side channel rather than a
dedicated field. See *Refund recovery* for how it is read back.

## State machine

```
PENDING ──submit──▶ SUBMITTED ──▶ SUCCEEDED
   │                    │      ├─▶ FAILED
   │                    │      ├─▶ REVERSED
   │                    │      └─▶ BLOCKED ──human──▶ SUBMITTED ──▶ …
   └──▶ FAILED (never left the building)

waiting resolves:   SUBMITTED
a human resolves:   BLOCKED
nothing resolves:   SUCCEEDED, FAILED, REVERSED  (terminal)
```

| State | Meaning | Retryable? |
|---|---|---|
| `PENDING` | Row committed; **no call attempted** | No — attempt it |
| `SUBMITTED` | A call was attempted; **outcome unknown** | **No — verify it** |
| `BLOCKED` | Reached Paystack; **a human must act** | No — never poll, never retry |
| `SUCCEEDED` | Confirmed by webhook or verification | No |
| `FAILED` | Paystack **definitively** rejected it | Yes — new row |
| `REVERSED` | Succeeded, then clawed back | Yes — new row |

`SUBMITTED` deliberately does **not** mean "Paystack accepted". If the
response was lost we cannot know that it did — which is the entire situation
this state exists to represent. It means only that a call went out and we do
not know what became of it.

### The submission protocol

The ordering is load bearing, and it is the whole crash boundary:

```
1. INSERT the row as PENDING                    (committed before anything leaves)
2. CAS  PENDING → SUBMITTED, and in the SAME update
        verifyAfter = now + INITIAL_VERIFY_DELAY (BEFORE the HTTP call)
3. call Paystack — only if the CAS won
4a. explicit rejection    → CAS SUBMITTED → FAILED
4b. DUPLICATE REFERENCE   → leave it SUBMITTED and re-verify (see below)
4c. actionable non-final  → CAS SUBMITTED → BLOCKED, with a blockReason
4d. anything else         → leave it SUBMITTED, record providerRef if we got one
5. a terminal webhook or PaymentVerifyCheck is the ONLY thing that
   produces SUCCEEDED
```

**A 2xx response is not success.** `POST /transfer` returns a status that may
be `pending` or `otp`; `POST /refund` returns a refund that is still queued;
and `POST /transaction/initialize` returns nothing but a checkout URL — the
customer has not paid anything at that point. Treating any of those as
`SUCCEEDED` would mark money as moved that has not moved. The HTTP call can
only ever move a row to `FAILED` or `BLOCKED`, or leave it `SUBMITTED`. It
never produces `SUCCEEDED`.

**A duplicate-reference error is not a rejection.** On a same-reference
retry Paystack may answer that the reference already exists. That is
*positive evidence the original landed* — the opposite of a rejection — and
treating it as `FAILED` would be the worst possible reading: `FAILED` is
retryable with a **new** row and a **new** reference, which reopens exactly
the double-pay the same-reference retry exists to prevent. Such a row stays
`SUBMITTED` and goes back to verification, which will now find it.

**Step 2 must precede step 3.** Marking `SUBMITTED` only after the response
returns would make `PENDING` ambiguous in exactly the same way `FAILED` is
ambiguous today: a crash mid-call would leave a row that might or might not
have reached Paystack. With the CAS first, the two states partition cleanly —
`PENDING` provably never left, `SUBMITTED` might have.

**Step 2 must also push `verifyAfter` out, or it races its own HTTP call.**
`verifyAfter` defaults to `now()` so a `PENDING` row is chaseable the instant
it commits — but leaving it at `now()` through the CAS makes the row eligible
for verification *while the POST is still in flight*. Another instance would
verify, see "not found" because Paystack has not finished handling the
request, and for a `DEPOSIT` mark it `FAILED`. The original call then succeeds,
the motorist gets a payment link, pays — and the webhook cannot claim the row,
because the claim requires `SUBMITTED` and the row says `FAILED`. Money
received against a payment nothing acknowledges.

Setting `verifyAfter = now + INITIAL_VERIFY_DELAY` (30–60s) in the same update
closes it: nothing verifies a call that may still be in progress. This applies
to **both** paths that perform the CAS — the normal submission and the
reconciler's `PENDING → SUBMITTED` recovery.

**Only the winner of the CAS calls Paystack.** The reconciler and the request
handler can both reach step 2 for the same row; the conditional update
arbitrates, and the loser does nothing at all. That is what keeps a
`PENDING` row immediately chaseable without risking two initiations.

A crash between step 2 and step 3 leaves a `SUBMITTED` row with nothing sent.
Verification then finds no such reference at Paystack — but "not found" is
not by itself proof that nothing was sent, so what happens next depends on
which way the money flows. See *Resolving a SUBMITTED row*.

### Resolving a SUBMITTED row

The earlier framing — "never retry an unknown" — was too blunt. The precise
rule is:

> **Never retry with a new reference. Retrying the SAME reference is safe,
> and is how an unknown gets resolved.**

Paystack rejects a duplicate reference, so re-sending the identical request
cannot double-pay: either it lands for the first time, or Paystack tells us it
already has it. That rejection is itself the answer we were missing.

So an inconclusive verification does **not** mean failure:

- **`PAYOUT` — re-submit the same reference.** A "not found" is never
  definitive; it may be Paystack's read lag, and concluding `FAILED` would
  send a *new* reference for a transfer that already landed. Re-sending the
  identical reference is safe because Paystack rejects the duplicate. Back
  off, and escalate to staff after a bounded number of attempts.
- **`REFUND` — never re-submit.** The create endpoint takes no reference of
  ours, so there is no duplicate for Paystack to reject: a second POST is
  simply a second refund. Recovery is read-only — list refunds against the
  transaction and match on `merchant_note`. See *Refund recovery*.
- **Inbound money (`DEPOSIT`, `BALANCE`).** A transaction Paystack has never
  heard of means the customer never paid. Nothing moved, so `FAILED` is safe
  — and in practice the deposit window expiring cancels the request anyway.

The payout/refund split is the one asymmetry that is easy to get wrong: both
are outbound money, but only one of them has an identifier Paystack will
deduplicate on.

Today a network timeout writes `FAILED`, which is indistinguishable from a
genuine rejection and blindly retryable **with a fresh reference**. That last
part is the actual defect.

`blockReason` carries the cases that never reach Paystack at all — an
operator with no bank details, or an empty Paystack balance. Those are
`FAILED` with a `blockReason` set, which keeps the existing admin queue
("show me payouts blocked on bank details") working unchanged.

### Transitions are claims

Every status change is a conditional update, the same pattern as the
reconciler checks:

```ts
const { count } = await tx.payment.updateMany({
  where: { id, status: 'SUBMITTED' },        // the guard is the query
  data:  { status: 'SUCCEEDED', settledAt: now, providerFee, netAmount },
});
if (count === 0) return;   // a webhook and a verification raced; one wins
```

This matters more here than anywhere else in the codebase: once both the
webhook and the verification check exist, they will routinely arrive for the
same payment. That is the normal case, not an edge case.

## Invariants enforced in Postgres

Two partial unique indexes, written by hand in the migration because Prisma
cannot express them:

```sql
CREATE UNIQUE INDEX "one_inflight_payment_per_type"
  ON "Payment" ("rescueRequestId", "type")
  WHERE status IN ('PENDING', 'SUBMITTED', 'BLOCKED');

CREATE UNIQUE INDEX "one_succeeded_payment_per_type"
  ON "Payment" ("rescueRequestId", "type")
  WHERE status = 'SUCCEEDED';
```

**`BLOCKED` counts as in flight.** It means the money movement already
exists at Paystack and is waiting on a human — so a second attempt would
duplicate it. Leaving `BLOCKED` out of this index would let exactly that
second attempt be created, which is the double-pay arriving by a side door.
Retry is refused from `BLOCKED` for the same reason.

Together: **at most one attempt in flight — pending, submitted or blocked —
and at most one that succeeded.** An admin double-clicking Retry gets a
constraint violation rather than a second transfer. These belong in the database rather than a service method because
they are the guarantee the whole design exists to provide, and a service
method is one refactor away from not providing it.

## Recovery: `PaymentVerifyCheck`

A seventh reconciler check, alongside the six built in the durable-scheduling
work, following the same contract.

The check has **two branches**, because `PENDING` and `SUBMITTED` need
opposite treatment:

```ts
where: {
  status: { in: ['PENDING', 'SUBMITTED'] },   // BLOCKED is deliberately absent
  verifyAfter: { lt: now },
}
```

- **`PENDING` → initiate.** The row was committed and the process died before
  the CAS, so *no call was ever made*. Verifying it would be meaningless —
  Paystack has never heard of it and never will. The recovery is to CAS
  `PENDING → SUBMITTED` (pushing `verifyAfter` out, as in the normal path) and
  perform the first call. Without this branch that crash window leaves a
  payment nobody ever initiates: a new stranded state, in the document whose
  subject is stranded states.

  **For a collection, initiating is not enough — the link has to reach the
  motorist.** `/transaction/initialize` returns a checkout URL, and a
  recovered `DEPOSIT` or `BALANCE` that stores nothing and sends nothing has
  created a transaction the customer cannot pay: worse than the crash, because
  the row now looks healthy. The recovery must persist the URL to
  `depositPaymentUrl` and send it, exactly as the original path would have.
  For a `PAYOUT` there is nobody to send anything to, so initiating is the
  whole job.
- **`SUBMITTED` → verify.** Ask Paystack what it thinks and claim the terminal
  state it reports. If Paystack still says pending, push `verifyAfter` out on
  a backoff rather than polling hard.

`BLOCKED` rows are excluded from both. Nothing this check can do will move
them — see *Actionable non-terminal states*.

**Always verify by OUR reference, never by Paystack's identifier.**

| Type | Endpoint | Keyed on |
|---|---|---|
| `DEPOSIT`, `BALANCE` | `GET /transaction/verify/:reference` | our `id` |
| `PAYOUT` | `GET /transfer/verify/:reference` | our `id` |
| `REFUND` | see below | the original transaction |

This distinction is the point of persisting the id before the call. Verifying
a transfer by its `transfer_code` is useless in precisely the case recovery
exists for: if the response was lost, we never learned the code. Only a
reference we chose ourselves is guaranteed to be in hand.

**Both paths are verified against the live test integration** (2026-09-12),
not taken from documentation:

| Probe | Result |
|---|---|
| `GET /transfer/verify/PAYOUT_1789263636848_u1i0o3n` | `200` — a real record, returned by **our** reference |
| `GET /transfer/verify/does_not_exist` | `404`, `code: "not_found"` |
| `GET /transaction/verify/does_not_exist` | `400`, `code: "transaction_not_found"` |
| `GET /refund?transaction=1` | `200`, filter accepted |

**Branch on `code`, never on `message`.** Paystack returns a stable
machine-readable `code` alongside the prose, and the prose is not a contract.
Note the two "not found" cases differ in HTTP status as well as code — 404 for
transfers, 400 for transactions — so neither may be treated as the general
shape of the other.

**Still unverified:** whether `merchant_note` survives a round trip on a
refund record. The test integration has no refunds, so the field shape could
not be observed. The refund-recovery strategy depends on it, so Task 1 of the
implementation plan must establish it empirically before any code relies on
it — and if it does not round-trip, that strategy needs rethinking rather than
patching.

A `SUBMITTED` row Paystack has never heard of is **not** conclusive for
outbound money — see *Resolving a SUBMITTED row*. A payout re-submits the
same reference and backs off; a refund is recovered read-only, by matching on
`merchant_note`; only inbound types may be failed on a not-found.

This check is what would have surfaced the stuck payout on its own, about a
minute after it stuck.

### Provider status mapping

Observed on the live test integration rather than inferred:

| Paystack transfer status | Our state | Why |
|---|---|---|
| `success` | `SUCCEEDED` | money moved |
| `failed`, `reversed` | `FAILED` / `REVERSED` | definitive |
| `pending`, `processing` | `SUBMITTED` | waiting resolves it |
| `otp` | `BLOCKED` + `AWAITING_OTP` | a human must act |
| **`abandoned`** | **`FAILED`** | initiated, never finalised — see below |

**`abandoned` is terminal and means no money moved.** All three transfers
currently on the test integration are in it, with `transferred_at: null` and
`fee_charged: 0`. It is what a transfer becomes when it is initiated and never
finalised — the OTP path, left unanswered. Because nothing moved and the
transfer will not resume, `FAILED` is correct and a retry may legitimately
create a fresh attempt with a new reference.

Today's code handles none of these: it sets `PROCESSING` on the initiate
response and waits for a `transfer.success`/`transfer.failed` webhook that
never arrives for an abandoned transfer. That is the stranded payout, exactly.

### Actionable non-terminal states

`SUBMITTED` carries an implicit promise: **waiting will resolve it.** Two
provider states break that promise, and conflating them with `SUBMITTED`
would produce a row polled forever to no effect.

| Provider state | Waiting on | Our state |
|---|---|---|
| transfer `otp` | someone entering an OTP | `BLOCKED` + `AWAITING_OTP` |
| refund `needs-attention` | the customer's bank details | `BLOCKED` + `NEEDS_CUSTOMER_DETAILS` |

Both are excluded from the verification check and surfaced to staff instead.
Neither may be retried as a new attempt: the money movement already exists at
Paystack, so a second one would duplicate it.

**Unblocking returns the row to `SUBMITTED`, not to a terminal state.** Human
action restarts provider processing rather than completing it — supplying the
customer's bank details makes Paystack answer `processing`, not `success`. So
the transition is `BLOCKED → SUBMITTED`, and the webhook or the verification
check resolves it from there, exactly as for any other submitted row. It may
go terminal immediately, but only if Paystack actually returns a terminal
status.

**Production prerequisite: transfers OTP must be disabled. This is already
biting.** Every transfer on the test integration is `abandoned` — initiated,
never finalised, no money moved — which is what happens when OTP is on and
nobody supplies the code. It is not a hypothetical: it is why the payout you
went looking for was not in the Transfers tab.

With OTP enabled every payout stops at `AWAITING_OTP` until a person reads a
code, which no amount of automation fixes and which defeats the point of
automated payouts. Finalizing OTP programmatically is not worth building — it
needs a human in the loop by design. Disable it under Settings →
Preferences → Transfers, on **each** integration you intend to pay from.

**What disabling OTP costs, and what to do about it.** OTP is a second factor
on money leaving the account. Without it the secret key alone can move funds
to any recipient the holder creates — and that key lives in the ECS
environment. Going from two factors to one secret is a real reduction, so it
should be paired rather than done alone:

- **IP-allowlist transfer initiation.** ECS sits behind a NAT gateway with a
  stable egress IP, so pinning it makes a leaked key largely useless off the
  network. This is the highest-value control and the closest substitute for
  the factor being removed.
- Hold the secret in Secrets Manager rather than a plain task-definition
  environment variable.
- Alert on any payout above a threshold, so an anomaly is noticed in minutes
  rather than at reconciliation.

Automated payouts genuinely cannot coexist with a human-in-the-loop OTP, so
disabling it is the right call — but disable it *and* allowlist, not just
disable.

Note this applies only to the outbound leg. Collections are unaffected: the
customer authenticates with their own bank or card, and there is no OTP on our
side to turn off.

`needs-attention` has no such escape and needs a staff path — the refund
cannot proceed until the customer's bank details are supplied.

### Refund recovery

Refunds accept no `reference` field, so a lost response leaves a `SUBMITTED`
`REFUND` row with no `providerRef` — and unlike a transfer, there is no
endpoint that takes a reference of ours. Retrying the POST would issue a
**second refund**: the same failure as the double-pay, reached by a different
route. The `merchant_note` written at create time is what makes recovery
possible at all.

The recovery is to list refunds against the original transaction
(`GET /refund?transaction=…`) and find the one whose `merchant_note` is this
`Payment.id`:

- **A refund carrying our note exists** → adopt its id as `providerRef`
  (namespaced `refund:…`) and claim the terminal state from its status. The
  POST did land.
- **No such refund** → **stay `SUBMITTED`** and back off. Do not mark it
  failed, and above all do not POST again: a second create would issue a
  second refund. Escalate to staff after a bounded number of attempts.

**Matching must be by `merchant_note`, not by existence.** "Does any refund
exist for this transaction" is not sound: the partial index constrains *our*
rows, not Paystack's records. An earlier attempt we recorded as `FAILED` may
still have left a refund record at Paystack, so listing by transaction can
legitimately return more than one, and adopting an arbitrary member would
attach this attempt to a different refund. The note is what makes the answer
unique — which is the whole reason for putting `Payment.id` in it at create
time.

`refund.processed` and `refund.failed` must also be handled in
`PaymentService`, which today handles neither. The verification check is the
backstop; the webhook is the fast path, and right now there is no path at all.

## What is removed

| Removed | Replaced by |
|---|---|
| `Payout` table, `PayoutStatus`, `PayoutBlockReason` | `Payment` rows with `type: PAYOUT` |
| `RescueRequest.depositPaid` | `payments: { some: { type: DEPOSIT, status: SUCCEEDED } }` |
| `RescueRequest.balancePaid` | same, `type: BALANCE` |
| `RescueRequest.depositReference` | `Payment.id` |
| `RescueRequest.balanceReference` | `Payment.id` |
| `RescueRequest.depositRefundStatus` | derived — see below |
| `RescueRequest.depositRefundId` | `Payment.providerRef` on the `REFUND` row |

**Refund eligibility is derived, not stored.** `depositRefundStatus:
'ELIGIBLE'` today means "a deposit arrived on a request that had already been
cancelled, and an admin may refund it". That is not a payment attempt and so
is not a `Payment` row; it is exactly the condition *a succeeded `DEPOSIT`
exists, the request is `CANCELLED`, and no `REFUND` payment exists*. The
admin's `refundEligible` filter becomes that query. The remaining refund
states (`PENDING`, `COMPLETED`, `FAILED`) are the `REFUND` row's own status.

**The API contract does not change.** `depositPaid` and `balancePaid` stay in
the response DTOs as booleans, derived rather than stored. `lrr-web` reads
neither, and the admin list filter becomes a relation filter. Only storage
changes.

## What stays on `RescueRequest`

`depositAmount`, `balanceAmount` and `serviceFeeAmount` are **pricing, not
payment**. They are set at quote-selection time, before any money moves, and
they record what is *owed*. They stay exactly where they are.

The distinction is worth stating plainly, because it decides where anything
new belongs:

- **`RescueRequest` says what is owed.** Set once, at quote time.
- **`Payment` says what moved.** Attempts, outcomes, fees.

A request quoted at ₦5,000 with no payment row is the ordinary state for its
first thirty minutes — priced, unpaid — rather than something the schema has
to encode specially. Most requests (cancelled during dispatch, no operator
found) will have zero payment rows for their whole life.

This also enables a reconciliation query that cannot be written today:
requests where an amount is owed, no successful payment exists, and the
deposit window has passed.

## Fees are captured because they cannot be recovered

`providerFee` and `netAmount` come from two different places, and both are
**discarded today**: for collections they arrive in the `charge.success`
payload; for payouts they are `fee_charged` and `fees_breakdown` on the
transfer record itself. If they are not stored at the time, reconstructing what
was actually netted on a job months later means re-querying Paystack
transaction by transaction. For a business whose model is commission on
service price, gross-versus-net is not optional history.

`currency` is one cheap column that is impossible to add meaningfully later,
since old rows would have no recoverable denomination.

Deliberately **not** added: a `payerId`. With fleet customers the payer and
the beneficiary diverge, but for every row written before fleets exist the
payer is the request's customer — so it is perfectly backfillable, and a
speculative column tends to get populated wrongly in the meantime.

## Migration

No backfill. Production has no live users and no payment history worth
preserving; staging and local data is test traffic. Existing `Payout` rows and
the `RescueRequest` payment columns are dropped rather than migrated.

If that changes before implementation, the backfill is mechanical — one
`Payment` row per `Payout` row, plus one per request with `depositPaid` or
`balancePaid` set — and this section should be revisited rather than assumed.

## Operational note: test versus live integrations

Transfers, transactions and refunds are scoped to the integration whose
secret key made them. The service currently runs on `sk_test`, so everything
it has created lives on the **test** integration — which is why the live
dashboard's Transfers tab was empty while transfers plainly existed.

Worth stating because it costs an afternoon every time: an empty dashboard tab
is as likely to mean "wrong integration" as "nothing happened". The
verification check inherits this for free — it asks with the same key the
write used, so it can only ever see the integration that key belongs to.

## Operational note: Paystack balance

Transfers draw on the Paystack **balance** (`source: 'balance'`). Collections
do not accumulate there by default — with automatic settlement enabled,
Paystack sweeps the balance to the registered bank account each cycle, so it
sits near zero while Transactions shows plenty of successful payments.

Paying operators from Paystack therefore requires either disabling automatic
settlement so funds remain in the balance, or funding the balance separately.
`INSUFFICIENT_BALANCE` already exists as a block reason, so the code
anticipates this; the account configuration is what has to match.

This is a configuration decision, not a code change, but it belongs in this
document because a correct payment system on an unfunded balance still pays
nobody.

## Long term: subscriptions and memberships

Recorded so the model does not need fundamental change when this arrives.
Not in scope.

The planned model is an annual LRR membership (₦15,000) alongside on-demand
use, sold to individuals and — commercially more significant — to fleets:
logistics companies, corporate fleets, schools, hotels. Members get priority
dispatch and member pricing; on-demand users pay service price plus a
platform fee.

**What this does *not* change.** Member pricing is already accommodated:
amounts are snapshotted onto `RescueRequest` at quote time, so a member's
discounted deposit is a different number in an existing column. Priority
dispatch is a dispatch concern. A fleet's subscription is a new entity, not a
change to how a payment is recorded.

**Additive steps when it arrives**, none of them structural:

1. `SUBSCRIPTION` joins the `PaymentType` enum.
2. `rescueRequestId` becomes nullable (a non-blocking `ALTER`), and
   `subscriptionId` is added beside it with
   `CHECK (num_nonnulls("rescueRequestId", "subscriptionId") = 1)`.
   Two nullable foreign keys beat a polymorphic `(model, modelId)` pair at
   this scale: both keep real FKs and real Prisma relations, which
   polymorphic gives up entirely. Reconsider only past four or five payable
   types.
3. The partial indexes need no change. Subscription rows have a null
   `rescueRequestId`, and Postgres treats nulls as distinct in a unique
   index, so recurring monthly payments never collide.

**Two things that would be expensive to get wrong**, neither of them in
`Payment`:

- **Membership must not live on `User`.** A fleet is one payer and many
  beneficiaries, so `User.isMember` — the obvious first move when picturing
  individual motorists — makes every entitlement check wrong the day a fleet
  signs up. Membership needs its own entity, with the chain being
  *request → vehicle or driver → organisation → subscription*. An individual
  member is then an organisation of one.
- **Entitlement must be snapshotted onto the request, not derived at read
  time.** Otherwise a membership lapsing retroactively changes what a
  completed job cost, and historical revenue moves. Same principle as the
  amounts.

**Renewals are not ours to make idempotent.** Paystack initiates them; we
receive `charge.success` or `invoice.payment_failed` and move the
subscription's status. There is no call of ours to protect, so those rows —
if they exist at all — are created *from* the webhook and keyed on
`providerRef`. The *first* charge is different: we initiate it, so it carries
the same double-charge risk as a deposit and would want a `Payment` row.

That decision belongs to the membership design, with the real flow in front
of us.

## Testing

Integration tests against real Postgres, matching the durable-scheduling
work — the invariants are database behaviour and a mocked Prisma cannot
demonstrate them.

Cases that must exist:

- The partial indexes reject a second in-flight attempt and a second success.
- A retry after `FAILED` creates a sibling row; the failed row is unchanged.
- A retry is **refused** from `PENDING` and `SUBMITTED`.
- `PaymentVerifyCheck` claims the terminal state Paystack reports, and two
  concurrent runs act once.
- A webhook and a verification racing the same payment produce one transition.
- `depositPaid` derives false with no rows, false with only a failed row, and
  true with a succeeded one.
- Fee and net are persisted from the webhook payload.
- A 2xx from Paystack does **not** move a row to `SUCCEEDED`: a transfer that
  returns `pending` or `otp` stays `SUBMITTED`.
- A `SUBMITTED` `PAYOUT` that verification cannot find is **re-submitted with
  the same reference** and is not marked `FAILED`.
- A `SUBMITTED` `DEPOSIT` that verification cannot find *is* marked `FAILED`.
  The asymmetry between inbound and outbound is deliberate and must be pinned,
  or someone will later "fix" one to match the other.
- A `SUBMITTED` `REFUND` adopts the Paystack refund whose `merchant_note`
  matches its id, and ignores an unrelated refund on the same transaction.
- A `SUBMITTED` `REFUND` with no matching refund stays `SUBMITTED` — it must
  never POST a second create.
- `refund.processed` and `refund.failed` webhooks move a `REFUND` row to its
  terminal state.
- A transaction id and a refund id sharing the same number both store
  successfully, because `providerRef` is namespaced.
- A `PENDING` row picked up by the check is **initiated**, not verified — the
  crash-after-INSERT-before-CAS window.
- A duplicate-reference error leaves the row `SUBMITTED` and does **not**
  produce `FAILED` or a new attempt.
- A transfer returning `otp` and a refund returning `needs-attention` both
  become `BLOCKED`, are skipped by the verification check, and are never
  retried.
- A second attempt cannot be created while one is `BLOCKED` — the in-flight
  index covers it.
- Unblocking moves a row to `SUBMITTED`, not straight to a terminal state.
- A `SUBMITTED` `REFUND` is **never** re-submitted, where a `SUBMITTED`
  `PAYOUT` is — the two outbound types resolve differently and both must be
  pinned.
- A freshly inserted row has a non-null `verifyAfter`, so the check's
  `PENDING` branch can match it.
- The CAS to `SUBMITTED` pushes `verifyAfter` into the future, so a
  concurrent verification cannot see a row whose call is still in flight —
  and specifically cannot mark a `DEPOSIT` `FAILED` out from under a
  succeeding initialization.
- When two callers race the `PENDING → SUBMITTED` CAS, exactly one calls
  Paystack.
- A recovered `PENDING` `DEPOSIT` persists its checkout URL and sends it; the
  motorist is not left with an unpayable transaction.
