# Durable Scheduling — Design

**Date:** 2026-09-12
**Status:** Approved, not yet implemented

## Problem

Every scheduled job in the service is an in-memory `setTimeout`. Nothing is
written down, so a deploy, a restart or an ECS task recycle silently discards
every pending job, and there is no record from which to recover them.

Seven job types are affected, across eight call sites — batch resolve is
scheduled from two places, normal dispatch and the admin "offer to this
operator" path, and both must be replaced:

| Job | Delay | What it does |
|---|---|---|
| Deposit reminders | 5 / 15 / 25 min | Nudge the motorist to pay |
| Deposit window expiry | 30 min | Cancel, release the operator, notify both |
| Bidding close | dispatch window | Send the motorist their quote shortlist |
| Batch resolve | offer window | Shortlist, or start the next dispatch round |
| Quote-selection timeout | selection window | Cancel, notify |
| Rating timeout | 10 min | Clear the session back to IDLE |
| Stalled-confirmation alert | 30 min | Alert staff that a job is unconfirmed |

Consequences today: a motorist can wait forever for a shortlist that will never
arrive; a request sits in `WAITING_FOR_DEPOSIT` indefinitely, holding an
operator who is never told the job died; staff are never alerted to a stalled
job. The motorist cannot start a fresh request either, because the duplicate-SOS
guard sees the stuck one as active.

Deployments now happen on every merge to `main`, so this fires routinely.

## Principle: derive what can be read, schedule only what must act

The test is whether anyone is reading at the moment the deadline passes.

**Derivable — needs no background work.** "Is this offer still open?" is answered
by a query that asks the real question (`expiresAt` in the future, and the
request not ended). Writing a `TIMED_OUT` status is bookkeeping, not
correctness. Materialising this kind of state is what caused the
2026-09-12 bug where finished jobs appeared in an operator's open-job list:
the query trusted a stored status instead of asking.

**Not derivable — must be scheduled.** A WhatsApp message cannot be derived. A
deposit reminder fires precisely because the motorist has gone quiet, so no
request arrives to trigger a lazy evaluation. Something must wake up and act
with nobody asking.

This splits them: the **rating timeout is pure cleanup with no outbound
message**, so it becomes derived state and needs no scheduling at all. The
other six produce outbound actions and need a runner.

## Approach

A single `ReconcilerService` wakes every **15 seconds** and runs a set of
independent checks. Each check is one query plus an action.

It **absorbs the existing `DispatchOfferSweeperService`**, which is already a
reconciler of this shape. One loop, one interval, one place to look.

### Why 15 seconds

Polling cost is dominated not by frequency but by whether we poll at all: Neon
suspends an idle compute after five minutes, so any interval under that keeps
the database permanently awake. The offer sweeper already polls every 60
seconds, so the database never sleeps today; moving to 15s adds a handful of
small indexed queries to a compute bill already being paid.

15 seconds makes the only user-visible latency — the wait for a quote shortlist
after the last operator bids — short enough that nobody notices, which removes
any need for a second, "instant" mechanism alongside the reconciler.

### The core property: the query is the guard

Each check matches only rows where the work is still outstanding, and acting
moves the row out of that match. "Still `WAITING_FOR_DEPOSIT` and past the
deadline" cannot fire twice, because cancelling changes the status.

This holds only if the claim and the domain changes that must accompany it
commit together — see Failure handling. A claim committed on its own moves the
row out of the match while leaving the work unfinished, which is worse than not
claiming at all, because nothing will ever match it again.

There are no locks, no leases and no job state to reconcile. A consequence
worth having: this is safe if the service ever runs more than one ECS task.
Two instances racing both attempt the conditional update; one matches a row,
the other matches zero and does nothing. Today's in-memory timers would
double-send.

### Alternatives rejected

**A generic `ScheduledJob` table** (`{type, runAt, payload, attempts}`) with a
claiming runner. Rejected because a job row is a second copy of the truth and
goes stale: a row saying "cancel request X at 2:45" cannot be trusted at 2:45,
because X may already be paid, cancelled or disputed. Every handler would have
to re-ask the domain question anyway — so we would write this design's query
*plus* maintain a job table, claiming and leases. Divergence between two
sources of truth is the bug class this service has just spent a day fixing. It
becomes the right answer when job types proliferate or need retry/backoff;
there are six, and they are stable. Migrating to it later is additive, not a
rewrite.

