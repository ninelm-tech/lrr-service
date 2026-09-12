# Operator Payout Notifications — Design

**Goal:** Tell an operator when their payout has actually been sent, and when their own missing bank details are the reason it hasn't been.

**Status:** Approved by user 2026-08-23.

## Background

Today an operator is told *"Your payment will be remitted within 24 hours"* in the balance-payment message (`PaymentEventsService.handleBalancePaymentConfirmed`) and then hears nothing — success or failure. Meanwhile `PayoutService.attemptPayout` can silently park a payout at `PENDING` / `NO_BANK_DETAILS` forever: the operator never learns money is waiting on them, and (per the payout spec's MVP decision) nothing auto-unblocks it. This was hit for real on staging on 2026-08-22.

**These notifications are business-initiated**, firing when a transfer webhook lands or when a balance payment confirms — well outside any 24-hour WhatsApp session an operator might have. They therefore require **approved Content Templates**, exactly like dispatch offers (see `2026-08-19-dispatch-offer-template-design.md`) and dispute alerts. UTILITY category; approval is typically ~a day.

## Scope

| Payout event | Notify operator? | Why |
|---|---|---|
| `SUCCESS` | **Yes** | They want to know the money arrived. |
| `PENDING` / `NO_BANK_DETAILS` | **Yes** | Actionable by them, and it's blocking their own money. |
| `PENDING` / `INSUFFICIENT_BALANCE` | **No** | Not actionable by the operator, and "we couldn't pay you because our account is short" damages trust when the fix is entirely LRR-side. Admin-visible only, via the Payouts tab. |
| `FAILED` | **No** (this iteration) | Often LRR-side rather than operator-fixable. Revisit if real failures cluster on bad account details. |

## Templates

Same env-gated pattern as `TWILIO_DISPUTE_TEMPLATE_SID` / `TWILIO_DISPATCH_OFFER_TEMPLATE_SID`: when the SID is unset, fall back to a freeform send so local and sandbox keep working before the template exists.

| Template | Env var | SID (created 2026-08-23) | Body |
|---|---|---|---|
| `payout_sent` | `TWILIO_PAYOUT_SENT_TEMPLATE_SID` | `HXe987d60303450c2aaa14c8615e3814b4` | `💰 Payment sent — Job #{{1}}. ₦{{2}} has been transferred to your registered bank account.` |
| `payout_bank_details_needed` | `TWILIO_PAYOUT_BANK_DETAILS_TEMPLATE_SID` | `HX99f7f52bf8b5633e40ce7c05f6a43285` | `💰 You've earned ₦{{2}} for Job #{{1}}. We don't have your bank details yet — add them at {{3}} to receive your payment.` |

⚠️ **Both templates exist but are NOT yet wired into the ECS task definition.** Until those two env vars are set on staging, the code takes the freeform fallback path. Before/after setting them, verify each declared variable set with `LRR Stage` credentials:
`curl -u "AC…:token" https://content.twilio.com/v1/Content/{sid}` — expect `1,2` for `payout_sent` and `1,2,3` for `payout_bank_details_needed`.

Variables:

| # | `payout_sent` | `payout_bank_details_needed` |
|---|---|---|
| 1 | bare job ref (`formatJobRef(rescueRequestId).replace('Job #','')`) | same |
| 2 | amount in naira (`(amount / 100).toLocaleString('en-NG')` — locale pinned so formatting doesn't vary with the container's default) | same |
| 3 | — | `${FRONTEND_URL}/settings` (where `OperatorProfileForm` already lives) |

Recipient is `operator.phoneNumber` — the business dispatch line, consistent with dispatch offers. It is non-nullable in the schema.

**Hard-won constraints from the dispatch-offer template work** (`2026-08-19-…`), which cost three deploys:
- Template parameters may not contain newlines, tabs, or 4+ consecutive spaces, and may not be empty — all four trigger Twilio 21656.
- The variable *count* must exactly match what the template declares; extras fail the whole send.
- **Verify the declared variable set against `GET https://content.twilio.com/v1/Content/{sid}` after creating each template** — reading the body text is not authoritative, since a repeated placeholder doesn't add a variable.
- A body may not **start or end with a variable** (Meta anti-spam rule). `payout_bank_details_needed` originally ended with `{{3}}` and would have been rejected; it now closes with "to receive your payment."

Both bodies above deliberately use each placeholder exactly once to avoid that trap.

**Are templates actually required here?** Not for the common path. Both notifications fire while the operator's 24-hour window is typically open — the bank-details one fires inside `handleBalancePaymentConfirmed`, the same moment existing code already freeform-messages the operator ("💵 Payment received!" and the rating prompt), and the operator usually sent `DONE` shortly before. The freeform fallback therefore works today with no template at all. Templates matter for the tail: **admin retries days later** (window certainly closed), slow-paying customers, and avoiding a money notification that silently no-ops. Recommended approach: ship on the freeform fallback, watch Sentry for `twilioCode: 63016` on these paths (now captured), and create the templates only if it actually appears.

## Where the notifications fire

**Paid** — in `confirmTransferOutcome`, the webhook path. The SUCCESS write becomes an atomic conditional update:

```ts
const changed = await this.prisma.payout.updateMany({
  where: { paystackTransferCode: transferCode, status: { not: PayoutStatus.SUCCESS } },
  data: { status: PayoutStatus.SUCCESS, completedAt: new Date() },
});
if (changed.count > 0) { /* notify */ }
```

Paystack re-delivers webhooks, so notifying unconditionally would double-message. Gating on "a row actually changed" prevents duplicate notifications from webhook redelivery without requiring a schema change.

**This is at-most-once, not exactly-once.** A crash between the status write and the notification send results in a missed notification: the row is already `SUCCESS`, so a redelivered webhook matches 0 rows and never retries the send. Durable exactly-once delivery (outbox table, notification state machine) is out of scope for MVP — the failure mode is an operator who was paid but not told, which the Payouts tab still shows correctly.

The FAILED branch keeps its current `update` behaviour.

**Bank details missing** — in `attemptPayout`'s no-recipient-code branch, but only on the *first* block. `attemptPayout` is reached from both `createAndProcessPayout` and `retryPayout`, so an admin clicking Retry three times must not send three identical messages.

Use a conditional write rather than read-then-write, so two concurrent attempts can't both observe "not yet blocked" and both notify — the same invariant as the SUCCESS path: **notify only when this invocation caused the state transition.**

The condition must be on `blockReason` **alone**, not on `status` as well — and must handle `NULL` explicitly:

```ts
const newlyBlocked = await this.prisma.payout.updateMany({
  where: {
    id: payoutId,
    OR: [
      { blockReason: null },
      { blockReason: { not: PayoutBlockReason.NO_BANK_DETAILS } },
    ],
  },
  data: {
    status: PayoutStatus.PENDING,
    blockReason: PayoutBlockReason.NO_BANK_DETAILS,
    failureReason: null,
  },
});
```

**The `blockReason: null` branch is load-bearing, not defensive.** `blockReason` is `PayoutBlockReason?` and a fresh payout starts `NULL`. A bare `NOT: { blockReason: NO_BANK_DETAILS }` compiles to `NOT (blockReason = '…')`, which is `UNKNOWN` — not `TRUE` — for a `NULL` row, so it matches nothing. Without the explicit null branch, the **first** block of every payout would match 0 rows, be treated as an already-notified repeat, never write `NO_BANK_DETAILS`, and never notify. That's the primary path, not an edge case.

Note the unit tests mock `updateMany` and therefore never evaluate this `where` clause — they can only assert its shape. Validating actual `NULL` matching semantics requires an integration test against real Postgres, which this codebase doesn't have.

Conditioning on `status` too would break it: `retryPayout` claims the row to `PROCESSING` before calling `attemptPayout`, so on every retry the row reads `(PROCESSING, NO_BANK_DETAILS)`. A `NOT { status: PENDING, blockReason: NO_BANK_DETAILS }` condition would therefore match every time and notify on every retry — exactly the behaviour we're suppressing. `blockReason` is untouched by the claim, so it alone carries "has this operator already been told?".

When `newlyBlocked.count === 0`, the row still needs its status restored to `PENDING` — the retry claim left it at `PROCESSING`, and skipping the write entirely would strand it there. So the no-transition path performs a plain status write and sends nothing.

Deliberate consequence: a retry that re-blocks stays silent. If genuine reminders are wanted later, that should be an explicit nudge job on a schedule — not an accident of how many times someone clicked a button.

## Failure isolation

A notification must never disrupt the payout flow — `createAndProcessPayout` is called from `handleBalancePaymentConfirmed` and is documented as never throwing. Every send is wrapped in try/catch, logged, and reported via `Sentry.captureException`, mirroring `DisputeService.sendStaffDisputeAlert`. A failed WhatsApp send leaves the payout row's status untouched and correct.

## Plumbing

- `PayoutModule` imports `TwilioModule`.
- `PayoutService` injects `TwilioService`.
- New private helpers on `PayoutService`: `notifyOperatorPaid(...)`, `notifyOperatorBankDetailsNeeded(...)`, each branching on its template SID exactly like `sendStaffDisputeAlert`.

## Testing

- Paid: notifies once; a re-delivered webhook (`updateMany` matches 0 rows) does **not** notify again; a send failure doesn't throw or corrupt the payout row.
- Bank details: notifies on first block; a retry that re-blocks does **not** re-notify **and still restores the row to `PENDING`** rather than leaving it stranded at `PROCESSING`; `INSUFFICIENT_BALANCE` never notifies.
- Template branch sends via `sendWhatsAppTemplateMessage` with the exact declared variable keys; unset SID falls back to freeform.
- Assert no variable contains a newline, tab, 4+ spaces, or is empty — the regression guard that the dispatch-offer work earned.

## Out of scope

- Auto-unblocking `PENDING` payouts when an operator later adds bank details (still the MVP manual-Retry decision from the payout spec) — though this notification makes that path far more likely to actually be travelled.
- `FAILED` and `INSUFFICIENT_BALANCE` operator notifications (see Scope).
- Creating/submitting the templates in Twilio and obtaining Meta approval — a manual console step. Until the SIDs are set, the freeform fallback applies, which only reaches operators inside an open 24h session.
