# Rating Service — Design

## Background

No rating system exists anywhere in the codebase today. The PRD describes
motorists rating the tow operator after service completion, and operators
reviewing customer ratings in their earnings/history view — a two-way
relationship. The operator-quotes design explicitly dropped rating from
the shortlist's composite ranking score specifically because no rating
system existed. This spec is that feature.

Task 9 of the operator-quotes plan removed a dead "Reply 1-5 to rate your
operator" line from the balance-confirmation WhatsApp message, since no
handler for it existed. This spec adds the real handler — for **both**
directions: motorist rates operator, and operator rates motorist.

## Goal

After a job completes and the balance is paid, both parties are prompted
on WhatsApp to rate the other, 1-5. Each also receives a link to an
unauthenticated web page to optionally add free-text feedback tied to
their specific rating. Operators see their average rating (received from
motorists) in their own portal; admins see the same average per operator.
Ratings operators give motorists are collected and stored, but have no
display surface yet.

## Non-goals

- No reintegration into the shortlist's composite ranking formula.
- No display surface for operator→motorist ratings this pass (collection
  only — the data exists for whenever a "customer reputation" view is
  wanted later).
- No rating edit/expiry semantics beyond "one submission" — see "Feedback
  web page" below; a second `PATCH` attempt is rejected, not silently
  overwritten.
- No automated action on low ratings.
- No public display of ratings to motorists (e.g. shown on the shortlist).

## Data model changes (`prisma/schema.prisma`)

Motorist and operator are different entity types in this schema (`User`
vs. `Operator`), so a generic `reviewerId`/`revieweeId` pair doesn't fit
cleanly — a `direction` enum keeps both parties' IDs on every row instead:

```prisma
enum RatingDirection {
  MOTORIST_TO_OPERATOR
  OPERATOR_TO_MOTORIST
}

model Rating {
  id               String          @id @default(cuid())
  rescueRequestId  String
  rescueRequest    RescueRequest   @relation(fields: [rescueRequestId], references: [id])
  direction        RatingDirection
  operatorId       String
  operator         Operator        @relation(fields: [operatorId], references: [id])
  customerId       String
  customer         User            @relation(fields: [customerId], references: [id])
  score            Int
  comment          String?
  createdAt        DateTime        @default(now())

  @@unique([rescueRequestId, direction])
  @@index([operatorId])
  @@index([customerId])
}
```

`operatorId`/`customerId` always identify the same two parties of the job
regardless of direction — `direction` says who authored this particular
row. The unique constraint on `[rescueRequestId, direction]` allows up to
two rows per completed job (one each way) while still preventing either
party from rating twice. `RescueRequest` gets a `ratings Rating[]`
back-relation (one-to-many, not the one-to-one `Rating?` an earlier draft
of this spec used).

Additive migration; no backfill needed.

## WhatsApp flow — collection (both directions)

### New session state

`WhatsAppFlowState` gains `WAITING_FOR_RATING`, reused by both the
customer's and the operator's own session — the same state name, but each
party's session is independent, so this causes no collision.

### `handleBalancePaymentConfirmed` change

Currently sends the "payment confirmed" message to the customer and the
"release the vehicle" message to the operator, then clears both sessions
to `IDLE`. It changes to, for **each** party:

1. Send the existing message, unchanged.
2. Send a rating-prompt message asking them to rate the other party 1-5.
3. Set their session to `WAITING_FOR_RATING` (instead of `IDLE`), retaining
   `rescueRequestId`.
4. Schedule a 10-minute abandonment timeout (see below) — ratings don't
   block anything, so this is cleanup, not a hard deadline like deposit
   payment.

### Two router branches, one shared handler

**Customer side** (`handleIncomingWhatsAppMessage`): a `WAITING_FOR_RATING`
branch placed after the existing SOS/CANCEL checks (same section as
`WAITING_FOR_LOCATION`/`WAITING_FOR_QUOTE_SELECTION`) — SOS still
supersedes an abandoned rating prompt, exactly like it already supersedes
those other states.

**Operator side** (`handleOperatorMessage`): a `WAITING_FOR_RATING` branch
placed **before** the existing `if (/^\d+$/.test(message))` quote-parsing
check. That existing check treats *any* bare digit as a dispatch-offer
price quote, unconditionally — without this ordering, an operator's rating
reply would be silently swallowed as a bogus quote attempt. Gating strictly
on `session.state === WhatsAppFlowState.WAITING_FOR_RATING` and checking it
first resolves this; an operator only reaches that state right after a job
completes, when they have no live dispatch offer needing a quote.

