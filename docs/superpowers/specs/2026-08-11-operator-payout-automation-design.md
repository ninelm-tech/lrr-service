# Operator Payout Automation — Design

**Status:** Approved for planning
**Repos:** `lrr-service` (backend), `lrr-web` (operator + admin UI)

## Problem

Today, when a customer's balance payment is confirmed, the operator gets a
WhatsApp message promising "Your payment will be remitted within 24 hours" —
but no payout mechanism exists anywhere in the codebase. Remittance happens
manually, off-platform, with no record of what's owed, what's been paid, or
why a payout might have failed. This was flagged as the biggest gap against
the PRD's payout requirements.

## Goals

- Automatically transfer the operator's earnings via Paystack the moment a
  job's balance payment is confirmed — no manual step in the common case.
- Give operators a self-service way to provide payout bank details, with
  admin able to enter/correct them too.
- Keep a durable, queryable record of every payout attempt and its outcome.
- Give admins visibility into payouts and a way to retry failed ones.
- Fail safely: a payout problem must never block the customer/operator
  notifications or rating flow that already fire in the same handler.

## Non-goals

- Payout batching/scheduling (deferred — see Trigger Timing below).
- Automatic retry-with-backoff for failed transfers (admin-triggered retry
  only, per the failure-handling decision below).
- Handling Paystack settlement-to-bank timing — transfers are funded from
  the Paystack *balance*, not the settled bank balance, so this is out of
  scope for this feature (see External Dependencies).

## Money math

The platform fee is additive on top of the operator's quoted price, not a
cut taken from it (confirmed from `handleQuoteSelected`):

```
total          = quotedPrice + serviceFeeAmount
depositAmount  + balanceAmount = total
```

So the operator's payout amount is simply:

```
payoutAmount = depositAmount + balanceAmount - serviceFeeAmount
             = quotedPrice
```

This is computed directly from the `RescueRequest`'s already-persisted
`depositAmount`/`balanceAmount`/`serviceFeeAmount` — no need to re-look-up
the accepted `DispatchOffer`.

## Data model

```prisma
model Operator {
  // ...existing fields...
  bankCode              String?
  bankName              String?
  accountNumber         String?
  accountName           String?   // from Paystack's resolve-account response, never hand-typed
  paystackRecipientCode String?   // created once via Paystack, cached here

  payouts               Payout[]
}

enum PayoutStatus {
  PENDING     // created; either not yet attempted, or blocked from attempting (see blockReason)
  PROCESSING  // transfer initiated, awaiting webhook confirmation
  SUCCESS
  FAILED      // an actual transfer attempt was made and did not succeed
}
```

`PENDING` covers two distinct situations, distinguished by `blockReason`:
a payout that simply hasn't been attempted yet (`blockReason: null`, about
to be processed), and one that *can't* be attempted right now because a
precondition isn't met (`blockReason` set). `FAILED` is reserved for rows
where an actual transfer attempt was made and did not succeed — a job
whose operator hasn't entered bank details yet is not a failure, it's
correctly still pending, and conflating the two would make the admin
dashboard's failure count misleading (see Error handling summary below).

```prisma
enum PayoutBlockReason {
  NO_BANK_DETAILS
  INSUFFICIENT_BALANCE
}

model Payout {
  id                   String             @id @default(cuid())

  rescueRequestId      String             @unique   // one payout per completed job
  rescueRequest        RescueRequest      @relation(fields: [rescueRequestId], references: [id])

  operatorId           String
  operator             Operator           @relation(fields: [operatorId], references: [id])

  amount               Int                // kobo, = quotedPrice
  status               PayoutStatus       @default(PENDING)
  blockReason          PayoutBlockReason? // set only while status is PENDING and blocked
  paystackTransferCode String?
  failureReason        String?            // set only when status is FAILED

  createdAt            DateTime           @default(now())
  completedAt          DateTime?

  @@index([operatorId])
  @@index([status])
}
```

`RescueRequest` gains a `payout Payout?` back-relation (not required by any
query in this design, but kept for symmetry with the model's other
back-relations and to let `detailForUser` surface payout status later if
needed).

