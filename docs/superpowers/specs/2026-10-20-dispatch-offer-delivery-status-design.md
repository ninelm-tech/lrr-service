# Dispatch Offer Delivery Status — Design

**Status:** Approved by user 2026-10-20, section by section, in chat.

**Goal:** Make it possible to tell, after the fact, whether a dispatch-offer
WhatsApp message actually reached an operator's phone — not just whether the
Twilio API accepted the send. Today that distinction is invisible: a
confirmed Twilio delivery failure and an operator who was reached and simply
never responded both show up identically as `TIMED_OUT`.

## Background

A production incident (2026-10-18, Job #H92Z4M) surfaced this gap. All 6
operators offered the job show `TIMED_OUT` with no quote. No Sentry issue
exists for the job — `deliverOffers`'s `Promise.allSettled` only captures a
failure when the Twilio *send call itself* throws, and none did; all 6 API
calls succeeded. But the account's own Twilio message log shows 3 of the 6
came back `undelivered` (error 63024 — "Invalid message recipient," a
recipient-side WhatsApp issue: not registered, hasn't accepted WhatsApp's
current ToS, outdated client, or a Meta messaging cap), discovered only
minutes to hours after the initial send, which already returned success.

`TwilioService.sendWhatsAppMessage`/`sendWhatsAppTemplateMessage` discard the
Twilio Message SID entirely (only `console.log`ged). With no SID persisted
anywhere and no status-callback webhook configured, this class of failure has
no path back into the system at all — not the DB, not Sentry, not the admin
UI. It would recur silently for every future job unless something changes.

**Confirmed via code search:** 14 call sites across the codebase use
`sendWhatsAppMessage`/`sendWhatsAppTemplateMessage`. Changing their return
type from `Promise<void>` to something carrying the SID is additive — no
existing caller destructures the return value, so none of the other 13 need
to change.

## Scope

Tracked: **dispatch-offer sends only** (`sendDispatchOfferMessage`, i.e. the
"🚨 NEW RESCUE JOB" message to an operator). This is the one message type
where a silent delivery failure is both high-consequence (the operator never
even knew to respond) and currently invisible — no human is staring at a
single conversation waiting for it the way a customer is for an OTP.

**Explicitly out of scope, confirmed with the user:**
- No tracking for any other outbound WhatsApp send (OTP, payment reminders,
  dispute/low-rating/stalled-confirmation/new-request staff alerts, quote
  countdown notices, etc.). Those failures are already visible to someone
  waiting on them in the moment.
- No backfill — historical `DispatchOffer` rows (including Job #H92Z4M) are
  not retroactively updated. This only instruments sends going forward.
- No automatic dispatch-behavior change. A confirmed `undelivered` does not
  skip that operator in a later round, expand the search radius early, or
  trigger a retry. Visibility only — a behavior change is a deliberate
  follow-up, not bundled into this.
- No fix to the *existing* inbound webhook (`POST /webhooks/twilio`)'s
  missing Twilio-signature validation. Noted as a related, pre-existing gap;
  not part of this feature.

## The model

### 1. Data model

Three additive, nullable columns on `DispatchOffer` — nullable because they
only ever get set going forward, never backfilled:

```prisma
model DispatchOffer {
  // ...existing fields...
  twilioMessageSid  String?
  deliveryStatus    String?
  deliveryErrorCode Int?
}
```

`deliveryStatus` stores Twilio's own status string verbatim (`sent`,
`delivered`, `read`, `undelivered`, `failed`, etc.) rather than a Prisma
enum mirroring Twilio's vocabulary — it's an external system's vocabulary,
not an internal domain concept, and a raw string means a new Twilio status
value years from now needs no code change to keep recording correctly.

One hand-written migration, no backfill:

```sql
ALTER TABLE "DispatchOffer" ADD COLUMN "twilioMessageSid" TEXT;
ALTER TABLE "DispatchOffer" ADD COLUMN "deliveryStatus" TEXT;
ALTER TABLE "DispatchOffer" ADD COLUMN "deliveryErrorCode" INTEGER;
```

### 2. Capturing the SID at send time

`TwilioService.sendWhatsAppMessage`/`sendWhatsAppTemplateMessage` change
from `Promise<void>` to `Promise<{ sid: string }>`, returning
`result.sid` from the existing `this.client.messages.create(...)` call
(already captured locally for the `console.log`, just not returned).

**The ordering wrinkle:** `DispatchOffer` rows are created via
`tx.dispatchOffer.createMany(...)` *inside* a transaction, before any
Twilio send happens — `deliverOffers` runs only after that transaction
commits (see its own docstring). So no `DispatchOffer.id` is available yet
at send time to attach a SID to, and `createMany` itself doesn't return the
created rows.

Fix: immediately after `createMany`, one `findMany` filtered on the same
`batchId` (already a UUID generated for the whole batch) fetches the new
rows' IDs in a single query. Zip those onto the `batch` array by
`operatorId` and carry `offerId` through into each `PendingOffer`. Then
`deliverOffers`, once a send resolves with a SID, does a targeted
`dispatchOffer.update({ where: { id: offerId }, data: { twilioMessageSid } })`
for that one row — independent per offer, so one update failing doesn't
block persisting the others (same `allSettled` discipline already used for
the sends themselves).

### 3. Webhook

New route, separate from the existing inbound-message webhook:

```
POST /webhooks/twilio-status
```

Registered as the `statusCallback` parameter **only** on dispatch-offer
sends (`sendDispatchOfferMessage`'s `client.messages.create(...)` call),
built from the existing `API_BASE_URL` env var
(`${API_BASE_URL}/webhooks/twilio-status`) — not a Twilio Console-level
default, so only the sends we decided to track ever hit it.

**Signature validation:** Twilio's own `twilio.validateRequest(authToken,
signatureHeader, url, params)` — unlike Paystack's HMAC-over-raw-bytes
check, this validates against the *parsed* form params plus the exact
callback URL, so no raw-body middleware is needed (the global `rawBody:
true` in `main.ts` is irrelevant here; `@Body()` is enough). `url` must be
the exact public URL Twilio was given, i.e. built from the same
`API_BASE_URL` used to register the callback.

**Payload fields read:** `MessageSid`, `MessageStatus`, `ErrorCode`
(present only on failure statuses).

**Handler logic:**
1. Validate the signature; reject (and `Sentry.captureMessage`, mirroring
   the Paystack webhook's handling of an invalid signature) if it fails.
2. Look up the `DispatchOffer` by `twilioMessageSid = MessageSid`. If none
   is found (e.g. a stale/retried callback, or a SID from before this
   feature shipped), no-op — not an error.
3. Update `deliveryStatus` and `deliveryErrorCode` on that row.
4. If `MessageStatus` is `undelivered` or `failed`, `Sentry.captureMessage`
   (or `captureException` with a constructed error) tagged with the offer's
   `rescueRequestId` and `operatorId`, matching the existing alert pattern
   in `deliverOffers`/`sendStaffDisputeAlert`.

### 4. Admin UI (lrr-web)

`DispatchOfferAdminDto` (`rescue-request-response.dto.ts`) gains
`deliveryStatus?: string` and `deliveryErrorCode?: number`, surfaced
through the same endpoint that already powers the quote-list modal in
`RescueRequestsTabAdmin.tsx` (the "Quotes (N)" list shown in the
screenshot from the incident).

In that list, an offer whose `status` is `TIMED_OUT` *and* whose
`deliveryStatus` is `undelivered` or `failed` shows an additional label —
e.g. `TIMED_OUT · Not delivered` — instead of being visually identical to
an operator who received the offer and chose not to respond. Every other
combination renders exactly as today: no `deliveryStatus` (not tracked, or
still in flight) looks unchanged, and a `TIMED_OUT` offer whose
`deliveryStatus` is `delivered`/`read` is a confirmed non-response, which
is exactly what plain `TIMED_OUT` already means today — it gets no new
label, since there's nothing new to say about it.
