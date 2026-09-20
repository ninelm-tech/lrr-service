# Non-WhatsApp Operator Manual Dispatch — Design

**Status:** Approved by user 2026-09-19, section by section, in chat.

**Goal:** Let an operator business register and work jobs even when nobody
there has WhatsApp on their phone. Automatic dispatch keeps working exactly
as it does today for everyone else; a non-WhatsApp operator is only ever
reached after automatic dispatch has genuinely run out of WhatsApp-capable
candidates, and only by a staff member calling them — nothing about them is
assumed reachable by message.

## Background

Today, `Operator` has no notion of *how* it can be reached — every operator
is assumed to have WhatsApp, and every dispatch/assignment/status-update path
sends a WhatsApp message with no fallback. Confirmed via code search: at
least nine call sites do `operator.phoneNumber!`/`toWhatsAppAddress(operator
.phoneNumber)` with no guard at all (`dispatch.service.ts:416,1172`,
`payment-events.service.ts:122,130,143,239,243`, `rescue-request-admin
.service.ts:304`, `whatsapp-customer-flow.service.ts:139,147,380,1129`,
`whatsapp-inbound.service.ts:80`). `findAndRankCandidates` itself has no
filter that would exclude such an operator from ranking. This has been
silently safe only because every operator so far has actually had WhatsApp —
this feature is what makes that assumption false for the first time, so
every one of those sites needs a guard as part of shipping it, not as
optional follow-up cleanup.

**Explicitly out of scope, confirmed with the user:** the customer's own
side of the flow — WhatsApp messages, location, deposit/balance payment —
does not change at all, regardless of which kind of operator ends up on the
job. Only the operator's half of the exchange, which is the only half
actually blocked by not having the app, becomes a manual staff action.

## The model

### 1. Data model

```prisma
model Operator {
  // ...existing fields...
  whatsappEnabled Boolean @default(true)
}

model RescueRequest {
  // ...existing fields...
  needsManualAssignment Boolean @default(false)
}
```

Both additive, `@default` chosen so every existing row — every operator,
every in-flight request — keeps today's behavior with no backfill. One
hand-written migration:

```sql
ALTER TABLE "Operator" ADD COLUMN "whatsappEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "RescueRequest" ADD COLUMN "needsManualAssignment" BOOLEAN NOT NULL DEFAULT false;
```