**External scheduling** (EventBridge Scheduler, SQS delay queues). Precise and
durable, but new infrastructure, new IAM, a new failure domain — and the
handler still re-checks domain state on arrival. Operationally disproportionate
for six jobs on a single task.

## Schema

Five new deadline columns on `RescueRequest`, plus two moved onto it. No new
tables.

| Column | Type | Set when |
|---|---|---|
| `depositWindowExpiresAt` | `DateTime?` | deposit link sent |
| `depositRemindersSent` | `Int @default(0)` | set to the number of marks due as each goes out |
| `biddingClosedAt` | `DateTime?` | bidding closed |
| `quoteSelectionExpiresAt` | `DateTime?` | shortlist sent |
| `confirmationDueAt` | `DateTime?` | operator sends DONE |

**Moved from `WhatsAppSession` to `RescueRequest`:**

| Column | Type | Why it moves |
|---|---|---|
| `dispatchRound` | `Int @default(0)` | the compare-and-swap target for phase-1 progression |
| `offeredOperatorIds` | `String[] @default([])` | belongs with the round it qualifies |

This move is required, not cosmetic. Phase-1 progression must be claimed with a
conditional update on the request, and there is nothing on the request to swap
against while the counter lives on the session.

It also fixes a latent bug of its own: `WhatsAppSessionStore.clear()` deletes
the session row outright, so today a cleared session destroys the dispatch
round count and the already-offered list. Admin cancel clears sessions. Any
re-dispatch afterwards restarts from round zero and re-offers operators who
were already asked — which the dispatch code explicitly warns against, having
been burned by a re-offer loop on staging in August. Dispatch progression is
request state; it should never have depended on a WhatsApp session that other
flows are entitled to delete.

`offeredOperatorIds` moves alongside it because the two are read and written
together on every round; splitting them across two stores would leave a round
counter on one row and its operator list on another.

**One new column on `DispatchOffer`:**

| Column | Type | Why |
|---|---|---|
| `dispatchRound` | `Int` — required, **no default** | the round this offer was made in |

A batch must be able to prove which round it belongs to, and today it cannot:
`batchId` is a `crypto.randomUUID()` carrying no ordering, and inferring a
round from `offeredAt` breaks precisely when radius expansion fires two rounds
in quick succession. Without this, a late-resolving batch cannot tell whether
it is still the current round — see Ownership.

**`-1` is a migration device, not a schema default.** The migration writes it
into legacy rows and then drops the default, so the column ends up required
with no default at all:

```sql
ALTER TABLE "DispatchOffer" ADD COLUMN "dispatchRound" INTEGER NOT NULL DEFAULT -1;
ALTER TABLE "DispatchOffer" ALTER COLUMN "dispatchRound" DROP DEFAULT;
```

This gets three things at once.

**Migration safety.** `DispatchOffer` already has rows, and adding a `NOT NULL`
column with no default fails on a non-empty table. Prod is empty so it would
apply there, and the integration harness builds its schema on a fresh empty
database — so **CI cannot catch this class of failure at all**. The migration
would pass in CI, pass in prod, and fail only on staging.

**Legacy rows stay inert.** `0` would be the wrong value to leave behind:
rounds start at zero, so a pre-existing offer holding `0` could satisfy
`dispatchRound = batchRound` against a request still on round 0 and trigger a
spurious dispatch round — the stale-batch bug, arrived at through the migration
instead. `-1` is not a round any request can occupy, so those rows match
nothing.

**New rows must be explicit.** With no default on the column, Prisma's generated
create types make `dispatchRound` required, so a code path that forgets to
supply it fails to compile rather than silently inserting an offer that can
never progress its round. An offer an operator receives but which can never
advance dispatch is not a safe failure — it is a quiet one.

Note that `prisma migrate dev` will generate the unsafe single-statement form
from a schema with no default. **The migration SQL must be hand-edited** to add
the default and drop it, exactly as above.

`RescueRequest.quoteCollectionDeadline` and `DispatchOffer.expiresAt` already
exist and are unchanged. Each new deadline column gets an index; at current
volumes it is immaterial, but it costs nothing and will not need revisiting.