Both branches call the same shared handler, parameterized by which
direction this reply represents (the caller already knows — customer-side
calls always mean `MOTORIST_TO_OPERATOR`, operator-side calls always mean
`OPERATOR_TO_MOTORIST`). Behavior:

- Valid 1-5 reply: create the `Rating` row for that direction, reply with a
  thank-you including the feedback link
  (`https://lrr.ninelm.com/feedback/{ratingId}`), clear that party's
  session to `IDLE`.
- Invalid input: re-prompt, no row created, state unchanged.

### Abandonment timeout

If the reply never comes, a 10-minute timer (scheduled when
`WAITING_FOR_RATING` is set) silently clears that party's session back to
`IDLE` — checking the session is still `WAITING_FOR_RATING` for the same
`rescueRequestId` before clearing, so it can't clobber a state the party
has since moved past (rated already, or started a fresh SOS). No message
sent on timeout — this is quiet cleanup, not a failure state.

**Accepted MVP limitation:** this timer is in-memory `setTimeout`, the same
pattern already used by this file's `batchTimers`/`graceTimers`. If the
service restarts, an abandoned `WAITING_FOR_RATING` session won't
auto-clear until that party sends another message — SOS still works
immediately regardless of a stuck rating state. No DB-backed scheduling is
being built to persist this timer across restarts; it's accepted as a
known limitation, not engineered around.

### Write ordering in the collection handler

The shared rating handler creates the `Rating` row **before** clearing the
reviewer's session to `IDLE`, not after. If `RatingService.create()` throws
(e.g. a transient DB error), the session must stay `WAITING_FOR_RATING` so
the reviewer's next message re-enters the handler and can retry — clearing
first would silently lose the rating while the session had already moved
on, with no way for the reviewer to know their score wasn't recorded.

## Feedback web page (`lrr-web`)

- New public route `app/feedback/[ratingId]/page.tsx` — no login. Fetches
  the rating via a public backend endpoint, shows who was rated and the
  score already given, plus a textarea + submit for the optional comment.
  Used by **both** directions — an operator's feedback link and a
  motorist's feedback link both land on the same page shape, differing
  only in the name/score shown.
- The rating's own `id` (an unguessable `cuid()`) is the only access
  control — same pattern as `MediaController`'s existing public
  `/media/:mediaId` route.
- **Single submission, not edit-in-place:** once `comment` is non-null, a
  further `PATCH` is rejected (`400`, "Feedback already submitted for this
  rating.") rather than silently overwriting the previous value. This
  corrects an earlier draft of this spec, which allowed unlimited
  overwrites.

## Backend API (`lrr-service`)

New `RatingController` (`/api/v1/ratings`), unguarded, following the exact
pattern of the existing `MediaController`:

- `GET /ratings/:id` — public. Returns `{ ratedName, score, comment }`
  (`ratedName` is the operator's business name for a
  `MOTORIST_TO_OPERATOR` row, or "the motorist" — no customer PII exposed —
  for an `OPERATOR_TO_MOTORIST` row). 404 if the ID doesn't exist.
- `PATCH /ratings/:id` — public. Body: `{ comment: string }`. Sets
  `comment` once; a second call on a row that already has a comment
  returns `400`. 404 if the ID doesn't exist.

New `RatingService` methods: `create({ rescueRequestId, direction,
operatorId, customerId, score })`, `findById(id)`, `setComment(id,
comment)` (renamed from `updateComment` to reflect the write-once
semantics).

## Display

### Operator portal

Extend the existing `GET /operators/:id/stats` endpoint with
`averageRating: number | null` and `ratingCount: number`, computed via a
Prisma aggregate on `Rating` scoped to `operatorId` **and**
`direction: MOTORIST_TO_OPERATOR` (excluding the ratings this operator
gave to motorists, which are a different thing entirely). The operator's
own dashboard gets a small "Ratings" section: average, count, and a few
recent ratings.

### Admin portal

Same `averageRating`/`ratingCount` fields (same `MOTORIST_TO_OPERATOR`
scoping), surfaced as a new column in the admin operators list.

## Testing

- Backend: unit tests on both `WAITING_FOR_RATING` handler branches
  (customer-side and operator-side — valid score creates the right-
  direction row and sends the link; invalid input re-prompts without
  creating a row), on the operator-side branch's placement relative to the
  quote-parsing check (a rating reply must not be treated as a quote), and
  on `RatingService`'s aggregate (correctly scoped to
  `MOTORIST_TO_OPERATOR` only, `null`/`0` for zero ratings).
- Frontend: manual verification, consistent with existing components.

## Rollout

Additive migration (new `Rating` table, new `RatingDirection` enum). No
new env vars — the feedback link's base URL reuses the existing
`FRONTEND_URL` env var (already used by `subscription.service.ts`).
