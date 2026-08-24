# Dispatch: Accumulating Offers — Design

**Status:** Approved by user 2026-08-24 (model + both open decisions).

**Goal:** One rescue request owns a growing set of offers. Expanding the radius,
retrying, and manually assigning all *add* operators to that set. Nothing an
admin or a later round does ever revokes an offer an operator is still holding.

## Background

Today the three ways of reaching operators behave differently, and two of them
actively cancel work already in flight.

`expandRadiusNow` and `manualOfferToOperator` both call `supersedeActiveRound`,
which does a blanket
`updateMany({ rescueRequestId, status: 'PENDING' } → 'TIMED_OUT')`. So "expand
the search" silently kills the offers held by the operators already asked, then
offers the job to different ones. That is the opposite of expanding.

Worse, the automatic path loops. `resolveBatch` with no quotes calls
`startDispatch` at the same radius; `startDispatch` finds no candidates because
everyone is in `offeredOperatorIds`; the no-candidates branch resets
`offeredOperatorIds: []`; the same operators become eligible again and are
re-offered the same job. This repeats until `MAX_ROUNDS_BEFORE_AUTO_CANCEL`.
Observed on staging 2026-08-24: an operator received the same job repeatedly and
could quote on it again after it had apparently ended.

The user's framing, which this design implements: *"expand radius should not
cancel the request sent to... It's the same request, same ID, but expand it to
three more people... All these should be the same thing."*

## Model

A request owns a set of `DispatchOffer` rows. Three operations add to it:

| Operation | How the operator ids are chosen |
|---|---|
| Automatic round | `findAndRankCandidates`, next N by rank at the current radius |
| Expand radius | same, with a larger radius |
| Manual assign | the admin names one, ignoring rank and distance entirely |

**An offer ends exactly two ways: the operator answers it, or its `expiresAt`
passes.** There is no third way. `supersedeActiveRound` is deleted.

### The shared primitive

```ts
private async offerToOperators(
  rescueRequestId: string,
  operatorIds: string[],
  windowMs: number,
): Promise<void>
```

Creates the offer rows with a shared `expiresAt`, sends the WhatsApp offer to
each (`Promise.allSettled`, per-operator Sentry capture — one failed send must
not block the batch), appends to `offeredOperatorIds`, and schedules that
batch's own resolution.

`startDispatch`, `expandRadiusNow`, and `manualOfferToOperator` all become
callers that differ only in how they choose `operatorIds` and the window they
pass. `manualOfferToOperator` keeps its shorter 5-minute window and keeps
re-throwing send failures — an admin needs to see that their action failed,
unlike the batch path.

## Offers accumulate; quotes accumulate

`QUOTED` offers stay `QUOTED` until selection. `sendQuoteShortlist` already
queries `{ rescueRequestId, status: 'QUOTED' }` rather than by batch, so a
shortlist spanning several rounds needs no change to that query.

`resolveBatch` stops driving the next round. Its only remaining job is to time
out the still-`PENDING` offers *of its own batch* and, if this batch produced
the request's first quote, start the selection window.

## Selection must become stable

**This is the highest-risk part of the change and the reason it is not a patch.**

`handleQuoteSelected` currently re-queries all `QUOTED` offers and re-runs
`rankQuotes` at the moment the motorist replies. It therefore ranks a
*different list* than the one they were shown. If any quote lands between the
shortlist being sent and the reply arriving, the ordering shifts and the
motorist is assigned an operator they did not choose, at a price they did not
agree to.

This bug exists today. It is currently rare because batches resolve together.
Accumulating offers makes late quotes normal, which would make it routine.

**Fix:** when a shortlist is sent, freeze the ranked offer IDs into the session:

```ts
await this.sessionStore.update(customerId, {
  state: WhatsAppFlowState.WAITING_FOR_QUOTE_SELECTION,
  shortlistOfferIds: ranked.map((q) => q.offerId),
});
```

`handleQuoteSelected` indexes into `shortlistOfferIds`, never into a fresh
re-rank. The number the motorist is looking at is always the number we honour.

Re-validate the chosen offer before charging: it must still be `QUOTED` and
belong to this request. An offer that expired or was withdrawn between send and
reply gets an honest "that quote is no longer available — here are the current
ones" rather than a silent substitution.

`shortlistOfferIds` is a new field on the WhatsApp session type.

### Late quotes re-send the list

**Decision (user, 2026-08-24): re-send the full updated list.** A motorist must
be able to see a cheaper quote that arrived late; holding it back means someone
pays more while a better offer sat unshown.

