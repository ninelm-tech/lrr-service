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
guaranteeing only one round was ever live. (Keying by `expiresAt` alone is not
enough either, once phase 2 rewrites it — see change 2.)

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

### 6. Quoting or declining doesn't check the offer's own deadline

`respondToOffer` checks only `status === 'PENDING'`; `processQuoteOrDecline`
then writes unconditionally. Neither reads `expiresAt`. There's a real window —
between an offer's deadline passing and something marking it `TIMED_OUT` —
where a "PENDING but actually expired" offer can still be quoted. Once
`expiresAt` becomes the single authority (change 4), this stops being a
cosmetic gap: a late quote accepted here is exactly what would restart phase 2
or reorder a shortlist.

### 7. `notifyPendingOperatorsOfCountdown` sends freeform

It targets operators who haven't replied yet — precisely the ones least likely
to have an open 24-hour WhatsApp session, the same reason dispatch offers
needed a Content Template in the first place
(`2026-08-19-dispatch-offer-template-design.md`). A freeform send here will hit
Twilio 63016 in production for exactly the operators it's meant to reach.

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
> **Change 2 (a stable per-batch `batchId`, not `rescueRequestId` or
> `expiresAt`) is what makes this deletion safe.** The two are a pair. If
> anyone restores `supersedeActiveRound` — or adds any other blanket
> `PENDING → TIMED_OUT` sweep scoped to a whole request — the original bug
> returns along with the collision it was papering over.
>
> If a stale-timer symptom reappears, the fix is in the timer keys, never in
> cancelling offers. In phase 1 an offer ends exactly two ways: the operator
> answers, or `expiresAt` passes. Phase 2 adds exactly one more: the
> request-level quote-collection deadline.

### 2. Give each batch a stable identity separate from `expiresAt`

`batchTimers` is keyed `` `${rescueRequestId}:${expiresAt.getTime()}` `` instead
of `rescueRequestId`, and `maybeResolveBatchEarly` finds "this batch" by
querying every offer sharing that `expiresAt`.

**That collides with change 4.** Once the first quote arrives, `expiresAt` gets
rewritten on every still-pending offer to the new deadline — but the offer that
already quoted keeps its *original* `expiresAt`, untouched. The batch no longer
shares one `expiresAt` value, so keying and finding a batch by it breaks exactly
when phase 2 starts.

`expiresAt` is the offer's *deadline*. It must stop also being the batch's
*identity*. Add a `batchId` (a UUID generated when the batch is created) to
`DispatchOffer`, stamped on every offer in that batch. `batchTimers` keys on
`` `${rescueRequestId}:${batchId}` ``; `maybeResolveBatchEarly` and
`resolveBatch` look offers up by `batchId`, never by `expiresAt`. `expiresAt`
goes back to meaning only "when does this offer stop being answerable" —
exactly the meaning change 4 needs it to have.

### 3. Stop re-offering the same job to the same operator

Delete the `offeredOperatorIds: []` reset in the no-candidates path. **This
single deletion is what breaks the loop.**

`resolveBatch`'s tail call into `startDispatch` **stays, but only in phase 1** —
it is how untried operators get reached. Without the reset feeding it
already-asked operators, it reaches genuinely new people each round; when the
local pool is exhausted, `startDispatch`'s no-candidates path expands the
radius on the retry timer.

**Once `quoteCollectionDeadline` is set, automatic continuation must stop —
but admin-initiated additions must not.** These are different things and need
different guards. `startDispatch`'s auto-retry tail (`resolveBatch` → itself,
and the `DISPATCH_RETRY_MINUTES` timer) checks `quoteCollectionDeadline` and
no-ops if it's set — those are the paths phase 1 owns, and phase 2 taking over
means phase 1 goes quiet. `expandRadiusNow` and `manualOfferToOperator` do
**not** carry that check; they remain callable through the end of phase 2,
clamped per change 4.

Guarding this at a single chokepoint (e.g. an early return inside
`startDispatch` itself) would be wrong — it would also block the admin paths,
which call into the same offer-creation code but must keep working until the
deadline. The two call sites need to diverge in behaviour after the deadline is
set even though they currently share machinery.