The three reminder marks are **derived from the expiry**, not stored: they are
25, 15 and 5 minutes before `depositWindowExpiresAt`. That is also what the
message says ("you have N minutes left"), so the schedule and the copy cannot
drift apart.

## The checks

| Check | Matches | Claim | Action |
|---|---|---|---|
| Deposit reminder | `status = WAITING_FOR_DEPOSIT`, `depositWindowExpiresAt > now`, `depositRemindersSent < dueCount` | set counter **to** `dueCount` | WhatsApp to motorist (the `dueCount`-th only) |
| Deposit expiry | `status = WAITING_FOR_DEPOSIT`, past `depositWindowExpiresAt` | status → `CANCELLED` | notify motorist and operator, release offer |
| Bidding close | past `quoteCollectionDeadline`, `biddingClosedAt` null, still dispatching | stamp `biddingClosedAt` | close offers, send shortlist |
| Batch resolve | batch's offers PENDING and expired | offers → `TIMED_OUT`; to progress, also CAS `quoteCollectionDeadline IS NULL` and `dispatchRound = batchRound` | shortlist, or next round — only if the CAS matched |
| Quote-selection timeout | past `quoteSelectionExpiresAt`, still dispatching | status → `CANCELLED` | notify motorist and quoting operators |
| Stalled confirmation | past `confirmationDueAt`, not disputed, not ended | clear `confirmationDueAt` | staff alert |
| Offer sweeps | expired, or on an ended request | status → `TIMED_OUT` | none |

`biddingClosedAt` is a separate column rather than nulling
`quoteCollectionDeadline`, so the deadline survives for display and debugging.

### Ownership: who may progress a request

Bidding close and batch resolve can both reach "send the shortlist", so
"still dispatching" is not a sufficient guard on its own. Today they are kept
apart by in-memory state — a `closedRequests` set and a timer map — both of
which this design deletes. The rule must become explicit and persistent.

**The rule follows the existing two-phase dispatch semantics:**

- **Phase 1 — `quoteCollectionDeadline` is null.** No quote has arrived yet.
  Batch resolve owns progression: it expires its own batch and then either
  sends a shortlist (if quotes did arrive) or starts the next round with an
  expanded radius.
- **Phase 2 — `quoteCollectionDeadline` is set.** A quote has arrived and the
  request is converging on one request-wide deadline. **Bidding close owns
  progression exclusively.** Batch resolve may only expire its own offers, and
  must not send a shortlist or start a round.

The current code already enforces half of this: `resolveBatch` returns without
starting a new round once `quoteCollectionDeadline` is set. The gap is the
shortlist branch, which sits above that check and can still fire in phase 2 —
harmless today only because the in-memory set suppresses it.

**`biddingClosedAt` is the backstop.** Any check that progresses a request past
bidding must first claim it by stamping `biddingClosedAt` with a conditional
update requiring it to be null. Only one claim can succeed, so even if the
phase rule above is misread or a new caller is added later, a request can be
progressed exactly once. The phase rule expresses intent; the claim enforces
it.

**Reading the phase is not enough — it must be claimed.** `biddingClosedAt`
covers the shortlist path, but starting a *round* never stamps it, so phase-1
progression needs its own claim. Otherwise:

1. Batch resolve reads `quoteCollectionDeadline = null`.
2. An operator submits the first quote; `quoteCollectionDeadline` is set.
3. Batch resolve, acting on its stale read, starts another round — dispatching
   to more operators after the request has already converged on a deadline.

So **phase-1 progression is claimed, inside the transaction, with a conditional
update requiring `quoteCollectionDeadline IS NULL` and `dispatchRound` equal to
the resolving batch's own round**, advancing it by one. If zero rows match — a
quote landed first, another resolver won, or this batch is stale — batch
resolve stops after expiring its own offers and does nothing else.

**The round in that condition is the batch's, not the request's current one.**
Swapping on whatever round the request happens to be on lets a straggler
advance dispatch on behalf of a round that already finished:

1. Round 1's batch resolves late — a slow tick, a retry, a restart.
2. The request has since moved to round 2, still with no quotes.
3. The straggler reads `dispatchRound = 2`, swaps 2 → 3, and starts round 3
   while round 2's offers are still live and unanswered.

Requiring `dispatchRound = batchRound` makes that impossible: the stale batch
matches nothing and stops. Only the batch belonging to the current round can
advance it.

