# Deposit Window and Late-Payment Refunds — Design

**Status:** Approved by user 2026-08-25.

**Goal:** Give a stranded motorist 30 minutes to pay their deposit instead of 5,
remind them along the way, and stop silently mishandling the case where payment
arrives after we've already moved on.

## Background

Two independent code paths give a motorist 5 minutes to pay a deposit —
`WhatsAppCustomerFlowService.handleQuoteSelected` (customer picks a quote) and
`RescueRequestAdminService.assignOperator` (admin manually assigns at an agreed
price). Both currently, on timeout, reset the request to `DISPATCHING` and
**re-dispatch**:

```ts
await this.prisma.rescueRequest.update({
  where: { id: rescueRequestId },
  data: { assignedOperatorId: null, status: RescueRequestStatus.DISPATCHING },
});
...
void this.dispatchService.startDispatch(rescueRequestId, rescueRequest.customerId);
```

This is wrong for the same reason the dispatch redesign removed automatic
re-offering elsewhere: nobody declined anything. The operator said yes and was
waiting on the customer to pay; re-dispatching burns a fresh round of operator
attention on a customer who may not be paying at all. Decided earlier in this
project: **no hold, no re-dispatch — the request either gets paid or it gets
cancelled.**

Separately, `PaymentEventsService.handleDepositPaymentConfirmed` writes
unconditionally, with no status check at all:

```ts
await this.prisma.rescueRequest.update({
  where: { id: rescueRequest.id },
  data:  { depositPaid: true, status: RescueRequestStatus.OPERATOR_ASSIGNED },
});
```

A deposit paid after the window has already cancelled the request lands here
anyway — the request silently becomes `OPERATOR_ASSIGNED` with
`assignedOperatorId` already cleared, the customer is told "operator is on the
way," and nobody is actually coming. This is a real, live gap independent of
the window length.

No refund capability exists anywhere in this codebase today.

## The model

### 1. One 30-minute window, three reminders, extracted into a shared helper

Both call sites currently duplicate the 5-minute timeout logic; extracting one
shared method removes that duplication rather than letting a second copy of
the new 30-minute version drift from the first. **Public** method (both
`WhatsAppCustomerFlowService` and `RescueRequestAdminService` call it, so it
cannot be private to either) on `RescueRequestSharedService`:

```ts
scheduleDepositWindow(params: {
  rescueRequestId: string;
  customerPhone: string;
  operatorPhone: string;
  paymentUrl: string;   // the reminders re-send this — needed to actually nudge, not just say "pay"
}): void
```

Fires, **each step first re-reading the request's current status** —
`this.prisma.rescueRequest.findUnique({ where: { id }, select: { status: true } })`
— and doing nothing at all if it's no longer `WAITING_FOR_DEPOSIT`. A customer
who pays at minute 7 must not receive the minute-15 or minute-25 reminder:

- **t=5min, t=15min:** if still `WAITING_FOR_DEPOSIT`, re-send `paymentUrl`
  with a short nudge
- **t=25min:** same nudge, explicitly warning cancellation is imminent
- **t=30min:** attempt the cancel (below) — its own atomic claim is what
  actually decides whether anything happens, not this status pre-check

**The 30-minute cancel must itself be an atomic claim, not a read-then-write.**
This is the same race the confirmed-payment guard in Section 2 exists to
close, from the other side: at exactly t=30, the payment webhook and the
timeout can both be mid-flight. If the timeout does a plain read-if-then-write,
the payment webhook can claim `WAITING_FOR_DEPOSIT → OPERATOR_ASSIGNED` in the
gap between the timeout's read and its write — and the timeout then
overwrites a **successfully paid** request to `CANCELLED`. The timeout must
compete for the row exactly like Section 2 does:

```ts
const claimed = await this.prisma.rescueRequest.updateMany({
  where: { id: rescueRequestId, status: RescueRequestStatus.WAITING_FOR_DEPOSIT },
  data:  { status: RescueRequestStatus.CANCELLED },
});
if (claimed.count === 0) return; // the payment webhook won the race — nothing to do
```