`MAX_ROUNDS_BEFORE_AUTO_CANCEL` **stays** as phase 1's terminal condition —
irrelevant once phase 2 starts, since automatic continuation has already
stopped. With the reset gone and the radius growing each round, nothing else
stops a phase-1 request no operator will ever take; the cap ends it with an
admin alert and a cancellation.

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

The alternative — leaving `expiresAt` alone and deriving
`min(offer.expiresAt, request.quoteCollectionDeadline)` at every read — was
rejected because it creates two competing sources of truth. `expiresAt` is
already consulted by the offer lookup in `WhatsAppOperatorFlowService`, by
`listMyPendingOffers`, and by `DispatchOfferSweeperService`; each would need the
join and the clamp, and any one that forgot would quietly accept a bid after
bidding closed. Rewriting the column keeps `expiresAt` the single authority
everywhere. (`expiresAt` no longer doubles as batch identity — see change 2 —
so rewriting it here is now safe: nothing else depends on it staying original.)

The original batch window is not needed after the transition, so nothing is lost
by overwriting it.

**Offers created during phase 2 must be clamped at creation, and re-checked
against the deadline that exists at write time — not the deadline read at the
start of the request.** `expandRadiusNow` and `manualOfferToOperator` both read
candidates, which takes real time; a first quote can land, and phase 2 can
start, in the gap between that read and the `dispatchOffer.create` call. An
offer created after that point using the full window would escape the earlier
rewrite entirely and outlive the deadline it was supposed to be clamped to.

The fix is to compute the offer's `expiresAt` from a deadline read
**immediately before the write**, not from a value captured earlier in the
function:

```ts
const deadline = (await this.prisma.rescueRequest.findUnique({
  where: { id: rescueRequestId }, select: { quoteCollectionDeadline: true },
}))?.quoteCollectionDeadline;
const offerExpiresAt = deadline ? new Date(Math.min(now + windowMs, deadline.getTime())) : new Date(now + windowMs);
```

This must be tested explicitly: expand reads "no deadline yet", a quote sets the
deadline, expand's `dispatchOffer.create` runs after — the created offer must
still come out clamped.

**Operators must be told.** Still-pending operators get the countdown notice
(`notifyPendingOperatorsOfCountdown` already does this). Operators added during
phase 2 must see the *true* remaining time in their offer message, not the
configured window — the message says "You have N minutes to respond" and it must
not lie.

`scheduleGraceResolve` and `QUOTE_GRACE_MS` are replaced by this mechanism.

**The countdown notice must use the same template pattern as the dispatch offer
itself, not a freeform send.** `notifyPendingOperatorsOfCountdown` currently
calls `sendWhatsAppMessage` (freeform) unconditionally. The whole reason
dispatch offers went through a Content Template
(`2026-08-19-dispatch-offer-template-design.md`) is that a silent operator may
have no open 24-hour WhatsApp session — and the operators this notice targets
are, by definition, exactly the ones who haven't replied yet. A freeform send to
them will hit the same 63016 the dispatch offer template was built to avoid.
Add `TWILIO_QUOTE_COUNTDOWN_TEMPLATE_SID`, env-gated with the same
freeform-fallback pattern as the existing templates.

### 5. Enforce `expiresAt` on the quote/decline transition itself, atomically

Once change 4 makes `expiresAt` the single authority for whether an offer is
still answerable, it has to actually be *enforced* at the one place that
matters: the moment an operator tries to quote or decline.

Today it isn't. `respondToOffer` (the dashboard path) checks only
`status === 'PENDING'`. `processQuoteOrDecline` (the shared core used by both
WhatsApp and the dashboard) then does an unconditional `update`. Nothing
checks `expiresAt` at all. There is a real gap between an offer's deadline
passing and something setting its status to `TIMED_OUT` — the batch timer, the
phase-2 close, or the sweeper — and inside that gap an operator can still quote
on an offer that has already expired. Under change 4 that's worse than a cosmetic
race: quoting late is exactly what starts phase 2 or reorders a shortlist, so
letting it through defeats the invariant the rest of this spec depends on.

The transition must be a conditional write, not a status check followed by an
unconditional update:

