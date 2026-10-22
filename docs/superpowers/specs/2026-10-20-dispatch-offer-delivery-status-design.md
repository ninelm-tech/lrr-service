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

That same `offerId` is also embedded in the `statusCallback` URL passed to
Twilio at send time (Section 3) — it's what the webhook uses to find its
way back to the row, not the Twilio SID.

### 3. Webhook

New route, separate from the existing inbound-message webhook:

```
POST /webhooks/twilio-status
```

Like every route in this app, actually served under the global prefix
`main.ts` sets via `app.setGlobalPrefix('api/v1')` — so the real path is
`/api/v1/webhooks/twilio-status`. Registered as the `statusCallback`
parameter **only** on dispatch-offer sends (`sendDispatchOfferMessage`'s
`client.messages.create(...)` call), built as:

```
${API_BASE_URL}/api/v1/webhooks/twilio-status?offerId=<DispatchOffer.id>
```

— not a Twilio Console-level default, so only the sends we decided to
track ever hit it.

**Correlating a callback to its offer — by `offerId`, not the Twilio
SID.** The `DispatchOffer` row's own primary key is known *before* the
send (it's created in the same transaction that writes the batch — see
Section 2), so it's embedded directly in the `statusCallback` URL rather
than correlating by `twilioMessageSid` after the fact. This removes a real
race: a fast callback (exactly the near-instant failures, e.g. error
63024, this feature exists to catch) could otherwise arrive before its SID
is even persisted, and would be silently dropped as unmatched. It also
means this lookup needs no new index — it updates by primary key, which is
already indexed, rather than by `twilioMessageSid`. The SID is still
captured and persisted (Section 2) as a secondary debugging aid for
cross-referencing Twilio's own dashboard, but nothing about correctness
depends on that write landing before any callback arrives.

**Signature validation:** Twilio's own `twilio.validateRequest(authToken,
signatureHeader, url, params)` — unlike Paystack's HMAC-over-raw-bytes
check, this validates against the *parsed* form params plus the exact
callback URL (query string included, so `offerId` can't be tampered with
by anything that doesn't also hold the Twilio auth token), so no raw-body
middleware is needed (the global `rawBody: true` in `main.ts` is
irrelevant here; `@Body()` is enough). `url` must be the exact public URL
Twilio was given — including `/api/v1` and the `?offerId=...` query
param — built from the same `API_BASE_URL` used to register the callback,
not whatever host/protocol the request happens to arrive with.

**Payload fields read:** `MessageSid`, `MessageStatus`, `ErrorCode`
(present only on failure statuses).

**Handler logic:**
1. Validate the signature; reject (and `Sentry.captureMessage`, mirroring
   the Paystack webhook's handling of an invalid signature) if it fails.
2. Look up the `DispatchOffer` by the `offerId` query param (its primary
   key). If none is found (e.g. a stale/retried callback, or an id from
   before this feature shipped), no-op — not an error.
3. Update `deliveryStatus` and `deliveryErrorCode` on that row —
   atomically, guarded (in the write's own `WHERE` clause, not a separate
   read then a conditional write) against an out-of-order callback
   overwriting a more-advanced status, e.g. a delayed `sent` arriving
   after `delivered` already landed. Twilio's lifecycle stages are ranked
   so a callback can only move a status forward; a status this app
   doesn't yet recognize (a future Twilio value) is never ranked against
   anything in either direction — it's always recorded when it arrives,
   and it never blocks a later recognized status from overwriting it
   either.
4. If `MessageStatus` is `undelivered` or `failed`, `Sentry.captureMessage`
   (or `captureException` with a constructed error) tagged with the offer's
   `rescueRequestId` and `operatorId`, matching the existing alert pattern
   in `deliverOffers`/`sendStaffDisputeAlert` — only when step 3's write
   actually took effect; a callback step 3 rejected as out-of-order never
   alerts.

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