`needsManualAssignment` is cleared the moment the request leaves the state
that set it true — assigned (by staff), cancelled, or superseded by a later
automatic match (see Section 2's ordering note). It is never read as history;
only ever as "does this request need a phone call right now."

### 2. Candidate ranking gains a WhatsApp filter

`OperatorService.findAndRankCandidates` gains one more `where` clause,
controlled by a new parameter:

```ts
async findAndRankCandidates(
  latitude: number,
  longitude: number,
  excludeIds: string[] = [],
  extraRadiusKm: number = 0,
  type?: OperatorType,
  truckClasses?: TruckClass[],
  whatsappOnly: boolean = true,
): Promise<ScoredOperator[]> {
  const operators = await this.prisma.operator.findMany({
    where: {
      status: OperatorStatus.ACTIVE,
      isAvailable: true,
      whatsappEnabled: whatsappOnly,
      ...(excludeIds.length > 0 && { id: { notIn: excludeIds } }),
      ...(type && { type }),
      ...(truckClasses &&
        truckClasses.length > 0 && {
          truckClasses: { hasSome: truckClasses },
        }),
    },
  });
  // ...unchanged from here — same in-range filter, same scoring...
}
```

`whatsappOnly: true` is the default so every existing caller (there are
several beyond dispatch — admin manual-assign search, the dispatch board)
keeps its current behavior with no call-site change. Every automatic
dispatch call site continues to pass no explicit value (i.e. stays
WhatsApp-only); the one new caller (Section 3) passes `false` explicitly.
`whatsappEnabled: whatsappOnly` — not an `OR` — deliberately makes this a
strict partition: a search is either WhatsApp-only or non-WhatsApp-only,
never both at once. Mixing them would silently re-introduce the exact bug
this feature exists to prevent (an automatic WhatsApp offer landing on an
operator who can't receive it).

### 3. Round-exhaustion gains a manual-fallback check, in one shared place

`prepareNextRound`'s own contract is untouched — it is scoped to WhatsApp
dispatch only, and its `exhausted: true` result still means exactly what its
existing docstring says. The change belongs to prepareNextRound's two
callers (`DispatchService.startDispatch` and
`BatchResolveCheck.run`), which today both do the identical thing on
`exhausted: true`: cancel the request, sweep its `PENDING` offers to
`TIMED_OUT`, reset the customer's session to `IDLE`. That duplication is
already a known risk in this codebase (the `mediaLinks` producer bug from
2026-09-19's completion-and-dispute-media-evidence plan was exactly this
shape — two independent copies of the same logic, one of which didn't get a
later fix). Rather than add a third copy of "cancel" logic with a new
branch in each, both call sites now go through one shared resolver:

```ts
// dispatch.service.ts

type ExhaustionResolution =
  | { outcome: 'manual-fallback'; candidateId: string }
  | { outcome: 'cancelled'; reason: 'no-coverage' | 'rounds-exhausted'; round: number };

/**
 * What to do once prepareNextRound reports exhausted: true. Checked here,
 * not inlined at each call site, because both current call sites
 * (startDispatch, BatchResolveCheck) need the identical decision and the
 * identical cancel side effects — see the mediaLinks producer-drift bug
 * this duplication pattern already caused once in this codebase.
 *
 * Must run as part of the SAME transaction that observed `exhausted`, for
 * the same reason prepareNextRound's own docstring gives for cancelling in
 * that transaction: nothing else will ever revisit a DISPATCHING request
 * with no live offers and no flag set.
 *
 * Not `private`: `BatchResolveCheck` is a separate class holding its own
 * injected `DispatchService`, and calls this the same way it already calls
 * `prepareNextRound` — a `private` method would not compile there. (Caught
 * in review — an earlier draft of this spec marked it `private`.)
 */
async resolveExhaustion(
  tx: Prisma.TransactionClient,
  rescueRequest: { id: string; latitude: Prisma.Decimal; longitude: Prisma.Decimal; vehicleType: string | null; offeredOperatorIds: string[]; customerId: string },
  exhausted: { reason: 'no-coverage' | 'rounds-exhausted'; round: number },
): Promise<ExhaustionResolution> {
  const eligibleTruckClasses = rescueRequest.vehicleType
    ? getEligibleTruckClasses(rescueRequest.vehicleType)
    : undefined;

  // Same search that just failed, minus the WhatsApp requirement. A
  // genuine no-coverage case (nobody active within ~150km at all) returns
  // empty here too, without needing its own branch — this is why the two
  // `exhausted` reasons don't need to be handled differently.
  const backupCandidates = await this.operatorService.findAndRankCandidates(
    Number(rescueRequest.latitude),
    Number(rescueRequest.longitude),
    rescueRequest.offeredOperatorIds,
    0,
    undefined,
    eligibleTruckClasses,
    false,
  );

  if (backupCandidates.length > 0) {
    await tx.rescueRequest.update({
      where: { id: rescueRequest.id },
      data: { needsManualAssignment: true, dispatchRound: exhausted.round },
    });
    return { outcome: 'manual-fallback', candidateId: backupCandidates[0].id };
  }

  await tx.rescueRequest.update({
    where: { id: rescueRequest.id },
    data: { status: RescueRequestStatus.CANCELLED, dispatchRound: exhausted.round },
  });
  await tx.dispatchOffer.updateMany({
    where: { rescueRequestId: rescueRequest.id, status: 'PENDING' },
    data: { status: 'TIMED_OUT', respondedAt: new Date() },
  });
  await tx.whatsAppSession.updateMany({
    where: { userId: rescueRequest.customerId },
    data: { state: 'IDLE', rescueRequestId: null },
  });
  return { outcome: 'cancelled', reason: exhausted.reason, round: exhausted.round };
}
```

`startDispatch` and `BatchResolveCheck.run` both replace their inline cancel
block with a call to this, inside the same `tx` they already hold, and
branch on `outcome` only for what happens *outside* the transaction
afterward: `'cancelled'` keeps calling `notifyNoOperatorAvailable` exactly as
today; `'manual-fallback'` sends no customer message at all (the request is
still alive, just waiting on a phone call, not something to apologize for).
**Correction from an earlier draft of this spec:** it originally claimed
staff get alerted here the way `alertAdminNoOperator` "already does" — that
method is in fact just a `console.warn` stub today ("Hook to admin
notification service when available", `dispatch.service.ts:1415-1425`), not
a real alert of any kind. There is no existing push-alert mechanism for this
case to reuse. Given Section 5 already makes the Requests/Dispatch Board
badge the primary way staff notices a manual-assignment job, this design
does not add a new alert channel for it — logs a warning + a
`Sentry.captureMessage` at `info` level (same shape as
`notifyNoOperatorAvailable`'s existing Sentry call for the cancelled case,
so this failure mode is at least visible in Sentry if the badge goes
unnoticed), and relies on the badge for staff to actually act. If that
turns out to be insufficient in practice, a real staff-alert channel is a
separate, later feature — not assumed here.

**Ordering note:** if a request is flagged `needsManualAssignment: true` and
staff hasn't acted yet, and a WhatsApp-enabled operator becomes newly
available in range before the flag is cleared, nothing in this design
re-tries the automatic path — the request stays flagged until staff assigns
someone or the request is cancelled some other way. Automatically un-flagging
on a new WhatsApp candidate appearing would mean staff calling an operator
who says yes, right as the system silently decides it doesn't need them
anymore — a worse outcome than occasionally routing a job to backup when a
faster automatic match technically existed a moment later. Staff can always
manually assign the newly-available WhatsApp operator instead if they notice.

### 4. Staff confirms the assignment — `assignOperator`, not a new endpoint

The existing manual override, `RescueRequestAdminService.assignOperator(id,
{operatorId, priceKobo})`, already does everything this needs: skips
bidding, creates the offer directly, moves the request to
`WAITING_FOR_DEPOSIT`. Three changes — the third found in review:

```ts
// Right after the existing operator lookup (operator.status !== 'ACTIVE'
// check) and the existing request lookup, before the transaction:
if (!operator.whatsappEnabled && !request.needsManualAssignment) {
  throw new BadRequestException(
    'This operator has no WhatsApp on file — it can only be assigned to a request flagged for manual assignment.',
  );
}
```

**Found in review — backend enforcement was missing entirely.** This
design's whole stated goal is that a non-WhatsApp operator is "only ever
reached after automatic dispatch has genuinely run out" (Goal, above). An
earlier draft only enforced that in the UI — the general-purpose picker's
default stayed WhatsApp-only (Section 5), and the new candidate card only
appears once `needsManualAssignment` is true — but `assignOperator` itself
took any `operatorId` with no check at all. Any caller who already knows a
non-WhatsApp operator's id (e.g. from the Operators tab, unrelated to this
flow) could assign them to an ordinary request still mid-automatic-dispatch,
skipping the "exhausted first" rule outright — a UI omission was never a
real guarantee. The check above closes it, and applies **only** to
non-WhatsApp operators: assigning a `whatsappEnabled: true` operator through
this same endpoint is completely unaffected, exactly as it works today —
this is an additional precondition on the already-narrower case, not a new
rule for the general manual-override path. It also does not require the
suggested candidate specifically — any non-WhatsApp operator is acceptable
once the flag is set, matching the "Explicitly not doing" note on not
enforcing staff pick the top suggestion.

```ts
// After the existing successful-assignment block, before the two
// unconditional WhatsApp sends (currently lines 308-315):
if (operator.whatsappEnabled) {
  void this.twilioService.sendWhatsAppMessage(operatorPhone, /* ...unchanged... */);
}
// The customer's message is NOT wrapped — customer stays fully
// automatic regardless of which kind of operator they got.
void this.twilioService.sendWhatsAppMessage(customerPhone, /* ...unchanged... */);
```

And, at the top of the method, clearing the flag on success:

```ts
data: {
  assignedOperatorId: dto.operatorId,
  status: RescueRequestStatus.WAITING_FOR_DEPOSIT,
  needsManualAssignment: false,
  // ...existing fields unchanged...
},
```

No new confirmation endpoint. Staff calls the operator off-platform first —
that phone call *is* the confirmation step; there's nothing for software to
verify about a phone call, only a record that one led to this assignment
(Section 6).

### 5. Surfacing to staff — reusing the existing Requests / Dispatch Board views

`needsManualAssignment: true` shows as a new badge (`lrr-web`, same styling
family as the existing status badges) on both the Requests tab and Dispatch
Board — wherever a request's live status already renders. Clicking through
to the request's detail view shows the suggested candidate's business name,
phone number, distance, and acceptance rate — the same information an
automatic offer would carry, sourced from calling
`findAndRankCandidates(..., false)` again for display (cheap, not persisted
— the persisted flag is only ever a boolean, not a frozen candidate list, so
a re-ranked "who's actually best right now" is what staff sees, not a stale
snapshot from whenever the flag was set).

**Each candidate card is directly actionable — caught as a gap in review.**
An earlier draft left "staff sees the candidate" (this section) and "staff
uses `assignOperator`" (Section 4) as two disconnected facts, with no
description of how one leads to the other. Each card gets its own
**"Assign this operator"** button, which opens the same price-entry step
`assignOperator` already requires and submits directly with that
`operatorId` — staff never has to separately locate this specific operator
in the general-purpose assignment picker (whose own default stays
`whatsappOnly: true`, unchanged, since that picker serves the *existing*
proactive-reassignment use case, not this one).

**A second, later handoff moment — found in review, no earlier draft
addressed it at all.** `needsManualAssignment` is cleared the moment staff
calls `assignOperator` (Section 4), well before the customer has actually
paid the deposit. Once the deposit clears, `payment-events.service.ts`
moves the request to `OPERATOR_ASSIGNED` and — for a WhatsApp operator —
sends them a WhatsApp message telling them to go (one of the Background
section's nine guarded sites, suppressed here). For a non-WhatsApp
operator that suppressed message is the *only* thing that would have told
them to actually start driving, and by this point the badge that got
staff's attention in the first place is already gone — nothing left
signals "call them again, the customer paid." This is the more consequential
of the two handoff gaps, since a missed call here means an operator who
agreed to a job never learns it's actually time to go.

No new persisted state for this either — same reasoning as not persisting a
"suggested candidate" above. It's fully derivable: any request where
`assignedOperator?.whatsappEnabled === false && status ===
RescueRequestStatus.OPERATOR_ASSIGNED` gets its own distinct badge/action on
the same Requests tab / Dispatch Board views — something like **"Call
operator — deposit paid, dispatch now"** — separate from the
`needsManualAssignment` badge (different meaning: that one means "pick
someone," this one means "tell the one you already picked to go"). Once
staff has made that call, the next available manual action is `manual-arrived`
(Section 6) — nothing in the backend forces staff to acknowledge this
specific badge before clicking Arrived, the same way nothing forces the
initial phone call to happen before `assignOperator` beyond staff's own
judgment; this is a visibility aid, not a state machine gate.

### 6. Manual status control — "arrived" and "done", by extracting the shared half

**This whole section was corrected in review — two real problems found.
Both are resolved below, in place of the earlier draft's code.**

**Problem A (fixed here): no ordering guard.** The WhatsApp path's ARRIVED
and DONE handlers each check the operator's own session state before doing
anything — ARRIVED requires `session.state === OPERATOR_ON_JOB`
(`whatsapp-operator-flow.service.ts:330`); DONE requires `session.state ===
OPERATOR_AT_LOCATION`, i.e. ARRIVED must have already happened
(`:361`). A manual job has no operator session, so that check can't carry
over as-is — but dropping it entirely, as an earlier draft of this section
did, would let staff click "Mark done" on a request that was never even
marked arrived, or click either button before the deposit has even cleared.
The equivalent guard uses the *request's* own status instead, checked at
the top of each new endpoint before it does anything else:

- `manual-arrived` requires `rescueRequest.status === RescueRequestStatus
  .OPERATOR_ASSIGNED` (the status the deposit-confirm webhook already sets —
  same point in the lifecycle `OPERATOR_ON_JOB` represents for a WhatsApp
  operator).
- `manual-done` requires `rescueRequest.status === RescueRequestStatus
  .ARRIVED` (same point `OPERATOR_AT_LOCATION` represents).

Both `ForbiddenException` with a message naming the actual current status,
on failure.

**Problem B, found and resolved with the user:** the earlier draft's
`startCompletionConfirmation` was mis-mapped. In the real WhatsApp flow,
saying "done" does **not** immediately produce the effect this spec called
`startCompletionConfirmation` — it only moves the operator's session to
`OPERATOR_AWAITING_COMPLETION_MEDIA` and asks for a photo/video
(`:377-382`, from this session's earlier mandatory-completion-evidence
feature). The `confirmationDueAt` transaction this spec extracts only runs
*after* that media is actually received and saved — there is no path to it
that skips the photo today. A manual "Mark done" button wired straight to
that transaction, as originally drafted, would let a non-WhatsApp job
complete with **zero** evidence, silently opening a hole in a rule this
codebase made mandatory earlier the same day this spec was written.

Closing that hole properly would mean building a new admin-side upload
capability from scratch — `MediaController`
(`src/media/media.controller.ts`) is read-only today (a signed-URL redirect
for viewing already-stored media), and nothing else in this codebase
accepts a file upload outside the WhatsApp inbound-media webhook path.
**Decision: non-WhatsApp jobs are exempt from mandatory completion
evidence.** The mandatory-evidence rule stays universal for WhatsApp
operators (unchanged, still enforced exactly as it is today) and becomes
"mandatory when the channel can actually carry a photo" rather than
literally universal — a manually-operated job is staff-verified by phone
call instead. `manual-done` calls the `confirmationDueAt` transaction
directly, the way the earlier mis-mapped draft assumed, just now correctly
labeled as what it actually is and gated by the Problem-A status guard:

```ts
// whatsapp-operator-flow.service.ts
//
// notifyCustomerOperatorArrived is shared between the WhatsApp handler and
// the new manual-arrived endpoint (the WhatsApp handler still does its own
// session-state check first — Problem A only applies to the new endpoint,
// which has no session to check). startManualCompletionConfirmation below
// it is NOT shared — see the note after this block for why.

async notifyCustomerOperatorArrived(rescueRequestId: string): Promise<void> {
  const rescueRequest = await this.prisma.rescueRequest.findUnique({
    where: { id: rescueRequestId },
    include: { customer: true, assignedOperator: true },
  });
  if (!rescueRequest) return;
  await this.prisma.rescueRequest.update({
    where: { id: rescueRequestId },
    data: { status: RescueRequestStatus.ARRIVED },
  });
  const customerPhone = rescueRequest.customer.phoneNumber;
  if (customerPhone) {
    await this.twilioService.sendWhatsAppMessage(
      customerPhone,
      `🚗 Your tow operator has arrived!\n\nBusiness: *${rescueRequest.assignedOperator?.businessName}*\n\nThey're at your location. Please show them your vehicle.`,
    );
  }
}

/**
 * The DONE-equivalent for a manual job — deliberately NOT gated on
 * completion media (Problem B above): a non-WhatsApp job is exempt from
 * the mandatory-evidence rule by explicit decision, verified by phone
 * instead. Identical transaction to `handleOperatorJobDone`'s own
 * `confirmationDueAt` write, minus the two operator-session writes (no
 * session exists for a manual job) — AND, corrected in a further review
 * pass, identical to it in sending the customer the actual "reply CONFIRM"
 * prompt after commit. An earlier draft of this method stopped at the
 * transaction: it moved the customer's session to
 * `AWAITING_COMPLETION_CONFIRM` and set `confirmationDueAt`, but never told
 * the customer they were expected to reply to anything — silently
 * contradicting this spec's own "customer side stays fully automatic" rule
 * (Background), and leaving the job to surface only via
 * `StalledConfirmationCheck`'s 30-minute alert instead of a normal
 * customer reply.
 */
async startManualCompletionConfirmation(rescueRequestId: string): Promise<void> {
  const rescueRequest = await this.prisma.rescueRequest.findUnique({
    where: { id: rescueRequestId },
    select: { customerId: true, customer: { select: { phoneNumber: true } }, assignedOperator: { select: { businessName: true } } },
  });
  if (!rescueRequest) return;
  await this.prisma.$transaction(async (tx) => {
    await tx.rescueRequest.update({
      where: { id: rescueRequestId },
      data: { confirmationDueAt: new Date(Date.now() + STALLED_CONFIRMATION_MS) },
    });
    if (rescueRequest.customerId) {
      await tx.whatsAppSession.updateMany({
        where: { userId: rescueRequest.customerId },
        data: { state: WhatsAppFlowState.AWAITING_COMPLETION_CONFIRM, rescueRequestId },
      });
    }
  });

  // Notification only after the commit — same ordering `handleOperatorJobDone`
  // already uses, and the same message content, so a customer sees an
  // identical prompt regardless of which kind of operator did the job.
  const customerPhone = rescueRequest.customer?.phoneNumber;
  if (customerPhone) {
    await this.twilioService.sendWhatsAppMessage(
      customerPhone,
      `🔧 ${rescueRequest.assignedOperator?.businessName} says the job is done!\n\nReply *CONFIRM* to release your vehicle and receive the balance payment link.\n\nIf there's a problem, reply *DISPUTE* and our team will investigate.`,
    );
  }
}
```

`handleOperatorArrived` is rewritten to call `notifyCustomerOperatorArrived`
as its first step, then do its existing operator-session-only work — zero
behavior change for the WhatsApp path, confirmed by that path's existing
tests continuing to pass unmodified. `handleOperatorJobDone` is **not**
touched at all — it still requires media first, exactly as today;
`startManualCompletionConfirmation` is a new, separate method only the
manual endpoint calls, not a shared extraction, since the WhatsApp path's
own DONE has a step (the media wait) the manual path deliberately skips.

Two new `SUPER_ADMIN`/`ADMIN`-gated controller actions, usable only when the
request's `assignedOperator.whatsappEnabled === false` (rejected otherwise —
a WhatsApp-enabled operator's job is never manually advanced, since that
would let staff and the operator's own WhatsApp replies race each other over
the same status):

```
PATCH /rescue-requests/:id/manual-arrived
PATCH /rescue-requests/:id/manual-done
```

Each: validate the `whatsappEnabled: false` guard and the matching status
guard above, then call `notifyCustomerOperatorArrived` or
`startManualCompletionConfirmation` respectively, write an audit log entry
(Section 7), return the updated request.

### 7. Audit logging

Both new actions log at the controller level, matching the existing
convention (`rescue-request.controller.ts`'s refund/dispute-resolve calls):

```ts
await this.auditLogService.record({
  category: 'manual_operator_arrived', // or 'manual_operator_done'
  message: `Marked operator arrived for request ${id} (no WhatsApp on file)`,
  details: { targetType: 'RescueRequest', targetId: id, operatorId: request.assignedOperatorId },
  actorId: req.user.userId,
});
```

The manual-assignment step itself (Section 4) also gains an audit entry —
`assignOperator`'s controller currently has none at all (confirmed: neither
`assignOperator`, `updateStatus`, nor `cancel` call `auditLogService.record`
today) — added as part of this feature specifically for the
`whatsappEnabled: false` case, category `manual_assignment_confirmed`,
`details` recording the operator actually assigned (`operatorId`,
`businessName`).

**Corrected in review:** an earlier draft of this bullet also wanted the
audit entry to capture "which candidate was suggested vs. which was
actually picked." That's not reconcilable with Section 5's own decision not
to persist a suggestion at all — candidates are re-ranked live every time
the request is viewed, so there is no fixed "the suggestion" to diff the
final pick against; the ranking staff saw when they first opened the
request may not match the ranking at assignment time, and neither is
stored. Recording only who was actually assigned is consistent with that
choice and is the simpler audit trail — a persisted `suggestedOperatorId`
snapshot is a bigger, un-asked-for change to Section 5's design, not a
one-line addition.

### 8. Registration

`/register` (lrr-web) gains one checkbox, checked by default: *"This
business has WhatsApp on this phone number."* Unchecked →
`whatsappEnabled: false` on the `POST /operators` call. No change to the
verification-code flow — a non-WhatsApp operator still receives their
signup SMS code via Termii exactly as every operator does today (SMS, not
WhatsApp, already the channel there); this field only affects whether
*dispatch* messages go via WhatsApp later.

## Explicitly not doing

- **Changing anything about the customer's own flow.** Confirmed with the
  user — WhatsApp messages, location, deposit/balance payment are identical
  regardless of which kind of operator lands on the job.
- **A general "assignment channel" abstraction** (WhatsApp / manual / future
  channels as an enum). Only two channels exist and nothing indicates a
  third is coming — YAGNI, considered and rejected during design.
- **Auto-clearing `needsManualAssignment` when a WhatsApp candidate becomes
  available later.** See the ordering note in Section 3 — deliberately
  staff-driven only, to avoid pulling an operator out from under a call in
  progress.
- **A dedicated new admin page for manual-assignment jobs.** Reuses the
  existing Requests tab / Dispatch Board with a badge, per the user's own
  preference during design — staff already watches those views.
- **Enforcing that the suggested candidate is the one staff actually
  assigns.** Staff can call the top suggestion, get no answer, and call the
  next-best one instead — `assignOperator` already accepts any
  `whatsappEnabled: false` operator, not just the one the flag suggested.

## Testing

- **`findAndRankCandidates` partitions strictly on `whatsappOnly`** — a mix
  of `whatsappEnabled: true`/`false` operators in range, `whatsappOnly:
  true` returns only the enabled ones and vice versa; the default
  (parameter omitted) behaves as `true`, unchanged from every existing
  caller's perspective.
- **`resolveExhaustion` picks manual-fallback over cancellation when a
  non-WhatsApp candidate exists** — `exhausted: {reason: 'rounds-exhausted'}`
  with a `whatsappEnabled: false` operator in range → `needsManualAssignment:
  true`, request NOT cancelled, no `PENDING` offers swept, customer session
  untouched.
- **`resolveExhaustion` still cancels when no candidate exists at all** —
  same exhausted input, zero operators of either kind in range → identical
  cancel/sweep/reset behavior to today, `reason` passed through unchanged.
  Covers both `'no-coverage'` and `'rounds-exhausted'` — no separate branch
  needed, so one test per `exhausted.reason` confirms neither accidentally
  gained one.
- **Both `prepareNextRound` callers (`startDispatch`, `BatchResolveCheck`)
  route through the shared resolver identically** — a regression test
  asserting neither has its own inline cancel logic left over (i.e. the
  refactor actually removed the duplication, not just added a third copy).
- **`assignOperator` skips the operator WhatsApp send for
  `whatsappEnabled: false`, never skips the customer's** — mock
  `twilioService.sendWhatsAppMessage`, assert call count and recipients for
  both operator flag values.
- **`assignOperator` clears `needsManualAssignment` on success.**
- **`assignOperator` rejects a `whatsappEnabled: false` operator when the
  request isn't flagged `needsManualAssignment: true`** — `BadRequestException`,
  no offer created, no status change. This is the backend enforcement of the
  design's core rule, found missing in review — without it, the "only after
  exhaustion" guarantee was UI-only.
- **`assignOperator` is completely unaffected for `whatsappEnabled: true`
  operators** — same success path as today regardless of
  `needsManualAssignment`'s value, confirming the new check is additive to
  the non-WhatsApp case only, not a new rule for the general manual-override
  path.
- **The two new manual-status endpoints reject a `whatsappEnabled: true`
  operator's request** — `ForbiddenException` or equivalent, so staff can
  never race a real operator's own WhatsApp replies.
- **`manual-arrived` rejects a request not in `OPERATOR_ASSIGNED`** — e.g.
  still `WAITING_FOR_DEPOSIT` or already `ARRIVED` — mirroring the WhatsApp
  handler's own `OPERATOR_ON_JOB` session check (Section 6, Problem A).
- **`manual-done` rejects a request not in `ARRIVED`** — mirroring the
  WhatsApp handler's `OPERATOR_AT_LOCATION` check. Covers the case an
  earlier draft of this spec would have missed entirely: staff clicking
  "done" before ever clicking "arrived."
- **`notifyCustomerOperatorArrived` produces identical customer-facing
  effects whether called from the WhatsApp handler or the new manual
  endpoint** — same message content, same `ARRIVED` status write, asserted
  from both call sites against the same expected shape.
- **`startManualCompletionConfirmation` sets `confirmationDueAt` and the
  customer's `AWAITING_COMPLETION_CONFIRM` session state with no media
  check** — the deliberate exemption from Section 6's Problem B decision,
  asserted directly so a future change can't silently reintroduce a media
  requirement here (or, just as easily, silently drop the requirement on
  the *WhatsApp* path by mistake) without a test noticing either.
- **`startManualCompletionConfirmation` sends the customer the same "reply
  CONFIRM" WhatsApp message `handleOperatorJobDone` sends, after commit** —
  found missing in review; without this assertion the extraction could
  silently regress back to a DB-only state change with no customer prompt.
- **`handleOperatorJobDone` (the WhatsApp path) is completely untouched by
  this feature** — its own existing tests still assert media is required
  before `confirmationDueAt` is ever set, confirming the manual exemption
  didn't leak into the path where evidence is still mandatory.
- **Existing WhatsApp `ARRIVED`/`DONE` handler tests pass unmodified** after
  the extraction — the refactor must be behavior-preserving for the path
  that already works today.
- **Integration test, real Postgres:** full manual-dispatch scenario — a
  non-WhatsApp-only operator in range, WhatsApp dispatch rounds exhaust,
  `needsManualAssignment` flips true, `assignOperator` confirms it (flag
  clears), customer pays the deposit (status → `OPERATOR_ASSIGNED`,
  `needsManualAssignment`-derived badge now false but the new
  deposit-paid/dispatch-now derived state now true — asserted explicitly,
  not skipped over), manual arrived, manual done (customer receives the
  confirm prompt — asserted), then the customer's *existing, untouched*
  automatic confirm/balance-payment path completes the job — final DB state
  indistinguishable from a fully-automatic job's, except for the audit trail
  this feature adds. **Found missing in review:** an earlier draft of this
  test jumped straight from deposit payment to `manual-arrived` with nothing
  in between — the second handoff moment (Section 5) needs its own explicit
  assertion, not an implicit skip.
- **Every guarded send site sends nothing to a `whatsappEnabled: false`
  operator** — one test per site identified in Background, confirming the
  guard added there actually suppresses the send rather than merely
  compiling.
