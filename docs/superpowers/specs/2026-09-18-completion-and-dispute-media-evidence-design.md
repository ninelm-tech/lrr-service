# Completion & Dispute Media Evidence — Design

**Date:** 2026-09-18
**Status:** Revised after a review round — 3 real issues fixed (see Data
Model and Admin Dashboard Changes below); pending final approval.

## Overview

Two related operator-feedback items, scoped together because they share one
mechanism and one schema decision:

- **Completion evidence (mandatory).** Today an operator can send
  `DONE`/`COMPLETE`/`FINISHED` and the job closes instantly — no evidence the
  work actually happened. Operators must now submit at least one photo/video
  before DONE is accepted, mirroring the motorist's existing mandatory
  breakdown-photo requirement at request creation.
- **Dispute evidence (optional, both sides).** Dispute statements
  (`operatorDisputeStatement` / `customerDisputeStatement`) are plain text
  today. Both the motorist and the operator can now attach photos/videos to
  their dispute statement, viewable by admin staff resolving the dispute.

Both reuse the existing, proven mechanism already used for the initial
breakdown photos: a WhatsApp session state that collects media, the
`RequestMedia` table, and Twilio-media-download-to-S3 via
`captureMediaAttachment`.

## Non-Goals

- No change to the existing INITIAL (motorist, request-creation) photo flow's
  own behavior.
- No admin ability to delete or moderate uploaded media in this pass.
- Not addressing the other operator-feedback items from the same batch
  (#2 benefits program, #5 destination-specificity, #7 phone-call
  preference) — each is a separate, later scoping conversation.

## Data Model

One migration, additive only:

```prisma
enum MediaContext {
  INITIAL     // motorist's breakdown photos, request creation — existing rows
  COMPLETION  // operator's evidence the job is done — new
  DISPUTE     // either party's evidence during a dispute — new
}

model RequestMedia {
  id String @id @default(cuid())

  rescueRequestId String
  rescueRequest   RescueRequest @relation(fields: [rescueRequestId], references: [id])

  mediaType   MediaType
  s3Key       String
  contentType String

  context        MediaContext @default(INITIAL)
  uploadedByRole UserRole     @default(CUSTOMER)

  createdAt DateTime @default(now())

  @@index([rescueRequestId])
  @@index([rescueRequestId, context, uploadedByRole])
}
```

- `context` defaults to `INITIAL` — every existing row is correctly backfilled
  by the migration itself, no manual data migration needed.
- `uploadedByRole` reuses the existing `UserRole` enum (`CUSTOMER`/`OPERATOR`
  are the only values that will ever appear here) rather than inventing a new
  type. Defaults to `CUSTOMER` for the migration — every existing (`INITIAL`)
  row really was motorist-submitted, so this default is factually correct for
  the backfill, not a placeholder.
- The `(rescueRequestId, context)` index backs two new queries: the
  per-context media cap (below) and the admin dashboard's grouped display.

**Media cap becomes per-`(rescueRequestId, context, uploadedByRole)`, not
per-request.** Today's `MAX_MEDIA_ITEMS` (5) is enforced via a count of *all*
rows for the request, regardless of context. Once completion/dispute media
share the table, a context-only cap isn't enough either: `DISPUTE` is the one
context with two possible uploaders, so a customer who sends 5 photos first
would leave the operator with zero slots for their own dispute evidence —
both sides were explicitly promised the ability to attach evidence. Every
existing-count check (initial, completion, dispute) filters by `context` AND
`uploadedByRole`. For `INITIAL` (always `CUSTOMER`) and `COMPLETION` (always
`OPERATOR`) this is a no-op relative to a context-only cap — there's only ever
one uploader role in practice — but keeping the same three-key filter
everywhere avoids a special case just for `DISPUTE`.
The index becomes `@@index([rescueRequestId, context, uploadedByRole])`.

**The "at least one required" gate must count only `IMAGE`/`VIDEO`, not
`AUDIO`.** `classifyMediaType` recognizes `audio/*` as `MediaType.AUDIO`, and
`captureMediaAttachment` saves anything it recognizes — so a voice-note-only
submission would otherwise satisfy a gate that just checks "is there at least
one row in this context." The existing `INITIAL` flow already avoids this
trap: its own "can continue?" check is a separate `visualCount` query filtered
to `{ mediaType: { in: [IMAGE, VIDEO] } }`, distinct from the (all-types)
count used for the 5-item cap — voice notes are accepted and saved, they just
don't count toward "evidence provided." `COMPLETION`'s and `DISPUTE`'s gates
reuse that same `visualCount`-style filter; the cap itself (previous
paragraph) still counts all recognized types, audio included.

