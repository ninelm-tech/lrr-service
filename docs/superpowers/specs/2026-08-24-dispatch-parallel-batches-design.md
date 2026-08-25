# Dispatch: Two-Phase Search and Quote Collection — Design

**Status:** Approved by user 2026-08-24.

**Goal:** Expanding the radius adds operators without destroying offers other
operators are still holding — and once bidding has started, nothing can push the
motorist's deadline further away.

## The model

Dispatch has two phases with different rules about time.

```
SEARCHING
  └─ each dispatched batch has its own independent window
  └─ no quote → expand and search again
        │
        │  first quote arrives
        ▼
COLLECTING_QUOTES
  └─ ONE request-level deadline, set at first-quote + QUOTE_COLLECTION_MS
  └─ every outstanding offer now effectively ends at that deadline
  └─ Expand may still add operators — they get only the REMAINING time
  └─ nothing extends or resets this deadline
        │
        │  deadline expires
        ▼
WAITING_FOR_QUOTE_SELECTION
  └─ bidding closed
  └─ rank all valid quotes, send the shortlist
```

### Phase 1 — SEARCHING

Every batch carries its own window, starting when that batch was sent. A batch
sent at t=0 with a 10-minute window expires at t=10; a batch sent at t=4 expires
at t=14. There is no request-level clock in this phase.

Nobody quotes by t=10 → the first batch is genuinely finished, the next batch of
untried operators goes out with a fresh full window, and the motorist is told the
search continues.

### Phase 2 — COLLECTING_QUOTES

**The first quote ends phase 1 for everyone.**

At that moment a single request-level deadline is set:
`quoteCollectionDeadline = now + QUOTE_COLLECTION_MS`. From then on it is the
only deadline that matters.

Operators who had 8 minutes left on their batch window **do not still have 8
minutes.** They have whatever remains of the quote-collection window. Operators
added by an expand at deadline-minus-one-minute get one minute, not a fresh
window of either length.

**The invariant, which is the entire point of this phase:**

> Once the first quote arrives, nothing — automatic expansion, an admin
> clicking Expand, a manual offer, or a newly created batch — can move the
> motorist's shortlist deadline later.

A stranded motorist's wait must not grow because operators kept arriving.

### Phase 3 — WAITING_FOR_QUOTE_SELECTION

At the deadline, bidding closes. All valid quotes are ranked and the shortlist is
sent, then the existing selection window runs unchanged.

A quote arriving after bidding closes is marked `NOT_SELECTED` and the operator
told the job has moved to selection — never silently added to a list the
motorist has already been shown.

## Worked example

```
t=0   SOS → A, B, C          offers expire t=10
t=2   A quotes               → quoteCollectionDeadline = t=7
                               B and C now effectively end at t=7, not t=10
                               B and C are told the countdown started
t=6   admin expands → D,E,F  offers expire t=7 (one minute, not a fresh window)
t=7   bidding closes         rank A's quote + any from B,C,D,E,F
                             shortlist sent to the motorist
```

## What's broken today

### 1. Expanding cancels offers that are still live

`expandRadiusNow` and `manualOfferToOperator` both call `supersedeActiveRound`,
which runs a blanket
`updateMany({ rescueRequestId, status: 'PENDING' } → 'TIMED_OUT')`. Operators
partway through their window lose an offer they were never given the chance to
answer.

### 2. The shared timer key is why (1) exists

`batchTimers` is keyed by `rescueRequestId`. With two batches in flight the
second overwrites the first's entry, and the orphaned timer fires `resolveBatch`
with the *old* batch's operator list. `supersedeActiveRound` avoided that by
guaranteeing only one round was ever live.

### 3. The same job is re-offered to the same operator forever

`resolveBatch` with no quotes calls `startDispatch`; `startDispatch` finds no
candidates because everyone is in `offeredOperatorIds`; the no-candidates branch
resets `offeredOperatorIds: []`, so the same operators become eligible again and
are offered the same job again, until `MAX_ROUNDS_BEFORE_AUTO_CANCEL`.

Observed on staging 2026-08-24: an operator received the same job repeatedly and
could quote on it again after it had apparently ended.

### 4. There is no request-level quote-collection deadline

