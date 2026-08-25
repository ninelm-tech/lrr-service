# Dispatch: Two-Phase Search and Quote Collection — Implementation Plan

Implements `docs/superpowers/specs/2026-08-24-dispatch-parallel-batches-design.md`.
Read that spec first — this plan sequences its 9 changes into tasks; it does not
repeat the reasoning.

**Prerequisite:** tasks 1–3 from the earlier standalone fix (per-batch timer
keys via `batchTimers`, `supersedeActiveRound` deletion, `offeredOperatorIds`
reset removal) must be committed before starting Task 1 here — this plan
builds on that code, not on `main`/pre-fix `dispatch.service.ts`.

## Task order and why

1. **Schema** — `batchId`, `quoteCollectionDeadline`, config fields. Everything
   else depends on these existing.
2. **Batch identity** (spec change 2) — replaces `expiresAt`-keyed batch lookup
   with `batchId`. Must land before change 4 touches `expiresAt`, or the two
   land in a state where batches can't be found mid-transition.
3. **Batch-size config** (half of change 7) — `PlatformConfig` read replaces
   the hardcoded `BATCH_SIZE`. Small, independent, do it while the file is
   already open for the batch-identity change.
4. **Phase-2 transition** (change 4, includes the other half of change 7) —
   the deadline, the atomic set, the `expiresAt` rewrite, the write-time
   clamp for new offers, the countdown template. `quoteCollectionMinutes` is
   read from `PlatformConfig` **here**, not in Task 3 — it feeds the new
   deadline logic this task builds, not the old `scheduleGraceResolve`
   mechanism this task deletes. Wiring it into the old mechanism in Task 3
   would mean writing code Task 4 immediately throws away; reading it once,
   where it's actually consumed, avoids that.
5. **Atomic quote/decline** (change 5) — depends on change 4 existing
   (`expiresAt` must already be authoritative for this to matter).
6. **Bidding closes** (change 6) — early-resolution-or-deadline, the
   `NOT_SELECTED` late-quote path, the expand/manual-assign deadline guard.
7. **Delete the retry delay** (change 8) — small, but do it after 4–6 so
   `startDispatch`'s auto-continuation guard (added in change 3 of the
   standalone fix / change 3 here) and this interact correctly rather than
   guessing at ordering.