## Flow Changes — Completion Evidence

- New state `WhatsAppFlowState.OPERATOR_AWAITING_COMPLETION_MEDIA`.
- `WhatsAppOperatorFlowService.handleOperatorMessage` gains a
  `body: Record<string, any>` parameter (mirroring
  `WhatsAppCustomerFlowService.handleCustomerMessage`, which already receives
  it) — threaded from `whatsapp-inbound.service.ts:74-81`. Nothing about this
  call site changes for the customer flow's own call two lines below.
- The existing DONE/COMPLETE/FINISHED branch
  (`whatsapp-operator-flow.service.ts:199-228`) no longer calls
  `handleOperatorJobDone` directly. It transitions the session to
  `OPERATOR_AWAITING_COMPLETION_MEDIA` and replies asking for a photo or video
  of the completed job.
- New branch for `OPERATOR_AWAITING_COMPLETION_MEDIA`, structurally identical
  to the customer flow's `WAITING_FOR_MEDIA` branch: parses
  `body.NumMedia`/`MediaUrl{i}`/`MediaContentType{i}`, "1" replies "send more",
  "2" attempts to continue and is rejected — same copy pattern as the
  existing `visualCount === 0` check — if no `IMAGE`/`VIDEO` row exists yet
  in this `(rescueRequestId, COMPLETION, OPERATOR)` bucket. A voice-note-only
  submission is saved but does not satisfy the gate, same as `INITIAL` today.
  Only once continue succeeds does `handleOperatorJobDone` actually run — its
  own pre-condition checks (request not already `CANCELLED`/`COMPLETED`) are
  unchanged and still correct, since it re-fetches the request fresh at call
  time regardless of how long the media step took.