`scheduleGraceResolve` is a partial version of phase 2 — it starts a
`QUOTE_GRACE_MS` (5 minute) timer on the first quote and even notifies the
still-pending operators that a countdown has begun. But it is not authoritative:
batch expiry still competes with it, resolution remains batch-scoped, and a
later batch can extend the motorist's wait past it.

### 5. A late quote can charge a motorist a price they didn't choose

`handleQuoteSelected` re-queries all `QUOTED` offers and re-runs `rankQuotes` at
reply time, ranking a *different list* than the one displayed. A quote landing
between send and reply shifts the ordering, so "2" resolves to a different
operator at a different price. Live today.

## The changes

### 1. Delete `supersedeActiveRound`

Remove the method and both call sites. `expandRadiusNow` and
`manualOfferToOperator` create their batch and leave existing offers alone.

Their `status !== DISPATCHING` guards become a check that the request is still
open — an admin acting on a request already at `WAITING_FOR_DEPOSIT` or
`COMPLETED` is still refused.

> **Do not reintroduce this. Read this before "fixing" a stale-timer bug.**
>
> `supersedeActiveRound` was not arbitrary — it solved a real problem. With
> `batchTimers` keyed by `rescueRequestId`, a second batch overwrote the first
> batch's timer entry; the orphaned timer would then fire and call
> `resolveBatch` with the *old* batch's operator list against the *new* batch's
> state. Cancelling all pending offers guaranteed only one round was ever live,
> making that collision impossible.
>
> It fixed the collision by destroying other operators' work. An operator two
> minutes into their window lost the offer because an admin clicked Expand —
> asked a question and never allowed to answer.
>
> **Change 2 (per-batch timer keys) is what makes this deletion safe.** The two
> are a pair. If anyone restores `supersedeActiveRound` — or adds any other
> blanket `PENDING → TIMED_OUT` sweep scoped to a whole request — the original
> bug returns along with the collision it was papering over.
>
> If a stale-timer symptom reappears, the fix is in the timer keys, never in
> cancelling offers. In phase 1 an offer ends exactly two ways: the operator
> answers, or `expiresAt` passes. Phase 2 adds exactly one more: the
> request-level quote-collection deadline.

### 2. Key `batchTimers` per batch

`` `${rescueRequestId}:${expiresAt.getTime()}` `` instead of `rescueRequestId`.
Each batch resolves its own operator set; a new round never disturbs an existing
one.

### 3. Stop re-offering the same job to the same operator

Delete the `offeredOperatorIds: []` reset in the no-candidates path. **This
single deletion is what breaks the loop.**

`resolveBatch`'s tail call into `startDispatch` **stays** — it is how untried
operators get reached. Without the reset feeding it already-asked operators, it
reaches genuinely new people each round; when the local pool is exhausted,
`startDispatch`'s no-candidates path expands the radius on the retry timer.

`MAX_ROUNDS_BEFORE_AUTO_CANCEL` **stays** as the terminal condition. With the
reset gone and the radius growing each round, nothing else stops a request no
operator will ever take. The cap ends it with an admin alert and a cancellation.

The coverage fast-fail (`COVERAGE_DELTA_DEG`, ~165 km) is unchanged.

### 4. Make the quote-collection deadline authoritative

Add `quoteCollectionDeadline DateTime?` to `RescueRequest`. Null means phase 1.

**Setting it must be atomic and once-only.** Two operators can quote
simultaneously; the second must not move the deadline:

```ts
const started = await this.prisma.rescueRequest.updateMany({
  where: { id: rescueRequestId, quoteCollectionDeadline: null },
  data:  { quoteCollectionDeadline: new Date(Date.now() + QUOTE_COLLECTION_MS) },
});
if (started.count > 0) {
  // this quote began phase 2 — schedule the close, notify pending operators
}
```

`updateMany` with a `null` condition, not read-then-write: the read-then-write
version lets two concurrent first quotes each set their own deadline, and the
later one wins — silently extending the motorist's wait, which is the exact
invariant this phase exists to protect.

**Applying it to offers: rewrite `expiresAt`.** On the transition, shorten every
still-pending offer:

```ts
await this.prisma.dispatchOffer.updateMany({
  where: { rescueRequestId, status: 'PENDING', expiresAt: { gt: deadline } },
  data:  { expiresAt: deadline },
});
```

and clamp new offers created during phase 2 to `min(now + window, deadline)`.

The alternative — leaving `expiresAt` alone and deriving
`min(offer.expiresAt, request.quoteCollectionDeadline)` at every read — was
rejected because it creates two competing sources of truth. `expiresAt` is
already consulted by the offer lookup in `WhatsAppOperatorFlowService`, by
`listMyPendingOffers`, and by `DispatchOfferSweeperService`; each would need the
join and the clamp, and any one that forgot would quietly accept a bid after
bidding closed. Rewriting the column keeps `expiresAt` the single authority
everywhere.

The original batch window is not needed after the transition, so nothing is lost
by overwriting it.

**Operators must be told.** Still-pending operators get the countdown notice
(`notifyPendingOperatorsOfCountdown` already does this). Operators added during
phase 2 must see the *true* remaining time in their offer message, not the
configured window — the message says "You have N minutes to respond" and it must
not lie.

`scheduleGraceResolve` and `QUOTE_GRACE_MS` are replaced by this mechanism.

### 5. Bidding closes at the deadline

At `quoteCollectionDeadline`: mark all still-`PENDING` offers `TIMED_OUT`, rank
every `QUOTED` offer for the request, and send the shortlist.

A quote arriving after that point is marked `NOT_SELECTED` and the operator told
the job has moved to selection.

**This makes problem (5) unreachable** — no quote can land after the shortlist is
sent, so the ranking cannot change between send and reply. No frozen shortlist,
no re-sending, no window floor or cap is needed.

`handleQuoteSelected` still re-validates that the chosen offer is `QUOTED` and
belongs to this request before charging.

## Open question

**A phase-2 expand with very little time left.** An admin expanding with 20
seconds remaining sends operators an offer they realistically cannot answer,
which trains them to ignore the channel. Options: refuse the expand below some
floor, warn the admin, or send anyway. Not decided; the invariant forbids
extending the deadline, so the only choices are "offer briefly" or "don't offer".

## Explicitly not doing

- **Extending the deadline for late-arriving operators.** The invariant.
- **Accumulating offers indefinitely / re-sent shortlists / frozen ranked lists.**
  Unnecessary once bidding closes at a fixed deadline.
- **Operator busy state, capacity, or a `Vehicle` entity.** Dropped 2026-08-24:
  the platform cannot know an operator's fleet size, so the operator decides by
  quoting or replying `NO`. See the comment on `findAndRankCandidates`.
- **Making dispatch durable across restarts.** Timers stay in-process and are
  lost on restart; `DispatchOfferSweeperService` (`1f7b0d3`) limits the damage.
  Note the quote-collection deadline is persisted on the row, so a restart loses
  the *timer* but not the *deadline* — recovery is possible later.
- **The 30-minute deposit window, reminders, and refunds** — separate spec.

## Testing

Unit tests here mock Prisma and assert call shapes rather than evaluate queries,
so they target observable decisions:

- **Expanding preserves live offers:** a `PENDING` offer with a future
  `expiresAt` is untouched by `expandRadiusNow` and by `manualOfferToOperator`.
- **Phase 1 independence:** a batch created at t=4 gets its own expiry while an
  existing batch keeps t=10 — no shared deadline before the first quote.
- **Phase 2 transition:** the first quote sets `quoteCollectionDeadline` and
  shortens every pending offer whose `expiresAt` is later than it.
- **Deadline is immovable:** a second quote does not move it; an expand during
  phase 2 does not move it; offers created during phase 2 are clamped to it.
  **This is the regression that matters most.**
- **Per-batch timers:** two batches in flight each resolve their own operator
  set; the second does not clobber the first.
- **No re-offering:** a round resolving with no quotes never produces a second
  offer row for an already-offered operator, while still reaching untried ones.
- **Termination:** with untried operators the search continues; with none at any
  radius it stops at the round cap, alerts, and cancels.
- **Bidding closes:** a quote arriving after the deadline is `NOT_SELECTED`, the
  operator is told, and the motorist's list is unchanged.