Each new quote arriving while the request is in `WAITING_FOR_QUOTE_SELECTION`
re-ranks, rewrites `shortlistOfferIds`, and re-sends — one step, so the frozen
list and the displayed list can never diverge. The message is marked as an
update rather than repeated verbatim, so it doesn't read as a duplicate.

### Selection window floor and cap

Re-sending a list to a motorist who has 20 seconds left is a trap, so a re-send
extends the window to at least `SELECTION_MIN_REMAINING_MS`. An absolute cap
measured from the *first* shortlist prevents a trickle of late quotes from
extending it indefinitely. Both are constants on `DispatchService` beside the
existing `QUOTE_SELECTION_WINDOW_MS`.

### Quotes arriving after selection

Once the request leaves `DISPATCHING`, a newly arriving quote is marked
`NOT_SELECTED` and the operator told plainly, rather than being left `QUOTED`
forever. `processQuoteOrDecline` gains that status check.

## When the search stops

**Decision (user, 2026-08-24): keep searching until the motorist has quotes,
then run the selection window.**

Automatic expansion continues while the request is `DISPATCHING` and candidates
remain, widening the radius each round. It stops only when no operator exists
at any radius — the genuine dead end, which alerts an admin.

Deleted: `MAX_ROUNDS_BEFORE_AUTO_CANCEL`, and the `offeredOperatorIds: []`
reset. Those two together are the perpetual-motion machine. Once an operator
has been asked, they have been asked; re-asking is what produced the duplicate
offers.

**Search keeps running during the selection window.** More quotes is the point
of accumulating, and the re-send path exists precisely to surface them.

The existing coverage fast-fail (`COVERAGE_DELTA_DEG`, ~165 km) is unchanged: no
active operator anywhere near the pin is a geography problem that expansion
cannot solve, so it still cancels immediately and alerts.

## Timers

`batchTimers` is currently a `Map` keyed by `rescueRequestId`. With one live
round per request that was adequate; with several batches in flight it is not —
a later batch overwrites an earlier batch's entry, and the earlier timer fires
untracked. That shared key is the actual reason `supersedeActiveRound` was
written.

Key per batch instead: `` `${rescueRequestId}:${expiresAt.getTime()}` ``. Then a
new round never disturbs an existing one and no offer needs cancelling to keep
the timers honest.

**These timers remain in-process and are still lost on restart.** The
`DispatchOfferSweeperService` added in `1f7b0d3` is the backstop that stops lost
timers stranding offers as `PENDING` forever. Making dispatch fully durable
(persisted round state, a scheduler) is explicitly out of scope here.

## What this deletes

Worth stating plainly, because each of these has a comment defending it:

- `supersedeActiveRound` and both its call sites
- `MAX_ROUNDS_BEFORE_AUTO_CANCEL` and the auto-cancel branch
- the `offeredOperatorIds: []` reset in the no-candidates path
- `resolveBatch`'s tail call into `startDispatch`
- the `status !== DISPATCHING` guards on `expandRadiusNow` /
  `manualOfferToOperator` become a check that the request is still open, not
  that it is mid-round

## Testing

The mocked unit tests in this codebase cannot catch ordering bugs of the kind
described under Selection, because they assert call shapes rather than evaluate
queries. Tests must therefore target the domain logic directly:

- **Selection stability:** given a frozen `shortlistOfferIds` and a *newer*
  cheaper quote in the database, selecting "2" resolves to the operator that was
  second **in the frozen list**, not second in a fresh re-rank. This is the
  regression that matters most.
- **Accumulation:** expanding the radius leaves every existing `PENDING` offer
  `PENDING`; a manual assign does the same.
- **No re-offering:** a full round with no quotes does not produce a second
  offer row for an operator already offered this request.
- **Late quote:** a quote arriving during `WAITING_FOR_QUOTE_SELECTION` rewrites
  `shortlistOfferIds` and re-sends; one arriving after selection is
  `NOT_SELECTED` and does not re-send.
- **Window:** a re-send with less than `SELECTION_MIN_REMAINING_MS` left extends
  the window; re-sends cannot push it past the absolute cap.
- **Timers:** two batches in flight for one request each resolve their own
  operator set.
- **Termination:** with candidates available the search keeps expanding; with
  none anywhere it fast-fails and alerts exactly once.

## Out of scope

- Making dispatch durable across restarts (persisted rounds / a real scheduler).
  The sweeper covers the damage; it does not remove the cause.
- Operator busy state, capacity, or a `Vehicle` entity. Deliberately dropped
  2026-08-24: the platform cannot know an operator's fleet size, so the operator
  decides by quoting or replying `NO`. See the comment on
  `findAndRankCandidates`.
- The 30-minute deposit window, its reminders, and refunds for late payment —
  a separate spec, tracked separately.
- Letting a motorist change their choice after selecting.
