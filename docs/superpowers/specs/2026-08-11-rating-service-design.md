# Rating Service — Design

## Background

No rating system exists anywhere in the codebase today. The PRD describes
motorists rating the tow operator after service completion (Motorist
"Service Completion" user flow: "confirm service completion, pay the
remaining 90% balance, and rate the tow operator") and operators reviewing
customer ratings in their earnings/history view. The operator-quotes
design explicitly dropped rating from the shortlist's composite ranking
score specifically because no rating system existed — its comment: *"there
is no ratings system anywhere in this codebase... building one is a
separate feature, out of scope here."* This spec is that separate feature.

Task 9 of the operator-quotes plan removed a dead "Reply 1-5 to rate your
operator" line from the balance-confirmation WhatsApp message, since no
handler for it existed. This spec adds the real handler.

## Goal

After a job completes and the balance is paid, the motorist is prompted on
WhatsApp to rate the operator 1-5. They also receive a link to an
unauthenticated web page where they can optionally add free-text feedback
tied to that specific rating. Operators see their average rating and
recent ratings (with any comments) in their own portal; admins see the
same average per operator.

## Non-goals

- No reintegration into the shortlist's composite ranking formula — a
  separate follow-up once real rating data exists (ranking on zero/sparse
  data on day one would be misleading).
- No comment collection over WhatsApp (no second round-trip) — free text
  only via the web link.
- No rating edit/expiry semantics beyond "last submission wins" — the
  feedback link has no deadline and re-submitting overwrites the comment.
- No automated action on low ratings (e.g. an alert, an admin
  notification) — the data model supports building that later (every
  rating is fully traceable to its request/customer/operator), but nothing
  triggers on score today.
- No public display of ratings to motorists (e.g. shown on the shortlist)
  — this pass is collection + operator/admin display only.

## Data model changes (`prisma/schema.prisma`)

New model:

```prisma
model Rating {
  id               String        @id @default(cuid())
  rescueRequestId  String        @unique
  rescueRequest    RescueRequest @relation(fields: [rescueRequestId], references: [id])
  operatorId       String
  operator         Operator      @relation(fields: [operatorId], references: [id])
  customerId       String
  customer         User          @relation(fields: [customerId], references: [id])
  score            Int
  comment          String?
  createdAt        DateTime      @default(now())

  @@index([operatorId])
}
```

`rescueRequestId` is `@unique` — one rating per completed job, and it
doubles as the natural guard against double-submission from WhatsApp.
`score` is a plain `Int` (1-5), validated at the application layer, not a
DB-level constraint (consistent with how `quotedPrice`/other numeric
fields are validated elsewhere in this codebase).

Additive migration; no backfill needed.

## WhatsApp flow — collection

### New session state

`WhatsAppFlowState` gains `WAITING_FOR_RATING`, added after
`WAITING_FOR_QUOTE_SELECTION` (same enum region as the other
motorist-facing waiting states).

### `handleBalancePaymentConfirmed` change

Currently this method sends the "payment confirmed" WhatsApp message and
immediately clears the customer session to `IDLE`. It changes to:

1. Send the existing "payment confirmed" message, unchanged.
2. Send a new rating-prompt message: `"How was your experience with
   {operator.businessName}? Reply with a number from 1 to 5 to rate
   them."`
3. Set the customer session state to `WAITING_FOR_RATING` (instead of
   `IDLE`), retaining `rescueRequestId` in the session so the eventual
   reply can be tied back to the right job.

### New handler branch

In the WhatsApp message router, a new branch for `session.state ===
WhatsAppFlowState.WAITING_FOR_RATING`:

- If the message parses as an integer 1-5: create the `Rating` row
  (`score` only, `comment` stays null), reply with a thank-you message
  containing the feedback link (`https://lrr.ninelm.com/feedback/{ratingId}`),
  clear the session to `IDLE`.
- If the message doesn't parse as 1-5: re-prompt ("Please reply with a
  number from 1 to 5.") without creating a row or changing state.
- If the motorist sends SOS instead of rating: the existing SOS handling
  takes over and starts a new request, exactly as it already does from any
  other non-terminal state — no special-case skip logic needed for
  `WAITING_FOR_RATING`. (The plan's implementer should confirm this by
  reading the top of `handleIncomingWhatsAppMessage` rather than assuming
  — flagged here as a "verify, don't assume" item.)

The feedback link is sent for every rating regardless of score — no
branching on the value.

## Feedback web page (`lrr-web`)

- New public route `app/feedback/[ratingId]/page.tsx` — no login, no
  portal chrome. Fetches the rating via a public backend endpoint (below),
  shows the operator's business name and the score already given, plus a
  textarea + submit button for the optional comment.
- The rating's own `id` (an unguessable `cuid()`) is the only access
  control — no separate token field, consistent with how `RequestMedia`
  links already work (`MediaController`'s `/media/:mediaId` route is fully
  public, gated only by the media row's own unguessable ID — same
  pattern).

## Backend API (`lrr-service`)

New `RatingController` (`/api/v1/ratings`), unguarded (no `@UseGuards`),
following the exact pattern of the existing `MediaController`:

- `GET /ratings/:id` — public. Returns `{ operatorBusinessName, score,
  comment }` for the feedback page to render. 404 if the ID doesn't exist.
- `PATCH /ratings/:id` — public. Body: `{ comment: string }`. Overwrites
  `comment` on the rating (re-submission replaces the previous value, no
  history kept). 404 if the ID doesn't exist.

New `RatingService` methods used by both the WhatsApp flow above and this
controller: `create({ rescueRequestId, operatorId, customerId, score })`,
`findById(id)`, `updateComment(id, comment)`.

## Display

### Operator portal

Extend the existing `GET /operators/:id/stats` endpoint (admin- and
operator-guarded, already exists) with `averageRating: number | null` and
`ratingCount: number`, computed via a Prisma aggregate on `Rating` scoped
to `operatorId`. The operator's own dashboard (`OverviewTabOperator.tsx`)
gets a small "Ratings" section: the average, the count, and the most
recent few ratings (score + comment where present, no customer PII beyond
what's already shown elsewhere in that view).

### Admin portal

Same `averageRating`/`ratingCount` fields, surfaced in the admin
`OperatorsTab.tsx` list (a new column) and/or operator detail — exact
placement decided at plan-writing time by following the existing table's
column conventions.

## Testing

- Backend: unit tests on the new `WAITING_FOR_RATING` handler branch
  (valid score creates a row and sends the link; invalid input re-prompts
  without creating a row; the session-state transition itself), and on
  `RatingService`'s aggregate (`averageRating`/`ratingCount` computed
  correctly, `null`/`0` when an operator has zero ratings).
- Frontend: manual verification (no dedicated test infra for pages/modals
  in this codebase today, consistent with existing components).

## Rollout

Additive migration (new `Rating` table only). No new env vars — the
feedback link's base URL should reuse whatever the codebase already uses
for its public web origin (verify the exact env var name at plan-writing
time — `lrr-web`'s `.env.example` references `lrr.ninelm.com` as the
production domain, but the exact server-side env var isn't yet confirmed
against the current `.env` files).