This is why `DispatchOffer.dispatchRound` exists (see Schema) — the batch must
carry its own round, since `batchId` is a random UUID that cannot establish
one.

The compare-and-swap needs the counter *on the request*, which is why
`dispatchRound` and `offeredOperatorIds` move there from the WhatsApp session.
Advancing the counter is what makes the claim exclusive: two batches resolving
concurrently cannot both match the same observed value.

The quote-selection timeout moves its trigger from the WhatsApp session to a
request column, removing a second piece of cross-entity state that could go
stale.

## Failure handling

**Semantics: state transitions exactly once, notifications at most once.**

The crucial distinction is between the two things a check does after it
matches. They must not be treated alike:

1. **Required domain changes** — the claim itself *and* every write that must be
   consistent with it: releasing the held offer, closing the request's offers,
   creating the next round's offer rows. These run **inside a single
   transaction**. Either all of them commit or none do.
2. **Outbound notifications** — WhatsApp messages, staff alerts. These happen
   **only after that transaction commits**, best-effort, and a failure is
   reported to Sentry rather than retried.

Splitting the transaction at the claim would be a real defect, not a
trade-off. If deposit expiry set `status = CANCELLED` and the process died
before releasing the held offer, the next tick would look for
`status = WAITING_FOR_DEPOSIT`, find nothing, and never revisit it. The request
would be cancelled with its offer stuck in `SELECTED_PENDING_PAYMENT` forever —
and the offer sweep would not rescue it either, since that only matches
`PENDING`. Inconsistent state that no check can ever see again is precisely
what this design exists to prevent. A crash mid-transaction instead rolls back,
the row still matches, and the next tick retries cleanly.

Losing a *notification* after a committed transaction remains acceptable: the
domain is consistent, only a message is missing. Sending before claiming would
risk duplicate payment nudges on a crash, which is worse than a missed one, and
at-least-once delivery would need an outbox table — disproportionate for six
notification types.

One consequence worth naming: for batch resolve, "start the next round" creates
offer rows inside the transaction but sends those offers afterwards. If the
sends fail, operators hold offers they were never told about. Those offers
expire normally and the reconciler moves to the next round, so the system
self-heals at the cost of one wasted round. Per-operator send failures are
already tolerated this way today.

Each check is independently wrapped, so one failing query cannot stop the
others. A `running` flag skips a tick while the previous one is still in
flight, so a slow database cannot pile ticks up.

## Catch-up after downtime

A naive implementation sends a burst of backdated messages on restart. The
rules:

- **Reminders: send only the most recent due reminder.** A request 26 minutes
  into its window after a 40-minute outage receives one message, not three.

  This is true **by construction**, not by careful coding. The claim computes
  `dueCount` from the clock and writes
  `SET depositRemindersSent = dueCount WHERE depositRemindersSent < dueCount`,
  setting the counter rather than incrementing it. Fast-forward is inherent:
  the row jumps straight to the current mark, so the skipped marks can never
  become due again. The same statement is what makes it multi-instance safe —
  a second instance finds `depositRemindersSent` already at `dueCount` and
  matches nothing. An increment would need a separate loop-or-skip rule for
  catch-up, and would be racy.

- **If the deposit window has already expired, skip reminders entirely** and go
  straight to cancellation. There is no sense nudging someone about a deadline
  that has passed.

  This belongs **in the predicate, not in prose**: the reminder check requires
  `depositWindowExpiresAt > now` alongside its other conditions. Stated only as
  a rule here, it is a rule an implementer can omit — and the result is
  specific and bad. Within one tick the reminder check runs before the expiry
  check, so after downtime a motorist would receive "you have 5 minutes left"
  and, seconds later, "your request was cancelled". Putting the condition in
  the match makes that sequence impossible rather than merely discouraged.

- Everything else acts once, simply late.

## Migration

**No backfill.** The product has no live users yet — production is deployed but
only staging testing runs against it — so there are no real in-flight requests
to rescue at cutover. The new deadline columns are added nullable, and any
request already in flight simply has no deadline and never fires. Leftover test
rows can be cancelled by hand or ignored.

**Every added column must be nullable, carry a default, or be given one for the
duration of the migration**, because staging has accumulated real rows even
though production is empty. A `NOT NULL` column with no default fails on a
non-empty table, and that failure would be invisible beforehand: the
integration harness migrates a freshly created empty database, so CI would go
green and only the staging deploy would break.