```ts
const claimed = await this.prisma.dispatchOffer.updateMany({
  where: { id: offer.id, status: 'PENDING', expiresAt: { gt: new Date() } },
  data:  { status: quotedPriceKobo === undefined ? 'DECLINED' : 'QUOTED', quotedPrice: quotedPriceKobo, respondedAt: new Date() },
});
if (claimed.count === 0) {
  return { quoted: false, message: `Sorry, that offer has expired.` };
}
```

`respondToOffer`'s pre-check stays as a fast, honest rejection for the common
case, but `processQuoteOrDecline` — the one place both channels funnel through —
is where the guarantee actually has to live.

### 6. Bidding closes at the deadline — or earlier, if nothing is left pending

**The deadline is a ceiling, not a mandatory wait.** If every offer on the
request has been answered (quoted or declined) before the deadline arrives,
send the shortlist immediately — don't make the motorist sit out the rest of
the window when there's nothing left to wait for. This is `maybeResolveBatchEarly`'s
existing behaviour and it must survive the redesign: today, three operators
responding in the first 40 seconds of a 5-minute window resolve the batch in
40 seconds, not 5 minutes. An earlier version of this spec regressed that by
having bidding close *only* on the fixed timer — fixed here.

Concretely: `maybeResolveBatchEarly` becomes request-scoped once phase 2
starts (checking all `PENDING` offers for the request, not one batch by
`batchId`), and fires the same close-and-send logic below whenever it finds
none pending. The `quoteCollectionDeadline` timer is the fallback for
"still-pending offers that never answer" — it does not gate the case where
everyone already has.

At whichever happens first — the deadline, or every offer answered — mark any
still-`PENDING` offers `TIMED_OUT`, rank every `QUOTED` offer for the request,
and send the shortlist.

A quote arriving after that point is marked `NOT_SELECTED` and the operator told
the job has moved to selection.

**This makes problem (5) unreachable** — no quote can land after the shortlist is
sent, so the ranking cannot change between send and reply. No frozen shortlist,
no re-sending, no window floor or cap is needed.

`handleQuoteSelected` still re-validates that the chosen offer is `QUOTED` and
belongs to this request before charging.

**`expandRadiusNow` and `manualOfferToOperator` must themselves refuse to run
once bidding has closed.** `RescueRequest.status` stays `DISPATCHING` when the
shortlist is sent — only the WhatsApp *session* moves to
`WAITING_FOR_QUOTE_SELECTION` — so their existing `status !== DISPATCHING`
guard does not catch this case; an admin could click Expand after the shortlist
has already gone out. Both methods need an explicit added check:
`quoteCollectionDeadline` is set and `now >= quoteCollectionDeadline`. This does
not require a new `RescueRequestStatus` value — checking the deadline directly
is sufficient and avoids adding a status this spec's model doesn't otherwise
need.

### 7. Configuration

Three dispatch numbers move onto `PlatformConfig`, beside the existing
`dispatchWindowMinutes`:

| Field | Default | Was |
|---|---|---|
| `dispatchWindowMinutes` | 10 | already there — the phase 1 batch window |
| `quoteCollectionMinutes` | 5 | hardcoded `QUOTE_GRACE_MS` |
| `dispatchBatchSize` | 3 | hardcoded `BATCH_SIZE` |

Defaults preserve today's behaviour exactly. The admin config screen in
`lrr-web` gains the two new fields.

`DISPATCH_RETRY_MINUTES`, `MAX_ROUNDS_BEFORE_AUTO_CANCEL`, and
`RADIUS_EXPANSION_KM` stay as env/constants — not because they shouldn't be
configurable eventually, but because nothing in this work needs them to be.

### 8. Delete the retry delay from automatic expansion — not just default it to 0

**Behaviour change, called out explicitly because it's a business rule, not a
bug fix.** The rule: 10 minutes with no quote → expand immediately, new
operators get a fresh full window. Today that isn't what happens when the local
candidate pool is exhausted. `resolveBatch`'s tail call into `startDispatch` is
immediate, but if `startDispatch` finds zero candidates at the current radius,
it doesn't expand on the spot — it schedules the retry timer for
`DISPATCH_RETRY_MINUTES` (default 5) and expands only when *that* fires. A
motorist can wait up to 15 minutes before the radius actually grows, not 10.
During those 5 minutes nobody is being given a chance to respond — it is pure
dead time added to a stranded motorist's wait for no benefit to anyone.

