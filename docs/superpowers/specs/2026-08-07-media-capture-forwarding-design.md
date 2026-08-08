# Media Capture & Forwarding — Design

Status: Approved
Date: 2026-08-08 (revised — see Revision note)

## Revision note

The first version of this spec had motorists' media accumulate as a JSON
array (`pendingMedia`) on `WhatsAppSession`, only becoming real
`RequestMedia` rows in a bulk insert once the `RescueRequest` itself was
created at the very end of the flow. That was solving a self-inflicted
problem: `RescueRequestStatus` already has progressive-state enum values
(`WAITING_FOR_LOCATION`, `WAITING_FOR_ISSUE_TYPE`) suggesting the original
intent was to create the row early and advance its status through the flow,
not defer creation to the end. This revision does exactly that — creates
`RescueRequest` right after destination capture, so each media attachment
becomes a real `RequestMedia` row immediately, with no intermediate JSON,
no bulk insert, and no risk of session/DB drift.

## Background

Field research and the original PRD both call out "mandatory visual evidence"
(photos/video/audio of the breakdown) as central to eliminating blind
dispatch — operators shouldn't drive out to a job only to find their truck
can't handle it or the damage is worse than described. The truck-class
matching spec (shipped separately, see
`2026-08-07-truck-class-vehicle-matching-design.md`) solved the "wrong truck
type" half of blind dispatch. This spec solves the other half: motorists
currently cannot send media at all — WhatsApp photos/video/audio are
silently dropped (confirmed: no `RequestMedia` model, no S3/media handling,
no `NumMedia`/`MediaUrl` parsing anywhere in the codebase before this spec).

## Goal

Motorists send photos/video/audio via WhatsApp during the SOS flow; LRR
stores it and forwards short redirect links to it inside the WhatsApp
dispatch offer sent to matched operators.

## Non-goals

- Voice-note transcription or any content analysis of media.
- Portal-side media viewing — WhatsApp-only per product decision (media
  reaches operators as links in the same WhatsApp message that carries the
  job offer, not through a separate portal view).
- Any change to pricing, matching, or truck-class logic — unrelated to this
  spec.
- Native inline WhatsApp media messages (image/video previews). Media is
  delivered as redirect links inside the existing text offer message, not as
  separate media-attachment messages.

## Data model changes (`prisma/schema.prisma`)

- New enum `MediaType`: `IMAGE`, `VIDEO`, `AUDIO`. (Named `IMAGE`, not
  `PHOTO` — this classifies by `image/*` MIME type, which also covers
  screenshots/scans, not just photographs.)
- New model `RequestMedia`:
  - `id`, `rescueRequestId` (FK → `RescueRequest`), `mediaType`, `s3Key`,
    `contentType`, `createdAt`.
  - One `RescueRequest` has many `RequestMedia` (relation added to
    `RescueRequest`).
- `RescueRequestStatus` gains a new value: `WAITING_FOR_MEDIA`, inserted
  between the existing "collecting request details" states and
  `DISPATCHING`. A `RescueRequest` sits in this status from the moment
  destination is captured until the motorist finishes sending media.
- Additive migration; no backfill needed (no existing `RescueRequest` rows
  are in this new status).
- No `WhatsAppSession` schema change is needed for media — the session
  already has a `rescueRequestId` field (existing, used elsewhere in the
  flow) which now gets populated earlier (at destination-capture time
  instead of at the end), and that's the only session-side change.

## S3 integration (`src/integrations/s3/`)

New integration module, following the existing `paystack`/`twilio` pattern
(its own folder, `dto/` if it needs request/response shapes, `s3.service.ts`
containing the class only).

- Private S3 bucket (e.g. `lrr-media`). Objects keyed
  `rescue-requests/{rescueRequestId}/{uuid}.{ext}` — now that the
  `RescueRequest` row exists before media capture begins, the S3 key can be
  meaningfully scoped to the real request ID from the start.
- `uploadMedia(buffer, contentType, key): Promise<void>`.
- `getSignedUrl(key, expirySeconds): Promise<string>` — called by the new
  media redirect endpoint (below) on each click, not at dispatch-offer-send
  time.
- Downloading from Twilio's inbound `MediaUrl0..N` requires HTTP Basic Auth
  with the Twilio Account SID/Auth Token — reuses the same
  `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` env vars `TwilioService` already
  reads via `ConfigService`, no new Twilio credentials needed.
- New env vars for the S3 bucket/region, added to `.env.example` following
  the existing documentation pattern for Twilio/Paystack config.

## WhatsApp flow changes

Flow becomes: `Location → Vehicle Type → Destination → Media → Dispatch`.

**Sequencing:** the `RescueRequest` row is created as soon as destination is
captured — with `status: WAITING_FOR_MEDIA` — not deferred to the end of
the flow. This means:

- The subscriber-check and deposit-amount decision (currently bundled into
  the same step that creates the row) moves to the *finish* of media
  capture instead, where it becomes an `update()` on the already-existing
  row (setting `depositPaid`/`depositAmount`, transitioning status to
  `DISPATCHING`) rather than part of a `create()`.
- A side benefit: if a motorist abandons the flow mid-media-capture and
  later types `CANCEL`, the existing cancel handler (which looks up an open
  `RescueRequest` for the customer) now finds and cancels a real row,
  instead of silently clearing session state with no DB trace — this was a
  gap in the previous version of this spec.

Step by step:

- New WhatsApp flow state `WAITING_FOR_MEDIA` (session-layer
  `WhatsAppFlowState`, distinct from the new `RescueRequestStatus` value of
  the same name), inserted after `WAITING_FOR_DESTINATION`.
- On destination capture: create the `RescueRequest`
  (`customerId`, `status: WAITING_FOR_MEDIA`, `latitude`, `longitude`,
  `vehicleType`, `destination`), store its `id` on the session as
  `rescueRequestId` (existing session field), transition session state to
  `WAITING_FOR_MEDIA`.
- On each inbound message while in `WAITING_FOR_MEDIA`: if
  `body.NumMedia > 0`, for each `MediaUrl{i}`/`MediaContentType{i}` pair,
  download via Twilio Basic Auth, classify `MediaContentType` into
  `IMAGE`/`VIDEO`/`AUDIO`, upload to S3, and — on success — immediately
  create a `RequestMedia` row against the already-existing
  `rescueRequestId`. No intermediate JSON, no bulk insert.
- Cap: 5 media items per request, checked by counting existing
  `RequestMedia` rows for this `rescueRequestId` before processing further
  attachments in an inbound message. Once reached, further attachments in
  that message are acknowledged but not stored, with a reply telling the
  motorist the limit is reached.
- Confirmation is a numbered reply, not a typed keyword — consistent with
  the rest of this flow's numbered-option convention (vehicle type already
  uses 1-4). After processing whatever attachments arrived in a message
  (an inbound WhatsApp message may carry more than one attachment via
  gallery multi-select — the prompt below fires once per *message*, not
  once per individual attachment), reply with the current saved count and:
  `1️⃣ Add more` / `2️⃣ Continue to dispatch`.
- Selecting `2` only proceeds if at least one `IMAGE` or `VIDEO` has been
  captured — `AUDIO` alone does not satisfy the requirement (an audio-only
  voice note describing the damage is still blind dispatch; the point of
  this spec is visual evidence). If the requirement isn't met, reply asking
  for at least one photo/video and stay in `WAITING_FOR_MEDIA`. Selecting
  `1` (or sending more media directly) simply continues capturing.
- A failed download or S3 upload for one attachment does not create a
  `RequestMedia` row, does not count toward the 5-item cap, and does not
  prevent other attachments in the same inbound message from being
  processed — each attachment is handled independently. The motorist is
  told if an item failed and should be resent.
- On selecting `2` with the requirement met: run the subscriber-check
  (currently duplicated logic for "skip deposit" vs. "dispatch-first with
  deposit"), `update()` the existing `RescueRequest` row (deposit fields,
  `status: DISPATCHING`), update the session (state `REQUEST_CONFIRMED`,
  dispatch tracking fields reset), send the confirmation message, and kick
  off `startDispatch` — same as the previous end-of-flow step, just
  operating on an `update()` instead of a `create()`.

## Media redirect endpoint

Raw signed S3 URLs are long, ugly query strings — a bad fit for a WhatsApp
message an operator has to read on a truck dashboard. Instead of embedding
the signed URL directly, LRR exposes a short, stable redirect link:

- New `GET /media/:mediaId` endpoint (new small controller, e.g. a `media`
  module, or added to an existing module if the plan finds a better fit).
  Looks up the `RequestMedia` row by ID, generates a signed S3 URL on the
  spot via `S3Service.getSignedUrl`, and issues a 302 redirect to it.
- No auth gate on this endpoint — the operator is opening it straight from
  WhatsApp with no session, and the ID is an opaque `cuid()` with the same
  guessability profile as any other resource ID already exposed by this
  API. Acceptable for MVP.
- Because the signed URL is generated fresh on every hit, there is no
  separate "expiry" concern for the link shared in the WhatsApp
  message — the `{API_BASE_URL}/media/{mediaId}` link itself doesn't
  expire; only the S3 signed URL it redirects to does, and that's
  regenerated per click.

## Dispatch forwarding (`startDispatch` in `rescue-request.service.ts`)

- No new WhatsApp-send method. The existing per-operator offer message
  (built in `startDispatch`'s batch-notify step, currently containing
  vehicle type, destination, distance, and pickup location) gets an
  additional "Photos/Video/Audio" section appended, listing one
  `{API_BASE_URL}/media/{mediaId}` redirect link per `RequestMedia` row on
  the request — not the raw S3 URL.
- The link-building logic is a private method on `RescueRequestService`
  (matching the placement of the existing `formatStatus`/`formatVehicleType`
  helpers already on that service — this codebase has no separate
  `formatters/` module convention to follow, so this method stays put
  rather than introducing a new one for a single caller).
- Best-effort: if a media link can't be constructed (e.g. missing
  `API_BASE_URL` config), that link is simply omitted from the message — it
  never blocks the message send or the dispatch offer itself. If ALL media
  links fail to construct, the offer still sends as plain text (matches the
  existing principle: dispatch reliability outranks the media nice-to-have).
- Known MVP limitation, not solved by this spec: even short redirect links,
  five of them in one message, is still a link-heavy WhatsApp message. If
  this proves to be a poor operator experience in practice, a future
  iteration may replace the link list with a single temporary media-view
  page. Not built now.

## Rollout

- New table, new enum value, additive migration, no backfill.
- Requires the new S3 bucket to exist and its credentials/env vars to be
  configured before deploy — this is an infrastructure prerequisite for the
  plan, not something the application code can self-provision.

## Repos touched

`lrr-service` only. No `lrr-web` changes — media forwarding is WhatsApp-only
per the "Forward into WhatsApp" product decision; there is no portal-side
media view in this spec.