`RescueRequest.dispatchRound` defaults to `0` and `offeredOperatorIds` to `[]`,
which are correct starting values for a request that has not dispatched.
`DispatchOffer.dispatchRound` is the exception: it takes a temporary `-1`
default to populate legacy rows and then drops it, ending up required with no
default so future inserts must supply a round (see Schema).

Worth knowing as a standing gap, not just here: **CI cannot detect a migration
that only fails against existing data.** Until something migrates a
representative database, staging is the first place such a failure appears.

This deliberately avoids a backfill that would otherwise cancel overdue
requests on the first tick and send real messages to real people. Worth
revisiting only if this ships after launch, which is not the plan.

All eight timer call sites are deleted, including both batch-resolve entry
points. One mechanism, not two.

The catch-up rules above are unaffected: they govern ordinary downtime and
deploys once the reconciler is running, not this one-off cutover.

## Testing

Reconciler checks need no fake timers: insert a row with a deadline in the
past, run one tick, assert. Integration tests run against real Postgres using
the harness added on 2026-09-12.

Three tests per check:

1. It acts when the deadline has passed.
2. It does not act when the deadline has not passed.
3. **It does not act twice** — run the tick twice, assert one action. This is
   the test that proves the guard, and it cannot be written convincingly
   against a mocked database.

Plus one concurrency test: two ticks in parallel produce exactly one action,
verifying the multi-instance claim rather than asserting it.

Catch-up is covered explicitly, with two cases:

- A request with all three reminder marks overdue and none sent produces
  exactly one message.
- A request whose **window has already expired** and which has had no reminders
  produces **no reminder at all** — one tick cancels it and the motorist never
  receives a "minutes left" message for a deadline that had already passed.
  This fails against any implementation that keeps the skip-when-expired rule
  outside the reminder's match clause.

Three further tests cover the invariants that would otherwise regress silently:

- **Atomicity.** Force the transaction to fail partway (a rejected write inside
  it) and assert the claim rolled back — the request is still
  `WAITING_FOR_DEPOSIT` and its offer untouched — then run another tick and
  assert it completes cleanly. This proves a crash cannot strand a request in
  the half-cancelled state that no check can match.
- **Progression ownership.** With `quoteCollectionDeadline` set and both a
  due bidding close and a due batch resolve, assert exactly one shortlist is
  sent and `biddingClosedAt` is stamped once.
- **Phase 1 still progresses.** With `quoteCollectionDeadline` null and a due
  batch resolve, assert batch resolve does start the next round — so the
  ownership rule cannot be "fixed" by making batch resolve inert everywhere.
- **Stale phase read.** Start a batch resolve against a request with
  `quoteCollectionDeadline` null; before it claims, set the deadline as a
  concurrent first quote would; then let it proceed. Assert it expires its own
  batch and starts **no** new round, and that `dispatchRound` is unchanged.
  This is the exact interleaving a plain read-then-act would get wrong, and it
  fails against any implementation that checks the phase outside the claim.
- **Stale batch.** A request on `dispatchRound = 2` with `quoteCollectionDeadline`
  still null, and a round-1 batch only now resolving. Assert it expires its own
  offers and does **not** advance to round 3 — `dispatchRound` stays at 2 and
  no new offers are created. This fails against any implementation that swaps
  on the request's current round rather than the batch's own.

## Out of scope

`RescueRequest` carries 34 columns and this design adds five deadline columns
plus two moved from the session. The
underlying issue is real but separate: customer money is modelled as columns
(deposit, balance, refund) while operator money has its own `Payout` table —
the same concept in two shapes. `disputeOriginalBalanceAmount` exists to
remember a value that was overwritten, which is what happens when a new row
should have been written instead.

The defensible refactor is a `Payment` table, not a quote table — quotes
already have one in `DispatchOffer`, which carries `quotedPrice` and its own
status flow.

It is deliberately not bundled here. A payments refactor moves money paths with
live transactions in flight and needs its own migration and backfill plan;
bundling produces one large risky change instead of two reviewable ones. These
deadline columns are 1:1 with the request's current phase, so if `Payment` is
extracted later, `depositWindowExpiresAt` moves onto the deposit row and the
reconciler's query changes table but not shape.