**Delete `retryTimers`, the `setTimeout`, and `DISPATCH_RETRY_MINUTES`
entirely — do not default the constant to `0`.** A knob that defaults to the
right value is still a knob: leaving it configurable invites someone to set it
back to `5` later — a plausible-looking "make dispatch less aggressive" change
that would silently reintroduce exactly this dead time, with no test failing
and no comment stopping them, because the config path would still work exactly
as designed. Removing the mechanism removes that failure mode. The rule becomes
unconditional and can't be dialed back to the wrong behaviour:

> A round resolving with no quotes and no untried operators at the current
> radius expands the radius and dispatches the next batch in the same tick.

Note for the implementer: `retryTimers` and `DISPATCH_RETRY_MINUTES` already
exist in code as of the earlier standalone fix (per-batch timer keys,
`offeredOperatorIds` reset removal) that shipped ahead of this spec. That fix
did not touch the delay itself — this change is what removes it.

### 9. Expand with almost no time left

**Decision (user, 2026-08-24): disable the Expand button in the dispatch board
when under 30 seconds remain on the quote-collection deadline.**

An offer nobody can answer wastes a WhatsApp message and teaches operators the
channel isn't worth reading.

This is deliberately a **UI-only** guard. Elsewhere in this codebase a UI-only
guard was rejected — `retryPayout` enforces its rule server-side because a
hidden button is not a safeguard when the consequence is paying an operator
twice. Here the consequence is one wasted offer, so a client-side check is
proportionate for MVP. If the endpoint is ever called directly with 5 seconds
left, the offer simply expires unanswered, which is already a normal outcome.

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
- **Early resolution still works in phase 2:** with a 5-minute deadline set,
  every outstanding offer answered at t=40s sends the shortlist at t=40s, not
  at the deadline. **This is the regression an earlier draft introduced and
  must not reappear** — the deadline is a ceiling on stragglers, not a floor
  on how fast the motorist can be told.
- **Config:** batch size and both windows are read from `PlatformConfig`; the
  defaults reproduce today's 10 / 5 / 3 behaviour.
- **Batch identity survives the `expiresAt` rewrite:** after phase 2 shortens a
  batch's pending offers, `maybeResolveBatchEarly`/`resolveBatch` still resolve
  that batch correctly by `batchId` — this is the collision change 2 exists to
  prevent, and it must be exercised with a batch that has already been
  shortened, not only with a fresh one.
- **Automatic vs admin after the deadline is set:** once `quoteCollectionDeadline`
  exists, `resolveBatch`'s auto-continuation and the retry timer both no-op;
  `expandRadiusNow` and `manualOfferToOperator` still succeed (until the
  deadline itself passes — see below) and their offers come out clamped.
- **Expand-vs-first-quote race:** simulate a quote landing (setting the
  deadline) *between* an expand's candidate read and its `dispatchOffer.create`
  call — the created offer must still be clamped to the deadline, not the full
  window.
- **Quote/decline enforces expiry atomically:** an offer whose `expiresAt` has
  passed but whose status is still `PENDING` (the sweep-gap case) is rejected
  by `processQuoteOrDecline`, not silently accepted.
- **Countdown notice uses the template path:** with
  `TWILIO_QUOTE_COUNTDOWN_TEMPLATE_SID` set, `notifyPendingOperatorsOfCountdown`
  sends via the template, not freeform; unset falls back to freeform.
- **Expand/manual-assign refused after bidding closes:** once
  `now >= quoteCollectionDeadline`, both throw — even though
  `RescueRequest.status` is still `DISPATCHING`.
- **No retry delay:** a round resolving with no quotes and no remaining
  candidates at the current radius expands and dispatches on the same tick —
  no timer involved. `DISPATCH_RETRY_MINUTES` and `retryTimers` no longer
  exist in the code to regress back to.