- Each attachment saves via
  `captureMediaAttachment(rescueRequestId, mediaUrl, contentType, MediaContext.COMPLETION, UserRole.OPERATOR)`
  (audio included — `classifyMediaType` still classifies and saves it, it
  just doesn't count toward the gate above).

## Flow Changes — Dispute Evidence

- `captureMediaAttachment` moves from `private` (currently
  `WhatsAppCustomerFlowService`-only) to a method callable by both flow
  services — `WhatsAppOperatorFlowService` already injects
  `WhatsAppCustomerFlowService`, the same edge already used for
  `handleRatingReply`, so no new dependency wiring is needed. Gains two
  required params: `context: MediaContext`, `uploadedByRole: UserRole`.
- **Motorist side** — `AWAITING_DISPUTE_REASON`
  (`whatsapp-customer-flow.service.ts:157-161`):
  - Media present (`body.NumMedia > 0`): save each via
    `captureMediaAttachment(..., MediaContext.DISPUTE, UserRole.CUSTOMER)`.
  - Text present (`rawMessage` non-empty): write it to
    `customerDisputeStatement` and end the state, exactly as today — whether
    or not media was also attached in the same message.
  - Media present, no text: stay in `AWAITING_DISPUTE_REASON`, reply
    "📸 Got it — send more evidence, or reply with your explanation to
    finish."
  - Neither text nor media: no state change (this is a tightening of
    implicit behavior — today any inbound message, even an empty one, would
    have advanced the state by writing an empty string as the statement;
    that was never a real scenario from an actual WhatsApp client, and making
    it explicit here is intentional, not a gap).
- **Operator side** — `AWAITING_DISPUTE_RESPONSE`
  (`whatsapp-operator-flow.service.ts:76-89`): identical shape, saving with
  `UserRole.OPERATOR`, writing to `operatorDisputeStatement`.

## Admin Dashboard Changes

- New DTO `src/media/dto/request-media.dto.ts`:
  `{ id, url, mediaType, context, uploadedByRole, createdAt }` — `url` is the
  existing `/api/v1/media/:id` signed-redirect link, unchanged mechanism.
- `rescue-request-admin.service.ts`'s `detailForUser`: the `include.media`
  Prisma select expands from `{ id: true }` to the full field set needed by
  the new DTO. `RescueRequestDetailResponseDto` gains
  `media?: RequestMediaDto[]` (optional — see below).
- **`detailForUser` routes all three roles (`SUPER_ADMIN`/`ADMIN`, `OPERATOR`,
  `CUSTOMER`) through the same `mapToDetailDto(raw, offers?)` private method**
  — confirmed by reading the actual method (`rescue-request-admin.service.ts:780`),
  which takes no role parameter today. Populating `media` unconditionally
  there would hand every role the full, unfiltered array — an operator would
  see the *customer's* dispute photos and vice versa, defeating the point of
  routing dispute evidence to staff for adjudication. `mapToDetailDto` gains
  a third parameter, `includeAllMedia: boolean`, passed `true` only from the
  `SUPER_ADMIN`/`ADMIN` branch (`detailForUser`'s existing
  `role === 'SUPER_ADMIN' || role === 'ADMIN'` branch) and `false` from the
  `OPERATOR`/`CUSTOMER` branches. `media` is populated only when true;
  `mediaLinks` (INITIAL-only, per below) is unaffected and still returned to
  every role, matching today's behavior exactly.
- **`mediaLinks: string[]` stays on the response DTO unchanged in shape**,
  but its underlying query gains a `context: INITIAL` filter. It's also
  consumed by `PendingOffers.tsx` — the operator's pre-quote view of job
  photos before they bid — which must keep showing only the original
  breakdown photos. Without this filter, once completion/dispute media exist,
  they'd start leaking into a completely unrelated operator's quote screen
  for other jobs. `media` (the new array) is unfiltered and admin-only.
- **Details tab** (`RescueRequestsTabAdmin.tsx:660-673`): the flat "Photo
  1/2/3" text-link list is replaced with a grid grouped by context —
  `INITIAL` and `COMPLETION` sections, real `<img>`/`<video>` thumbnails
  (pointing at the same `/api/v1/media/:id` URL) instead of bare links.
- **Dispute tab**: new section rendering `DISPUTE`-context media, labeled
  "From customer" / "From operator" via `uploadedByRole`, placed next to the
  existing statement text.

## Testing

- **Unit:** `OPERATOR_AWAITING_COMPLETION_MEDIA` state transitions (accept
  media, "1"/"2" branching, zero-media rejection, per-context cap
  enforcement); dispute-media-attach behavior for both
  `AWAITING_DISPUTE_REASON`/`AWAITING_DISPUTE_RESPONSE` (media-only stays in
  state, text ends it either way, media+text both persist in one message).
- **Integration (real Postgres):** confirms the `mediaLinks` `INITIAL`-only
  filter genuinely excludes `COMPLETION`/`DISPUTE` rows once they exist in
  the same table — this is the one change with a real cross-feature
  regression risk (a filter bug here leaks dispute evidence into an
  unrelated operator's quote screen), so it gets its own real-database
  assertion rather than relying on a mock.
- **Manual QA:** a new section in
  `docs/qa/2026-09-10-full-system-test-plan.md`, added after implementation
  ships — per the user's own stated sequencing, not part of this plan.

## Note for the (Unimplemented) Account-Deletion Plan

`docs/superpowers/specs/2026-09-15-account-deletion-design.md` and its plan
were written 2026-09-15, before this feature existed — neither is
implemented yet (confirmed: no `deleteUser`/`deleteOperator`/
`PendingMediaDeletion` anywhere in `src/` or `prisma/schema.prisma` as of
this writing). That design's media-cleanup logic assumes every
`RequestMedia` row on a customer's own requests was customer-uploaded, and
that operator deletion has no media to clean up at all — both true today,
both false once this feature ships. Before that plan is implemented (the
user's own next step after this one), it needs a pass to account for
`uploadedByRole`: a customer deletion must not silently remove the
operator's completion/dispute evidence from a shared request, and an
operator deletion needs to purge the operator's own uploaded evidence
through the same `PendingMediaDeletion` outbox the existing design already
uses for dispute-statement text. Not fixed here — that file is out of this
spec's scope — but flagged so it isn't rediscovered from scratch.

## Decisions Made During Design (for the record)

- Media cap is per-`(rescueRequestId, context, uploadedByRole)`, not
  per-request — see Data Model above.
- The "evidence provided" gate (completion, dispute) counts only
  `IMAGE`/`VIDEO`; the 5-item cap counts all recognized types including
  `AUDIO` — mirrors the existing `INITIAL` flow's own `visualCount`-vs-cap
  split exactly.
- `media` (the new admin-only array) is gated by role inside
  `mapToDetailDto`, not by which endpoint is called — `detailForUser` already
  branches by role and calls the same mapper for all three.
- `uploadedByRole` reuses `UserRole` rather than a new enum.
- `mediaLinks` is filtered to `INITIAL`, not renamed or removed, to avoid
  touching `PendingOffers.tsx` at all — zero behavior change for the
  operator's pre-quote view.
- Placement in the admin dashboard reuses the existing Details/Dispute tab
  structure already in `RescueRequestsTabAdmin.tsx` rather than introducing a
  new global media view.