## Paystack integration

`PaystackService` gains four methods, alongside the existing
`initializePayment`/`verifyPayment`:

- `resolveAccountNumber(accountNumber, bankCode)` — calls Paystack's
  account-resolution endpoint, returns the verified `account_name`. Used at
  bank-details-save time; the account name is never typed by a human, only
  ever accepted from this response.
- `createTransferRecipient(operator)` — creates a Paystack transfer
  recipient from `bankCode`/`accountNumber`/`accountName`, returns
  `recipient_code`. Called once per operator, result cached as
  `paystackRecipientCode`; re-created if bank details are ever changed
  (saving new bank details clears the cached code).
- `checkBalance()` — calls Paystack's balance endpoint, returns the
  available balance in kobo.
- `initiateTransfer(recipientCode, amount, reference)` — calls Paystack's
  transfer endpoint, returns the transfer's initial status and
  `transfer_code`.

## Trigger & flow

`PayoutService.processPayout(payoutId)`, called from
`handleBalancePaymentConfirmed` immediately after the existing
customer/operator notification and rating-prompt block (Payout creation and
processing happens last in that handler, so a payout problem can never
prevent the customer/operator from being notified or prompted to rate):

1. Create the `Payout` row (`PENDING`, `blockReason: null`) with the
   computed `amount`.
2. If the operator has no `paystackRecipientCode`:
   - If they also have no bank details on file, set
     `blockReason: NO_BANK_DETAILS` and stop — status stays `PENDING`,
     nothing was attempted.
   - Otherwise call `createTransferRecipient`. If this call itself throws
     (a real attempt that failed, distinct from simply lacking details),
     go to step 5.
3. Call `checkBalance()`. If it can't cover `amount`, set
   `blockReason: INSUFFICIENT_BALANCE` and stop — status stays `PENDING`.
4. Call `initiateTransfer()`. On success, set status to `PROCESSING`,
   `blockReason: null`, and store `paystackTransferCode`. Final
   confirmation arrives asynchronously via webhook (step below).
5. Any thrown error from an actual attempt (recipient creation or transfer
   initiation — network failure, Paystack 4xx/5xx, etc.) is caught, logged
   to Sentry, and recorded as `status: FAILED` with the error message as
   `failureReason`. This method never throws back up into
   `handleBalancePaymentConfirmed`.

A `PENDING` payout blocked on `NO_BANK_DETAILS` does **not** automatically
retry when the operator later adds their bank details — for MVP it stays
`PENDING` until an admin clicks Retry (see Admin payouts view), consistent
with the manual-retry decision for `FAILED` payouts. Auto-retry-on-unblock
is a reasonable future enhancement but adds a second automatic trigger path
that isn't necessary for a first version.

## Webhook confirmation

Paystack transfers are asynchronous — `initiateTransfer`'s synchronous
response only confirms the transfer was *accepted for processing*, not that
funds landed. `payment.service.ts`'s existing `handlePaystackWebhook` event
switch (already used for `charge.success` etc., reached through the same
signature-verified `POST /webhooks/paystack` endpoint) gains:

- `transfer.success` → find the `Payout` by `paystackTransferCode`, set
  `status: SUCCESS`, `completedAt: now()`.
- `transfer.failed` / `transfer.reversed` → set `status: FAILED`,
  `failureReason` from the webhook payload's reason, `completedAt` left
  null (so it stays visible as needing a retry, distinct from a completed
  success).

## Bank details capture

One endpoint serves both the operator self-service case and the admin
edit case, role-checked rather than duplicated:

`POST /operators/:id/bank-details` — body: `{ bankCode, accountNumber }`.
- Callable by the operator themselves (existing operator-auth guard,
  `:id` must match the authenticated operator) or by an admin (existing
  admin-auth guard, any `:id`).
- Calls `resolveAccountNumber` to get the verified `accountName`.
- Saves `bankCode`/`accountNumber`/`accountName` on the `Operator`.
- Clears `paystackRecipientCode` (a stale recipient pointing at old bank
  details must not be reused — `processPayout` will recreate it on next
  use).