8. **UI: 30s expand guard + config screen** (change 9 + change 7's `lrr-web` half)
   — last, since it depends on the config fields and the deadline existing.

Each task ends with `tsc --noEmit` and the full jest suite green before moving
on — this file follows the plan-per-task convention; execute via
subagent-driven-development or inline per your usual process.

---

## Task 1: Schema — `batchId`, `quoteCollectionDeadline`, config fields

**Files:**
- Modify: `prisma/schema.prisma`
- Migration: `prisma migrate dev --name dispatch_two_phase`

**Changes:**

```prisma
model DispatchOffer {
  // ...existing fields...
  batchId String  // new, no default — every creation site must set it
}

model RescueRequest {
  // ...existing fields...
  quoteCollectionDeadline DateTime?  // null = phase 1 (SEARCHING)
}

model PlatformConfig {
  // ...existing fields...
  quoteCollectionMinutes Int @default(5)
  dispatchBatchSize      Int @default(3)
}
```

`batchId` has no default and is not optional — this forces every
`dispatchOffer.create`/`createMany` call site to set it explicitly, which is
what surfaces every place that needs updating in Task 2 (a compile error, not
a silent gap).

Add an index: `@@index([rescueRequestId, batchId])` — `maybeResolveBatchEarly`
and `resolveBatch` will query on this pair.

- [ ] Add the three schema changes above
- [ ] Run `npx prisma migrate dev --name dispatch_two_phase`
- [ ] Run `npx prisma generate`
- [ ] Run `npx tsc --noEmit` — expect failures at every `dispatchOffer.create`
      call site missing `batchId`. Do not fix them here; Task 2 does that.
- [ ] Commit: `git add prisma/ && git commit -m "schema: add batchId, quoteCollectionDeadline, dispatch config fields"`

---

## Task 2: Batch identity — `batchId` replaces `expiresAt` as the lookup key

**Files:**
- Modify: `src/rescue-request/dispatch.service.ts`

**Steps:**

- [ ] In `startDispatch`'s batch-creation path: generate `const batchId = crypto.randomUUID()`
      before `dispatchOffer.createMany`; include `batchId` in every row's `data`.
- [ ] In `manualOfferToOperator`: same — generate a `batchId` for its single-offer batch.
- [ ] Update `batchKey`:
  ```ts
  private batchKey(rescueRequestId: string, batchId: string): string {
    return `${rescueRequestId}:${batchId}`;
  }
  ```
- [ ] Update `batchTimers.set(...)` call sites to use `this.batchKey(rescueRequestId, batchId)`.
- [ ] Update `resolveBatch`'s signature: replace the `batchExpiresAt: Date` parameter
      with `batchId: string`; update its `batchKey` call and its offer query:
      `where: { rescueRequestId, batchId }` instead of `{ rescueRequestId, expiresAt: batchExpiresAt }`.
- [ ] Update `maybeResolveBatchEarly`'s signature and query the same way —
      `batchId: string` instead of `batchExpiresAt: Date`.
- [ ] Update every caller of `resolveBatch`/`maybeResolveBatchEarly` to pass
      `batchId` instead of `expiresAt`. This includes `scheduleGraceResolve`'s
      internal timer callback, which currently reads `batchOffers` by
      `expiresAt` — change its query to `{ rescueRequestId, batchId }` too.
- [ ] Update `processQuoteOrDecline`'s calls into `maybeResolveBatchEarly` /
      `scheduleGraceResolve` — these currently pass `offer.expiresAt`; they
      need `offer.batchId` instead. Add `batchId` to the `offer` parameter
      type at the top of the file.
- [ ] Run `npx tsc --noEmit` — should now be clean.

**Testing:**
- [ ] In `dispatch.service.spec.ts`, update every test that keys `batchTimers`
      by a synthetic `expiresAt` to key by a synthetic `batchId` instead
      (`clearAllBatchTimers` helper and its callers stay the same, since they
      already iterate the whole map rather than assuming a key shape).
- [ ] Add: **"batch identity survives the `expiresAt` rewrite"** — construct two
      offers sharing a `batchId` where one has been rewritten to a shorter
      `expiresAt` (simulating Task 5's transition) and one hasn't; assert
      `resolveBatch` still finds both by `batchId`.
- [ ] `npx jest src/rescue-request/dispatch.service.spec.ts` green, no `--forceExit` needed.
- [ ] Commit.

---

## Task 3: Config — batch size from `PlatformConfig`

`quoteCollectionMinutes` is deliberately NOT read here — see "Task order and
why" above. It's read directly in Task 4, where the deadline logic that
consumes it is built. Wiring it into `scheduleGraceResolve` here would mean
writing code Task 4 deletes a few steps later.

**Files:**
- Modify: `src/rescue-request/dispatch.service.ts`
- Modify (frontend): `lrr-web` — find the existing platform-config admin form
  (same one `dispatchWindowMinutes` is already exposed through) and add
  **both** new fields, `dispatchBatchSize` and `quoteCollectionMinutes` —
  the frontend form has no reason to split by backend task boundaries; add
  them together here even though the backend read for the second one lands
  in Task 4.

**Steps:**

- [ ] Replace `const BATCH_SIZE = 3` with a read from
      `this.platformConfigService.getConfig()` at the top of `startDispatch`
      (it already fetches `config` there for `dispatchWindowMinutes` — reuse
      the same call, don't add a second fetch).
- [ ] `lrr-web`: locate the config form, add both new number fields with
      the same validation pattern as `dispatchWindowMinutes`.

**Testing:**
- [ ] Add: batch size comes from a mocked `PlatformConfigService` response,
      not `BATCH_SIZE` — assert `dispatchOffer.createMany` is called with a
      batch sized to the mocked config value.
- [ ] `lrr-web`: smoke-test the form renders and submits both new fields
      (follow whatever pattern the existing `dispatchWindowMinutes` field's
      test uses, if one exists).
- [ ] Commit.

---

## Task 4: Phase-2 transition — the deadline, the rewrite, the clamp, the template

**This is the largest and riskiest task in the plan — the spec's change 4.**

**Files:**
- Modify: `src/rescue-request/dispatch.service.ts`
- Modify: `src/integrations/twilio/twilio.service.ts` (if a new template-send
  helper is needed — check whether `sendDispatchOfferMessage`'s pattern can
  be reused directly for the countdown template, or needs a sibling method)
- Env: document `TWILIO_QUOTE_COUNTDOWN_TEMPLATE_SID` in `.env.example`

**Steps:**

- [ ] Read `quoteCollectionMs` from `this.platformConfigService.getConfig()`
      (the `quoteCollectionMinutes` field added to the schema in Task 1) — this
      is the read that Task 3 deliberately deferred to here.
- [ ] In `processQuoteOrDecline`'s QUOTED branch, after the `dispatchOffer.update`
      that sets `status: 'QUOTED'`: attempt the atomic once-only deadline set —
      ```ts
      const started = await this.prisma.rescueRequest.updateMany({
        where: { id: offer.rescueRequestId, quoteCollectionDeadline: null },
        data:  { quoteCollectionDeadline: new Date(Date.now() + quoteCollectionMs) },
      });
      ```
- [ ] If `started.count > 0` (this call began phase 2):
  - re-read the just-set deadline (`findUnique` on `quoteCollectionDeadline`,
    or trust the value just computed — same thing, no race since we hold the
    "started" claim)
  - shorten every still-pending offer on the request:
    ```ts
    await this.prisma.dispatchOffer.updateMany({
      where: { rescueRequestId: offer.rescueRequestId, status: 'PENDING', expiresAt: { gt: deadline } },
      data:  { expiresAt: deadline },
    });
    ```
  - notify still-pending operators via the countdown template (see below)
  - schedule the deadline-close timer

  Task 6 implements the full logic `closeBidding` runs — this task does need a
  real, callable `closeBidding(rescueRequestId)` to schedule against (not a
  stub), so build the minimal version here (mark `PENDING` → `TIMED_OUT`,
  send the shortlist) and let Task 6 extend it with early-resolution and the
  `NOT_SELECTED` late-quote handling. This plan is written to be run as one
  continuous pass through Tasks 4–6 rather than with hard stops between them,
  given how tightly they're coupled — split them only if you have a specific
  reason to review each in isolation.
- [ ] Delete `scheduleGraceResolve`, `notifyPendingOperatorsOfCountdown`'s
      freeform body, `QUOTE_GRACE_MS`, and `graceTimers` — replaced by the
      above.
- [ ] Rewrite `notifyPendingOperatorsOfCountdown` (keep the name, change the
      body) to send via `TWILIO_QUOTE_COUNTDOWN_TEMPLATE_SID` when set,
      falling back to the existing freeform text when unset — same
      env-gated pattern as `sendDispatchOfferMessage`. Compute remaining
      minutes from `quoteCollectionDeadline`, not a hardcoded window.
- [ ] **Clamp new offers at write time.** In both `startDispatch`'s
      batch-creation path and `manualOfferToOperator`: immediately before
      `dispatchOffer.create`/`createMany`, re-read
      `quoteCollectionDeadline` fresh (`findUnique`, not a value captured
      earlier in the function) and compute:
      ```ts
      const offerExpiresAt = deadline
        ? new Date(Math.min(Date.now() + windowMs, deadline.getTime()))
        : new Date(Date.now() + windowMs);
      ```
      This closes the race described in the spec: candidate lookup takes
      real time, and a quote can land (starting phase 2) in that gap.
- [ ] **Offer message honesty.** Wherever the offer text says "You have N
      minutes to respond", compute N from the actual `offerExpiresAt` just
      calculated, not from the configured window — a phase-2 offer with 90
      seconds left must say 90 seconds, not the full window.

**Testing:**
- [ ] "first quote sets `quoteCollectionDeadline` and shortens every pending
      offer whose `expiresAt` is later than it"
- [ ] "a second quote does not move the deadline" (mock `updateMany` returning
      `count: 0` on the second call, assert nothing further happens)
- [ ] "expand-vs-first-quote race": mock the deadline read inside the
      clamp-at-creation step returning a just-set deadline even though an
      earlier read in the same test setup returned null — assert the created
      offer's `expiresAt` is clamped, not the full window
- [ ] "countdown notice uses the template path" — `TWILIO_QUOTE_COUNTDOWN_TEMPLATE_SID`
      set → `sendWhatsAppTemplateMessage` called; unset → `sendWhatsAppMessage`
      (freeform) called
- [ ] "offer message states true remaining time" for a phase-2-created offer
- [ ] `npx tsc --noEmit` and full jest suite green
- [ ] Commit.

---

## Task 5: Atomic quote/decline transition

**Files:**
- Modify: `src/rescue-request/dispatch.service.ts` (`processQuoteOrDecline`)

**Steps:**

- [ ] Replace the unconditional `dispatchOffer.update` in `processQuoteOrDecline`
      with a conditional `updateMany`:
      ```ts
      const claimed = await this.prisma.dispatchOffer.updateMany({
        where: { id: offer.id, status: 'PENDING', expiresAt: { gt: new Date() } },
        data:  {
          status: quotedPriceKobo === undefined ? 'DECLINED' : 'QUOTED',
          quotedPrice: quotedPriceKobo,
          respondedAt: new Date(),
        },
      });
      if (claimed.count === 0) {
        return { quoted: false, message: `Sorry, that offer has expired.` };
      }
      ```
- [ ] Everything downstream (the phase-2 deadline-set logic from Task 4, the
      `maybeResolveBatchEarly` call) only runs when `claimed.count > 0`.

**Testing:**
- [ ] "an offer whose `expiresAt` has passed but status is still `PENDING`
      (the sweep-gap case) is rejected by `processQuoteOrDecline`, not
      silently accepted" — mock `updateMany` returning `count: 0`, assert the
      "expired" message and that no downstream phase-2/shortlist logic ran
- [ ] Existing quote/decline tests still pass with the mock shape updated from
      `update` to `updateMany`
- [ ] Commit.

---

## Task 6: Bidding closes — early resolution, `NOT_SELECTED`, admin deadline guard

**Files:**
- Modify: `src/rescue-request/dispatch.service.ts`

**Steps:**

- [ ] Write `closeBidding(rescueRequestId: string)`: marks all still-`PENDING`
      offers for the request `TIMED_OUT`, then calls the existing
      `sendQuoteShortlist` logic (rank `QUOTED` offers, send to the motorist).
      This is the single place both triggers below call into.
- [ ] `maybeResolveBatchEarly`, once phase 2 has started (i.e.
      `quoteCollectionDeadline` is set on the request), must check **all**
      `PENDING` offers for the request — not just the current `batchId` — and
      call `closeBidding` when none remain. Before phase 2 (deadline null) it
      keeps its current per-batch behaviour from Task 2.
- [ ] The deadline-close timer scheduled in Task 4 calls `closeBidding` when
      it fires.
- [ ] Quotes arriving after `closeBidding` has run (i.e. the request is no
      longer `DISPATCHING`, or an equivalent already-closed check) are marked
      `NOT_SELECTED` instead of `QUOTED`, and the operator is told the job has
      moved to selection rather than getting the normal "quote submitted"
      reply.
- [ ] Add the deadline guard to `expandRadiusNow` and `manualOfferToOperator`:
      both throw `BadRequestException` when
      `quoteCollectionDeadline && now >= quoteCollectionDeadline`, in addition
      to their existing `status !== DISPATCHING` check.

**Testing:**
- [ ] "early resolution still works in phase 2": deadline set to 5 minutes out,
      every outstanding offer answered at t=40s → shortlist sent at t=40s
      (assert `closeBidding`/shortlist logic invoked without advancing fake
      timers to the deadline) — **the regression this task must not
      reintroduce**
- [ ] "bidding closes: a quote arriving after the deadline is `NOT_SELECTED`"
- [ ] "expand/manual-assign refused after bidding closes" — deadline passed,
      `RescueRequest.status` still `DISPATCHING` — both throw
- [ ] Commit.

---

## Task 7: Delete the retry delay

**Files:**
- Modify: `src/rescue-request/dispatch.service.ts`

**Steps:**

- [ ] Delete `retryTimers` (the `Map` field), the `DISPATCH_RETRY_MINUTES`
      constant, and the `setTimeout` block in `startDispatch`'s no-candidates
      branch that schedules the delayed retry.
- [ ] Replace it with an immediate call: when no candidates exist at the
      current radius, expand the radius and call `startDispatch` again in the
      same tick (no timer).
- [ ] Confirm this path still respects the phase-1/phase-2 split from Task 3
      of the standalone fix — this is automatic continuation, so it must
      still no-op once `quoteCollectionDeadline` is set (i.e. don't
      accidentally make it fire during phase 2).

**Testing:**
- [ ] "no retry delay": a round resolving with no quotes and no remaining
      candidates expands and dispatches on the same tick — assert no
      `setTimeout` was scheduled and `startDispatch` was called again
      immediately (fake timers: advancing 0ms is enough to see the effect,
      not `DISPATCH_RETRY_MINUTES`-worth of time)
- [ ] Delete or update any prior test asserting the old delayed-retry
      behaviour.
- [ ] Commit.

---

## Task 8: UI — 30-second expand guard, config screen fields

**Files:**
- Modify (frontend): `lrr-web` — dispatch board component (wherever the
  Expand button lives) and the platform-config form from Task 3

**Steps:**

- [ ] On the dispatch board, when a request's `quoteCollectionDeadline` is
      present and less than 30 seconds from now, disable the Expand button.
      Client-side only, per the spec's explicit reasoning — do not add a
      server-side block for this one.
- [ ] Confirm the two config fields added in Task 3 render, validate, and
      save correctly in the running admin UI (manual check — this is a good
      point to actually click through it, per the project's UI-testing
      convention, rather than trusting a unit test alone).

**Testing:**
- [ ] Component test: button disabled when deadline is <30s out, enabled
      otherwise and when deadline is null (phase 1).
- [ ] Commit.

---

## Final check

- [ ] Full `lrr-service` jest suite green, `tsc --noEmit` clean, no
      `--forceExit` needed anywhere.
- [ ] Re-read the spec's "Explicitly not doing" section — confirm nothing in
      this plan accidentally built one of those.
- [ ] Watch staging for one real dispatch cycle before considering this done —
      this touches money-adjacent logic (quote selection) and has no
      integration tests against real Postgres, per this codebase's known
      limitation on `NULL`/conditional-write semantics.