Only on a successful claim: mark the `DispatchOffer` `TIMED_OUT`, tell the
customer, tell the operator, **no call into `startDispatch`.**

Customer message, deliberately not "you were not charged" — that can be false,
since this design explicitly handles payment arriving after cancellation:

> "We didn't receive payment confirmation within 30 minutes, so your request
> was cancelled. If your payment completes after this, we'll refund it."

Operator message unchanged in spirit: "this job is no longer available — the
customer didn't pay in time."

Both existing call sites (`handleQuoteSelected`, `assignOperator`) are
rewritten to call this shared method instead of scheduling their own
`setTimeout`.

### 2. The confirmed-payment guard

`handleDepositPaymentConfirmed`'s write becomes a conditional claim — same
shape as every atomic write already in this codebase (`PayoutService`,
`DispatchService`'s quote-collection deadline):

```ts
const claimed = await this.prisma.rescueRequest.updateMany({
  where: { id: rescueRequest.id, status: RescueRequestStatus.WAITING_FOR_DEPOSIT },
  data:  { depositPaid: true, status: RescueRequestStatus.OPERATOR_ASSIGNED },
});
if (claimed.count === 0) {
  await this.handleUnclaimedDeposit(rescueRequest.id, reference);
  return;
}
// existing flow, unchanged, below
```

**`claimed.count === 0` is ambiguous by itself, and treating it as "always
late payment" is wrong.** Paystack redelivers webhooks. A perfectly normal,
already-successful payment looks like this:

1. Webhook #1 arrives: `WAITING_FOR_DEPOSIT` → claim succeeds → `depositPaid:
   true`, `OPERATOR_ASSIGNED`, operator dispatched.
2. Paystack redelivers the same webhook (their documented at-least-once
   behaviour).
3. Webhook #2 arrives: status is now `OPERATOR_ASSIGNED`, so the claim's
   `WHERE` no longer matches → `count === 0`.

Naively treating that as `handleLateDeposit` would tell a customer with a
perfectly valid, already-processed deposit that a refund is coming. The
`count === 0` branch must distinguish "already handled, this is a redelivery"
from "actually arrived too late":

```ts
private async handleUnclaimedDeposit(rescueRequestId: string, reference: string) {
  const fresh = await this.prisma.rescueRequest.findUniqueOrThrow({ where: { id: rescueRequestId } });

  if (fresh.depositPaid) {
    // Redelivery of a webhook we already successfully processed. No-op.
    logger.info('deposit: duplicate confirmation ignored', { rescueRequestId, reference });
    return;
  }

  if (fresh.status === RescueRequestStatus.CANCELLED) {
    // The only state this feature is actually about: money arrived after
    // the request moved on with nothing paid yet.
    await this.handleLateDeposit(fresh, reference);
    return;
  }

  // Anything else (e.g. some other status, or a state this design didn't
  // anticipate) is NOT auto-refund-eligible. depositPaid is false and the
  // request isn't CANCELLED — assigning an operator now would be wrong (the
  // window already closed or the state is unexpected), but so is silently
  // marking ELIGIBLE for a case this design didn't reason about. Alert and
  // stop; a human decides.
  console.error(`Deposit confirmed for request ${rescueRequestId} in unexpected status ${fresh.status}`, { reference });
  Sentry.captureMessage('Deposit confirmed in unexpected (non-CANCELLED) status', {
    level: 'error', extra: { rescueRequestId, reference, status: fresh.status },
  });
}
```

This also protects against a future status being added later and silently
becoming refund-eligible just because it happens not to be
`WAITING_FOR_DEPOSIT` — the `CANCELLED` check is exact, not "anything but the
happy path."

### 3. The late-payment path

```ts
private async handleLateDeposit(rescueRequest: RescueRequest, reference: string) {
  await this.prisma.rescueRequest.update({
    where: { id: rescueRequest.id },
    data:  { depositPaid: true, depositRefundStatus: 'ELIGIBLE' }, // status is left alone — still CANCELLED (or whatever it already is)
  });
  await this.twilioService.sendWhatsAppMessage(
    rescueRequest.customer.phoneNumber,
    `Your payment for a cancelled request has come through. We're processing a refund — you'll be notified once it's complete.`,
  );
  logger.info('deposit: late payment on a non-WAITING_FOR_DEPOSIT request', { rescueRequestId: rescueRequest.id, reference });
}
```

`depositPaid: true` is written even though the request is `CANCELLED` — this
is deliberate, not a bug. No operator is assigned, no "operator is on the way"
message is sent — the two things `handleDepositPaymentConfirmed`'s normal path
does that must not happen here.

**`depositRefundStatus: 'ELIGIBLE'` is the precise marker this feature is
about — not "any cancelled request that happens to have `depositPaid: true`."**
An earlier draft of this spec scoped the admin filter and the refund claim to
`status: CANCELLED, depositPaid: true` alone, which would have caught *every*
cancelled-after-payment request regardless of cause, conflating "late payment
raced a cancellation" with anything else that might someday produce that
combination. `handleLateDeposit` is the only place that ever writes
`ELIGIBLE`, so the refund surface (Section 4/5) means exactly what this
feature is for.

### 4. The admin-triggered refund

Schema additions on `RescueRequest`:

```prisma
depositRefundStatus RefundStatus @default(NONE)
depositRefundId     Int?          // Paystack's own refund id, from Create Refund's response
```

```prisma
enum RefundStatus {
  NONE        // not a late-payment case
  ELIGIBLE    // handleLateDeposit fired — admin can refund
  PENDING     // refund initiated at Paystack, awaiting webhook confirmation
  COMPLETED
  FAILED
}
```

**Correlation deliberately does NOT use a Paystack refund-specific reference
field.** Verified against Paystack's own docs (`Create Refund`): the request
takes `transaction` (the *original* transaction's id or reference — i.e. our
own `depositReference`, which we already store and is guaranteed non-null)
plus an optional `amount`, and the response contains the refund's own `id`.
What was **not** independently verifiable — Paystack's docs site 403s
automated fetches, and secondary sources disagree — is the exact field name
carrying a reference inside the `refund.processed`/`refund.failed` webhook
body, or whether that field is ever null on some event types. Rather than
build correlation on a field this spec couldn't confirm, **the webhook
handler matches on `data.transaction.reference` (or wherever the webhook
nests the original transaction) against our own `depositReference`** — a
value we control end-to-end and know is always present, sidestepping the
uncertainty entirely. `depositRefundId` is stored for reconciliation/logging,
not as the correlation key.

**Before implementation:** trigger one real refund against a Paystack test
transaction and inspect the actual `refund.processed` webhook payload Paystack
sends, to confirm the original-transaction field's exact name and shape. Do
not guess a second time on this — the dispatch-offer template work in this
same codebase already paid for one round of "verify against the live payload,
not the docs summary" (`2026-08-19-dispatch-offer-template-design.md`).

New endpoint on `RescueRequestAdminService`, same shape as
`PayoutService.retryPayout` — atomic claim, then act:

```ts
async refundDeposit(id: string): Promise<void> {
  // ELIGIBLE (first attempt) and FAILED (retry) are both claimable — same
  // shape as retryPayout's PENDING|FAILED → PROCESSING claim. A FAILED
  // refund must stay retryable, not get permanently stuck. NONE is
  // deliberately NOT claimable — see Section 3 on why ELIGIBLE, not
  // depositPaid alone, defines this feature's scope.
  const claimed = await this.prisma.rescueRequest.updateMany({
    where: { id, status: RescueRequestStatus.CANCELLED, depositRefundStatus: { in: ['ELIGIBLE', 'FAILED'] } },
    data: { depositRefundStatus: 'PENDING' },
  });
  if (claimed.count === 0) {
    throw new BadRequestException('Not eligible for refund — already refunded/in progress, or not a late-payment case.');
  }

  const request = await this.prisma.rescueRequest.findUniqueOrThrow({ where: { id } });
  try {
    const refund = await this.paystackService.refundTransaction(request.depositReference!, request.depositAmount!);
    await this.prisma.rescueRequest.update({
      where: { id },
      data:  { depositRefundId: refund.id },
    });
  } catch (err) {
    await this.prisma.rescueRequest.update({ where: { id }, data: { depositRefundStatus: 'FAILED' } });
    throw err;
  }
}
```

The `PENDING` claim is itself the concurrency guard — two admins clicking
Refund simultaneously: only one claims `{ELIGIBLE|FAILED} → PENDING`, the
other gets the `BadRequestException`. Same pattern as
`PayoutService.retryPayout`'s `PENDING|FAILED → PROCESSING` claim.

New `PaystackService.refundTransaction(transaction: string, amount: number): Promise<{ id: number; status: string }>`
— `transaction` is Paystack's own parameter name for the reference/id being
refunded (matches their Create Refund API exactly, not a generic
`reference`), following the existing method shape in that file (`fetch`
against `${this.baseUrl}/refund`). Always refunds the full `depositAmount` —
no partial-amount admin input, matching the "keep this simple" precedent from
the payout work.

### 5. Where the admin sees it

No new page. The existing admin Requests list gets a filter/badge for
`status: CANCELLED, depositRefundStatus: { in: ['ELIGIBLE', 'FAILED'] }`
— the same condition `refundDeposit`'s claim already uses (Section 4), so a
request is on this list precisely when it's eligible to click Refund on. A
`FAILED` attempt doesn't silently disappear — it stays on the list, still
retryable.

### 6. The refund webhook

Paystack refunds settle over days, not instantly — `refundTransaction` only
*initiates* one. Paystack's documented refund lifecycle is
`pending → processing → processed` (success) or `failed`, plus a distinct
`needs-attention` state when they require the customer's bank account details
to continue — not something this MVP's flow collects, since the refund goes
back to the card/account the deposit was originally paid from. Handling all
of Paystack's documented events explicitly, rather than only the success case:

```ts
case 'refund.processed': {
  await this.rescueRequestAdminService.confirmRefundOutcome(originalReference, 'COMPLETED');
  break;
}
case 'refund.failed': {
  await this.rescueRequestAdminService.confirmRefundOutcome(originalReference, 'FAILED');
  break;
}
case 'refund.needs-attention': {
  // Paystack is blocked on bank details we don't collect in this flow.
  // Surface it rather than let the row sit PENDING forever with no signal.
  Sentry.captureMessage('Refund needs-attention — Paystack requires bank details we do not collect', {
    level: 'warning', extra: { originalReference },
  });
  break;
}
```

Where `originalReference` is read from wherever the payload nests the
original transaction (see the correlation note in Section 4 — confirm this
against a real payload before writing the case bodies).

`confirmRefundOutcome` is a conditional write exactly like
`PayoutService.confirmTransferOutcome` — `updateMany` on
`depositReference: originalReference, depositRefundStatus: 'PENDING'`, flip to
`COMPLETED` or `FAILED`. Paystack redelivers webhooks; this must be
idempotent the same way the payout webhook already is, for the same reason.
`refund.needs-attention` deliberately leaves `depositRefundStatus` at
`PENDING` — it's not success or failure, just stuck; the Sentry alert is the
signal, not a status change.

No new dependency wiring needed: `PaymentModule` already imports
`RescueRequestModule` via `forwardRef` (for `PaymentEventsService`), and
`RescueRequestAdminService` is already exported from it — `PaymentService`
picks it up as an ordinary constructor injection.

## Explicitly not doing

- **Setting Paystack's account-level session timeout to 1800s.** Rejected —
  it's account-wide and would also cut the balance-payment link (collected
  later, operator present, a different flow that didn't ask for a shorter
  window) to the same 30 minutes. Our own guard closes the gap without
  touching a global setting that affects unrelated flows.
- **Partial refunds.** Always the full deposit amount.
- **A persisted/durable deposit-window timer.** The 30-minute `setTimeout` is
  in-process and lost on restart — the same known, already-accepted limitation
  as every other dispatch timer in this codebase (see
  `DispatchOfferSweeperService`'s existence for why). A request mid-window
  during a restart never gets its cancel-and-notify. Solving this properly
  means a persisted-deadline sweeper; out of scope for this feature alone,
  since the risk class already exists elsewhere and isn't made worse by this
  change.
- **A new admin Refunds page.** Filtering the existing Requests list instead.

## Testing

Mocked-Prisma tests in this codebase cannot observe real `NULL`/conditional
`WHERE`-clause semantics (Prisma is mocked, not run against Postgres), so
these assert call shape and manually simulate `count: 0`/`count: 1` returns to
exercise both branches of every conditional write below:

- **Confirmed-payment guard, all three outcomes of a failed claim:**
  - Claim succeeds (`WAITING_FOR_DEPOSIT`) → normal flow, operator assigned,
    "on the way" message sent.
  - Claim fails, `depositPaid` already `true` → webhook-redelivery no-op.
    **This is the third regression that matters most** — an earlier draft
    routed every failed claim straight to `handleLateDeposit`, which would
    have told a customer with an already-successful payment that a refund was
    coming, on every Paystack webhook redelivery of a normal payment.
  - Claim fails, `depositPaid` still `false`, `status: CANCELLED` →
    `handleLateDeposit` runs; operator is NOT assigned; the "on the way"
    message is NOT sent.
  - Claim fails, `depositPaid` still `false`, status is neither
    `WAITING_FOR_DEPOSIT` nor `CANCELLED` → neither `handleLateDeposit` nor
    the normal flow runs; a Sentry error fires; nothing is marked `ELIGIBLE`.
- **30-minute timeout:** cancels the request (`status: CANCELLED`), does NOT
  call `startDispatch`, does NOT reset to `DISPATCHING`. **This is the
  regression that matters most** — it's the exact bug being removed.
- **Timeout-vs-payment race is atomic:** simulate the payment webhook's claim
  succeeding first (`count: 1`) — the timeout's own claim must then see
  `count: 0` and take no action at all (no cancel message, no offer update).
  **This is the second regression that matters most** — an earlier draft of
  this spec had the timeout as a plain read-then-write, which this race would
  have broken silently.
- **Reminders fire at 5/15/25 only while still `WAITING_FOR_DEPOSIT`** — a
  reminder scheduled but whose pre-send status check finds the request already
  paid/cancelled sends nothing.
- **Refund claim is atomic:** two concurrent `refundDeposit` calls — only one
  succeeds, the other gets a `BadRequestException`.
- **`refundDeposit` rejects a plain `NONE` request** — `depositPaid: true` with
  `depositRefundStatus: NONE` (i.e. a normal, successfully-paid, non-late
  request) must not be claimable, even if somehow `CANCELLED` later. Only
  `ELIGIBLE`/`FAILED` are.
- **Refund webhook redelivery** does not double-write; a second delivery for
  an already-`COMPLETED` refund matches zero rows and is a no-op.
- **A `FAILED` refund remains eligible for retry** — the claim condition
  accepts `ELIGIBLE` and `FAILED`.
- **`refund.needs-attention`** captures a Sentry warning and leaves
  `depositRefundStatus` at `PENDING` — does not flip it to `FAILED` or
  `COMPLETED`.
- **Late deposit after a *customer-initiated* cancel** (not the 30-minute
  timeout) also hits `handleLateDeposit`, sets `ELIGIBLE` — the guard is on
  request state, not on which path caused the cancellation.