`lrr-web`:
- **Operator settings** (`SettingsTab` or equivalent operator-portal page)
  gets a "Payout details" section: bank dropdown + account number input +
  "Verify" button that calls the endpoint above and displays the resolved
  account name for confirmation before it's treated as saved. The bank
  dropdown is populated from a new `GET /paystack/banks` endpoint that
  proxies Paystack's bank-list endpoint (`PaystackService.listBanks()`,
  in-memory cached for the process lifetime — the list changes rarely and
  this avoids hardcoding bank codes that Paystack could add to or change).
- **Admin operator-edit view** (wherever admin already edits operator
  profile fields) gets the identical bank-details fields, same endpoint.

## Admin payouts view

- `GET /payouts` (admin-only), filterable by `status`, returns payout rows
  joined with operator business name and rescue request reference.
- New `PayoutsTab.tsx` in the admin dashboard: table of job / operator /
  amount / status / reason (`blockReason` for `PENDING`, `failureReason`
  for `FAILED`) / timestamps. Both `FAILED` rows and blocked `PENDING`
  rows (`blockReason` set) get a "Retry" button that calls
  `POST /payouts/:id/retry`, which re-invokes `processPayout` for that
  same `Payout` row (clearing `blockReason`/`failureReason` first). A
  `PENDING` row with no `blockReason` is mid-flight (about to be or
  currently being processed) and shows no Retry button.

## Error handling summary

| Situation | status | blockReason | failureReason |
|---|---|---|---|
| No bank details on file (nothing attempted) | `PENDING` | `NO_BANK_DETAILS` | — |
| Insufficient platform balance (nothing attempted) | `PENDING` | `INSUFFICIENT_BALANCE` | — |
| Recipient creation fails (an attempt) | `FAILED` | — | Paystack error message |
| Transfer API call fails (an attempt) | `FAILED` | — | Paystack error message |
| Transfer accepted, webhook reports failure/reversal | `FAILED` | — | Webhook's reason field |
| Any unexpected exception during an attempt | `FAILED` | — | Exception message |

This split keeps `FAILED` meaning what it says — an attempt was made and
didn't succeed — so the admin dashboard's failure count isn't inflated by
operators who simply haven't entered their bank details yet. All paths are
caught inside `processPayout` and never propagate to the caller. All are
Sentry-logged for visibility even before an admin checks the Payouts tab
(including the `PENDING`/blocked cases, since those still represent money
that should have moved and hasn't).

## External dependencies / assumptions

- **Transfer OTP:** Paystack transfers above a threshold require OTP
  finalization by default. Fully automated payouts require this disabled
  for LRR's account via a request to Paystack support — this is an
  account-configuration step outside the codebase, not something this
  design can build around. Documented here as a hard prerequisite for this
  feature to work as designed.
- **Paystack balance funding:** transfers draw from the platform's Paystack
  balance, which must be kept funded/topped-up independently of this
  feature. The balance pre-check (`checkBalance`) turns an underfunded
  balance into a visible `FAILED` payout with a clear reason, rather than a
  cryptic Paystack API error — it does not solve the funding problem
  itself, which remains an operational responsibility.
- **Settlement timing:** Paystack's settlement-to-bank schedule (typically
  next-business-day for Nigerian merchants, but account-specific and
  changeable by Paystack) does not gate transfers, since transfers draw
  from the balance, not the settled bank amount. Not modeled in this
  design.

## Testing

Unit tests for `PayoutService.processPayout`, one per row in the Error
handling summary table (asserting both the `status` and the
`blockReason`/`failureReason` split) plus the happy path (recipient
exists, balance sufficient, transfer succeeds → `PROCESSING` with
`paystackTransferCode` stored). Unit tests for the webhook handler's
`transfer.success` /
`transfer.failed` / `transfer.reversed` cases, covering the status
transition and the "no matching Payout found" edge case (log and no-op,
don't throw — a webhook for a payout we don't recognize shouldn't crash the
handler).
