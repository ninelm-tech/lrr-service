# Non-WhatsApp Operator Manual Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator business register and work jobs with no WhatsApp on their phone — automatic dispatch stays WhatsApp-only and unchanged for everyone else; a non-WhatsApp operator is only ever reached, by a staff phone call, after automatic dispatch has genuinely exhausted every WhatsApp-capable candidate.

**Architecture:** One boolean on `Operator` (`whatsappEnabled`) partitions candidate search; one boolean on `RescueRequest` (`needsManualAssignment`) flags a request that fell through to the non-WhatsApp fallback. Every WhatsApp send directed at an operator gets a guard. The existing `assignOperator` manual override does double duty as the confirmation step — it gains one precondition, not a new endpoint. Two new small endpoints (`manual-arrived`, `manual-done`) extract the customer-facing half of the existing WhatsApp ARRIVED/DONE handlers so a staff action and an operator's own WhatsApp message produce identical downstream effects.

**Tech Stack:** NestJS + Prisma (lrr-service), Next.js (lrr-web), Twilio WhatsApp, Jest (unit + real-Postgres integration tests).

**Spec:** `docs/superpowers/specs/2026-09-19-non-whatsapp-operator-manual-dispatch-design.md`

## Global Constraints

- `Operator.whatsappEnabled` and `RescueRequest.needsManualAssignment` are both `Boolean @default(...)`, additive, no backfill — every existing row keeps today's behavior.
- The customer's own side of the flow (WhatsApp messages, location, deposit/balance payment) never changes, regardless of which kind of operator is on the job.
- Automatic dispatch (`findAndRankCandidates` called with no explicit `whatsappOnly` argument, or `true`) never returns a `whatsappEnabled: false` operator. A non-WhatsApp operator can only be reached via the manual-fallback path.
- A `whatsappEnabled: false` operator can only be assigned to a request already flagged `needsManualAssignment: true` — enforced atomically in `assignOperator`'s assignment transaction, not just in the UI or in a pre-transaction read.
- `needsManualAssignment` means "staff action is required right now," not history. Every transition to `CANCELLED`, regardless of entry point, clears it.
- Manual ARRIVED/DONE transitions use conditional writes inside one transaction; a read-then-write controller check is not a concurrency guard.
- The mandatory completion-evidence rule (photo/video before a job can be marked done) stays universal and untouched for WhatsApp operators. Non-WhatsApp jobs are explicitly exempt, verified by phone instead — this is a deliberate, permanent product decision, not a temporary gap.
- No new DB column beyond the two named above — both staff-facing "needs attention" states (needs assignment; deposit paid, dispatch now) are derived from existing fields at render/query time, never persisted separately.

---

### Task 1: Schema migration — `whatsappEnabled` and `needsManualAssignment`

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_non_whatsapp_operator_manual_dispatch/migration.sql`

**Interfaces:**
- Produces: `Operator.whatsappEnabled: boolean` (Prisma), `RescueRequest.needsManualAssignment: boolean` (Prisma) — consumed by every later task.

- [ ] **Step 1: Add the two fields to the schema**

In `prisma/schema.prisma`, add to `model Operator` (near the other plain scalar fields, e.g. next to `isAvailable`):
```prisma
whatsappEnabled Boolean @default(true)
```
Add to `model RescueRequest` (near `dispatchRound`):
```prisma
needsManualAssignment Boolean @default(false)
```

- [ ] **Step 2: Generate the migration**

Run: `npx prisma migrate dev --name non_whatsapp_operator_manual_dispatch --create-only`

Confirm the generated SQL matches exactly:
```sql
-- AlterTable
ALTER TABLE "Operator" ADD COLUMN     "whatsappEnabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "RescueRequest" ADD COLUMN     "needsManualAssignment" BOOLEAN NOT NULL DEFAULT false;
```
If Prisma generates something different (e.g. combines into one file in a different order), that's fine as long as both `ALTER TABLE` statements are present with these exact column definitions.

- [ ] **Step 3: Apply the migration**

Run: `npx prisma migrate dev`
Run: `npx prisma generate`

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit`
Expected: clean (the new fields aren't referenced by any code yet, so this just confirms the Prisma client regenerated correctly).

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "Add whatsappEnabled and needsManualAssignment columns"
```

---

### Task 2: `OperatorService.findAndRankCandidates` gains a `whatsappOnly` filter

**Files:**
- Modify: `src/operator/operator.service.ts:335-354`
- Test: `src/operator/operator.service.spec.ts`

**Interfaces:**
- Consumes: `Operator.whatsappEnabled` (Task 1).
- Produces: `OperatorService.findAndRankCandidates(latitude, longitude, excludeIds?, extraRadiusKm?, type?, truckClasses?, whatsappOnly: boolean = true): Promise<ScoredOperator[]>` — the 7th parameter is new; every existing call site (`operator.service.ts:456`, `dispatch.service.ts:549`) is unaffected by omitting it.

- [ ] **Step 1: Write the failing test**

In `src/operator/operator.service.spec.ts`, find the `describe('findAndRankCandidates ...')` block (there's existing coverage around lines 337-363) and add:
```ts
it('defaults to WhatsApp-only candidates when whatsappOnly is omitted', async () => {
  prisma.operator.findMany.mockResolvedValue([]);

  await service.findAndRankCandidates(6.5, 3.4, [], 0, undefined, []);

  expect(prisma.operator.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({ whatsappEnabled: true }),
    }),
  );
});

it('searches only non-WhatsApp operators when whatsappOnly is false', async () => {
  prisma.operator.findMany.mockResolvedValue([]);

  await service.findAndRankCandidates(6.5, 3.4, [], 0, undefined, [], false);

  expect(prisma.operator.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({ whatsappEnabled: false }),
    }),
  );
});
```
Check the existing `prisma` mock in this spec file already stubs `operator.findMany` — if the mock's return shape needs `latitude`/`longitude`/`serviceRadius` fields to avoid a crash in the in-range filter downstream, `mockResolvedValue([])` (empty array) sidesteps that entirely, matching the existing tests' style in this block.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/operator/operator.service.spec.ts -t "whatsappOnly"`
Expected: FAIL — `whatsappEnabled` not present in the actual `where` clause yet.

- [ ] **Step 3: Implement**

In `src/operator/operator.service.ts`, change the signature (line 335) and the `where` clause (inside the `findMany` call that starts at line 343):
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
  // ...rest of the method (in-range filter, scoring) is unchanged...
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/operator/operator.service.spec.ts`
Expected: PASS, including every pre-existing test in this file (the default-parameter change is backward compatible for the two existing call sites that don't pass a 7th argument).

- [ ] **Step 5: Full suite, lint, commit**

```bash
npx jest --silent
npx eslint "{src,apps,libs,test}/**/*.ts" --max-warnings 525
git add src/operator/operator.service.ts src/operator/operator.service.spec.ts
git commit -m "Add whatsappOnly filter to findAndRankCandidates"
```

---

### Task 3: `DispatchService.resolveExhaustion` — the shared manual-fallback resolver

**Files:**
- Modify: `src/rescue-request/dispatch.service.ts` (new method; `startDispatch` at lines 825-908 rewritten)
- Test: `src/rescue-request/dispatch.service.spec.ts`

**Interfaces:**
- Consumes: `OperatorService.findAndRankCandidates(..., whatsappOnly)` (Task 2).
- Produces: `DispatchService.resolveExhaustion(tx, rescueRequest, exhausted): Promise<ExhaustionResolution>` where `ExhaustionResolution = { outcome: 'manual-fallback'; candidateId: string } | { outcome: 'cancelled'; reason: 'no-coverage' | 'rounds-exhausted'; round: number }` — consumed by `startDispatch` in this task and by `BatchResolveCheck.resolve` in Task 4. **Not `private`** — Task 4's `BatchResolveCheck` calls it as `this.dispatchService.resolveExhaustion(...)` on its own injected `DispatchService` instance.
- Extends `PrepareNextRoundResult`'s exhausted variant with `extraRadiusKm`. Both exhausted returns preserve the actual final expansion so fallback searches the same geographic envelope that automatic dispatch exhausted.

- [ ] **Step 1: Write the failing tests**

In `src/rescue-request/dispatch.service.spec.ts`, find or create a `describe('resolveExhaustion', ...)` block. Check this file's existing mock-setup pattern for `DispatchService` first (search for an existing `describe` block that constructs the service, e.g. via `Test.createTestingModule` or direct `new DispatchService(...)`) and match it exactly — this service's constructor is `(prisma, twilioService, operatorService, platformConfigService, sessionStore, sharedService, operatorMembershipService)`. Add:
```ts
describe('resolveExhaustion', () => {
  const baseRescueRequest = {
    id: 'req-1',
    latitude: 6.5 as unknown as Prisma.Decimal,
    longitude: 3.4 as unknown as Prisma.Decimal,
    vehicleType: null,
    offeredOperatorIds: ['op-already-offered'],
    customerId: 'cust-1',
  };

  it('flags manual-fallback and does not cancel when a non-WhatsApp candidate exists', async () => {
    jest
      .spyOn(operatorService, 'findAndRankCandidates')
      .mockResolvedValue([{ id: 'op-backup' } as any]);
    const tx = {
      rescueRequest: { update: jest.fn() },
      dispatchOffer: { updateMany: jest.fn() },
      whatsAppSession: { updateMany: jest.fn() },
    } as any;

    const result = await service.resolveExhaustion(
      tx,
      baseRescueRequest,
      { reason: 'rounds-exhausted', round: 5, extraRadiusKm: 8 },
    );

    expect(operatorService.findAndRankCandidates).toHaveBeenCalledWith(
      6.5,
      3.4,
      ['op-already-offered'],
      8,
      undefined,
      undefined,
      false,
    );
    expect(result).toEqual({ outcome: 'manual-fallback', candidateId: 'op-backup' });
    expect(tx.rescueRequest.update).toHaveBeenCalledWith({
      where: { id: 'req-1' },
      data: { needsManualAssignment: true, dispatchRound: 5 },
    });
    expect(tx.dispatchOffer.updateMany).not.toHaveBeenCalled();
    expect(tx.whatsAppSession.updateMany).not.toHaveBeenCalled();
  });

  it('cancels exactly as before when no candidate exists at all, for either reason', async () => {
    jest.spyOn(operatorService, 'findAndRankCandidates').mockResolvedValue([]);
    const tx = {
      rescueRequest: { update: jest.fn() },
      dispatchOffer: { updateMany: jest.fn() },
      whatsAppSession: { updateMany: jest.fn() },
    } as any;

    const result = await service.resolveExhaustion(
      tx,
      baseRescueRequest,
      { reason: 'no-coverage', round: 2, extraRadiusKm: 2 },
    );

    expect(result).toEqual({ outcome: 'cancelled', reason: 'no-coverage', round: 2 });
    expect(tx.rescueRequest.update).toHaveBeenCalledWith({
      where: { id: 'req-1' },
      data: { status: 'CANCELLED', needsManualAssignment: false, dispatchRound: 2 },
    });
    expect(tx.dispatchOffer.updateMany).toHaveBeenCalledWith({
      where: { rescueRequestId: 'req-1', status: 'PENDING' },
      data: { status: 'TIMED_OUT', respondedAt: expect.any(Date) },
    });
    expect(tx.whatsAppSession.updateMany).toHaveBeenCalledWith({
      where: { userId: 'cust-1' },
      data: { state: 'IDLE', rescueRequestId: null },
    });
  });
});
```

Add a regression test whose non-WhatsApp candidate is outside its base service
radius but inside `serviceRadius + extraRadiusKm`; it must produce
`manual-fallback`, not cancellation. Also test that both exhausted return sites
in `prepareNextRound` return their current `extraRadiusKm`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/rescue-request/dispatch.service.spec.ts -t "resolveExhaustion"`
Expected: FAIL — `resolveExhaustion` doesn't exist yet.

- [ ] **Step 3: Implement**

**First, make `prepareNextRound` itself actually return `extraRadiusKm`** —
the type change alone doesn't do this; its three existing `exhausted: true`
return statements need the field added. In `src/rescue-request/dispatch.service.ts`,
inside `prepareNextRound` (the pre-existing method — do not rewrite anything
else in it, only these three `return` statements):
```ts
// 1. Request-not-found early return, right after the initial findUnique —
//    no radius context exists yet at this point, so 0 is the correct value:
if (!rescueRequest) {
  return { offers: [], exhausted: true, reason: 'no-coverage', round, extraRadiusKm: 0 };
}
```
```ts
// 2. The coverage-gap fast-fail (inside the `for (;;)` loop, after the
//    nearbyOperatorCount === 0 check) — extraRadiusKm is already in scope:
if (nearbyOperatorCount === 0) {
  return {
    offers: [],
    exhausted: true,
    reason: 'no-coverage',
    round: attemptRound,
    extraRadiusKm,
  };
}
```
```ts
// 3. The rounds-cap exit (immediately after incrementing attemptRound) —
//    extraRadiusKm is already in scope here too:
if (attemptRound >= MAX_ROUNDS_BEFORE_AUTO_CANCEL) {
  return {
    offers: [],
    exhausted: true,
    reason: 'rounds-exhausted',
    round: attemptRound,
    extraRadiusKm,
  };
}
```

Then add the new `resolveExhaustion` method (anywhere in the class — near `prepareNextRound` makes sense) plus a new exported type near the top of the file:
```ts
type PrepareNextRoundResult =
  | { offers: PendingOffer[]; exhausted: false; round: number }
  | {
      offers: never[];
      exhausted: true;
      reason: 'no-coverage' | 'rounds-exhausted';
      round: number;
      extraRadiusKm: number;
    };

export type ExhaustionResolution =
  | { outcome: 'manual-fallback'; candidateId: string }
  | { outcome: 'cancelled'; reason: 'no-coverage' | 'rounds-exhausted'; round: number };
```
```ts
/**
 * What to do once prepareNextRound reports exhausted: true. Not private —
 * BatchResolveCheck (a separate class) calls this on its own injected
 * DispatchService the same way it already calls prepareNextRound. Must run
 * as part of the SAME transaction that observed `exhausted`, for the same
 * reason prepareNextRound's own docstring gives for cancelling in that
 * transaction: nothing else will ever revisit a DISPATCHING request with no
 * live offers and no flag set.
 */
async resolveExhaustion(
  tx: Prisma.TransactionClient,
  rescueRequest: {
    id: string;
    latitude: Prisma.Decimal;
    longitude: Prisma.Decimal;
    vehicleType: string | null;
    offeredOperatorIds: string[];
    customerId: string;
  },
  exhausted: {
    reason: 'no-coverage' | 'rounds-exhausted';
    round: number;
    extraRadiusKm: number;
  },
): Promise<ExhaustionResolution> {
  const eligibleTruckClasses = rescueRequest.vehicleType
    ? getEligibleTruckClasses(rescueRequest.vehicleType)
    : undefined;

  const backupCandidates = await this.operatorService.findAndRankCandidates(
    Number(rescueRequest.latitude),
    Number(rescueRequest.longitude),
    rescueRequest.offeredOperatorIds,
    exhausted.extraRadiusKm,
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
    data: {
      status: RescueRequestStatus.CANCELLED,
      needsManualAssignment: false,
      dispatchRound: exhausted.round,
    },
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

Now rewrite `startDispatch` (currently lines 825-908) to use it. Replace the `$transaction` block (lines 853-882) and the `if (outcome.exhausted)` branch (lines 884-892):
```ts
async startDispatch(rescueRequestId: string, customerId: string) {
  const rescueRequest = await this.prisma.rescueRequest.findUnique({
    where: { id: rescueRequestId },
    select: {
      status: true,
      dispatchRound: true,
      latitude: true,
      longitude: true,
      vehicleType: true,
      offeredOperatorIds: true,
    },
  });
  if (!rescueRequest) return;
  if (
    rescueRequest.status === RescueRequestStatus.CANCELLED ||
    rescueRequest.status === RescueRequestStatus.COMPLETED ||
    rescueRequest.status === RescueRequestStatus.OPERATOR_ASSIGNED ||
    rescueRequest.status === RescueRequestStatus.WAITING_FOR_DEPOSIT
  )
    return;

  const quotedCount = await this.prisma.dispatchOffer.count({
    where: { rescueRequestId, status: 'QUOTED' },
  });
  if (quotedCount > 0) {
    await this.deliverQuoteShortlist(rescueRequestId, customerId);
    return;
  }

  if (await this.isBiddingClosed(rescueRequestId)) return;

  const outcome = await this.prisma.$transaction(async (tx) => {
    const next = await this.prepareNextRound(tx, rescueRequestId, rescueRequest.dispatchRound);
    if (!next.exhausted) return next;

    const resolution = await this.resolveExhaustion(
      tx,
      { id: rescueRequestId, customerId, ...rescueRequest },
      {
        reason: next.reason,
        round: next.round,
        extraRadiusKm: next.extraRadiusKm,
      },
    );
    return { ...next, resolution };
  });

  if (outcome.exhausted) {
    if (outcome.resolution.outcome === 'manual-fallback') {
      console.warn(
        `Request ${rescueRequestId} flagged for manual assignment after round ${outcome.round} (no WhatsApp-capable operators left).`,
      );
      Sentry.captureMessage('Request flagged for manual (non-WhatsApp) assignment', {
        level: 'info',
        extra: { rescueRequestId, round: outcome.round },
      });
      return;
    }
    await this.notifyNoOperatorAvailable(rescueRequestId, customerId, outcome.reason, outcome.round);
    return;
  }

  if (outcome.round > MAX_FAILED_ROUNDS_BEFORE_ALERT) {
    const request = await this.prisma.rescueRequest.findUnique({
      where: { id: rescueRequestId },
      select: { latitude: true, longitude: true },
    });
    await this.alertAdminNoOperator(
      rescueRequestId,
      Number(request?.latitude ?? 0),
      Number(request?.longitude ?? 0),
      outcome.round,
    );
  }

  await this.deliverOffers(outcome.offers);
}
```
Add `import * as Sentry from '@sentry/node';` to this file's imports if not already present (check first — `dispatch.service.ts` likely already imports it given `alertAdminNoOperator`'s neighborhood; if it does, skip this).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/rescue-request/dispatch.service.spec.ts`
Expected: PASS, including every pre-existing `startDispatch` test in this file — the happy path and the "no candidates at all → cancel" path are both unchanged in observable behavior, just routed through the new shared method. If any pre-existing `prepareNextRound` test asserts its exhausted return value with strict equality (`toEqual`, not `toMatchObject`/`objectContaining`), it will now fail because of the added `extraRadiusKm` field — update those specific assertions to include it rather than loosening the match style, so the field's presence stays test-enforced.

- [ ] **Step 5: Full suite, lint, commit**

```bash
npx jest --silent
npx eslint "{src,apps,libs,test}/**/*.ts" --max-warnings 525
git add src/rescue-request/dispatch.service.ts src/rescue-request/dispatch.service.spec.ts
git commit -m "Add DispatchService.resolveExhaustion, wire into startDispatch"
```

---

### Task 4: Wire `resolveExhaustion` into `BatchResolveCheck`

**Files:**
- Modify: `src/rescue-request/reconciler/checks/batch-resolve.check.ts:159-181`
- Test: `src/rescue-request/reconciler/checks/batch-resolve.check.spec.ts`

**Interfaces:**
- Consumes: `DispatchService.resolveExhaustion` (Task 3).

- [ ] **Step 1: Read the current file's full `resolve` method and its test file's mock shape**

Run: `sed -n '76,213p' src/rescue-request/reconciler/checks/batch-resolve.check.ts` to see the whole `resolve` method around the `exhausted` branch (lines 159-181 shown in Task 3's research; the surrounding context — how `request` and `batch` are fetched — determines exactly what fields are available to pass into `resolveExhaustion`).
Run: `grep -n "dispatchService\|prisma\." src/rescue-request/reconciler/checks/batch-resolve.check.spec.ts | head -30` to see the existing mock shape for `dispatchService` in this spec file.

- [ ] **Step 2: Write the failing test**

In `src/rescue-request/reconciler/checks/batch-resolve.check.spec.ts`, find the existing test(s) covering the `exhausted` branch (search for `'CANCELLED'` or `exhausted`) and add a sibling test:
```ts
it('flags manual-fallback instead of cancelling when resolveExhaustion finds a non-WhatsApp candidate', async () => {
  // Reuse this file's existing setup for an expired PENDING offer whose
  // prepareNextRound call returns exhausted: true — check the existing
  // "cancels when exhausted" test in this file for the exact prisma mock
  // shape needed to reach the exhausted branch, and copy it here.
  dispatchService.prepareNextRound.mockResolvedValue({
    offers: [],
    exhausted: true,
    reason: 'rounds-exhausted',
    round: 3,
    extraRadiusKm: 4,
  });
  dispatchService.resolveExhaustion.mockResolvedValue({
    outcome: 'manual-fallback',
    candidateId: 'op-backup',
  });

  const acted = await check.run(new Date());

  expect(acted).toBe(1);
  expect(prisma.rescueRequest.update).not.toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ status: 'CANCELLED' }) }),
  );
});
```
Adapt the exact setup (how `expiredOffers`/`prisma.dispatchOffer.findMany` is mocked to produce one batch) to match whatever this file's existing "cancels when exhausted" test already does — do not invent a new setup shape, copy the established one and only change the `resolveExhaustion` mock and assertion.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest src/rescue-request/reconciler/checks/batch-resolve.check.spec.ts -t "manual-fallback"`
Expected: FAIL — `resolveExhaustion` isn't called yet, so the request still gets cancelled.

- [ ] **Step 4: Implement**

In `src/rescue-request/reconciler/checks/batch-resolve.check.ts`, replace the `exhausted` branch (lines 159-181) — this needs the full `request` row (latitude/longitude/vehicleType/offeredOperatorIds), so check what `request` already looks like earlier in `resolve()` (it's fetched before line 159 per the existing code, given `request.customerId` is already used at line 172) and extend that `select`/fetch if it doesn't already include these fields:
```ts
if (next.exhausted) {
  const resolution = await this.dispatchService.resolveExhaustion(
    tx,
    {
      id: batch.rescueRequestId,
      latitude: request.latitude,
      longitude: request.longitude,
      vehicleType: request.vehicleType,
      offeredOperatorIds: request.offeredOperatorIds,
      customerId: request.customerId,
    },
    {
      reason: next.reason,
      round: next.round,
      extraRadiusKm: next.extraRadiusKm,
    },
  );
  if (resolution.outcome === 'manual-fallback') {
    return {
      outcome: 'manual-fallback' as const,
      customerId: request.customerId,
      round: next.round,
    };
  }
  return {
    outcome: 'exhausted' as const,
    customerId: request.customerId,
    reason: resolution.reason,
    round: resolution.round,
  };
}
```
Check the caller of `resolve()` (inside `run()`, and wherever `resolve()`'s return value's `outcome` is consumed after the transaction — likely right after the `$transaction` call in `resolve()`, sending `notifyNoOperatorAvailable` for `'exhausted'`) and add a branch there too: `'manual-fallback'` sends no customer notification (mirroring `startDispatch`'s Task 3 change) — log/Sentry only, same shape as Task 3's `startDispatch` addition.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest src/rescue-request/reconciler/checks/batch-resolve.check.spec.ts`
Expected: PASS, including every pre-existing test — the "cancels when exhausted, no candidates" path is unchanged.

- [ ] **Step 6: Full suite, lint, commit**

```bash
npx jest --silent
npx eslint "{src,apps,libs,test}/**/*.ts" --max-warnings 525
git add src/rescue-request/reconciler/checks/batch-resolve.check.ts src/rescue-request/reconciler/checks/batch-resolve.check.spec.ts
git commit -m "Route BatchResolveCheck through the shared resolveExhaustion resolver"
```

---

### Task 5: `assignOperator` — backend enforcement, skip-send, clear the flag

**Files:**
- Modify: `src/rescue-request/rescue-request-admin.service.ts:116-318`
- Test: `src/rescue-request/rescue-request-admin.service.spec.ts`

**Interfaces:**
- Consumes: `Operator.whatsappEnabled`, `RescueRequest.needsManualAssignment` (Task 1).
- Produces: `assignOperator` now throws `BadRequestException` when the target operator has `whatsappEnabled: false` and the request isn't `needsManualAssignment: true`; the rule is repeated in the transaction's conditional claim so it cannot change between pre-check and write; on success, clears the flag; skips the operator-directed WhatsApp send (only) when `whatsappEnabled: false`.

- [ ] **Step 1: Write the failing tests**

In `src/rescue-request/rescue-request-admin.service.spec.ts`, find the `describe('assignOperator', ...)` block and add:
```ts
it('rejects a non-WhatsApp operator when the request is not flagged for manual assignment', async () => {
  prisma.operator.findUnique.mockResolvedValue({
    id: 'op-1',
    status: 'ACTIVE',
    whatsappEnabled: false,
  });
  prisma.rescueRequest.findUnique.mockResolvedValue({
    id: 'req-1',
    status: 'DISPATCHING',
    needsManualAssignment: false,
    customer: { phoneNumber: '+2348000000000' },
  });

  await expect(
    service.assignOperator('req-1', { operatorId: 'op-1', priceKobo: 500000 }),
  ).rejects.toThrow(
    'This operator has no WhatsApp on file — it can only be assigned to a request flagged for manual assignment.',
  );
  expect(prisma.$transaction).not.toHaveBeenCalled();
});

it('allows a non-WhatsApp operator once the request is flagged, and skips the operator WhatsApp send', async () => {
  prisma.operator.findUnique.mockResolvedValue({
    id: 'op-1',
    status: 'ACTIVE',
    whatsappEnabled: false,
    businessName: 'Backup Towing',
    phoneNumber: '+2348011111111',
  });
  prisma.rescueRequest.findUnique.mockResolvedValueOnce({
    id: 'req-1',
    status: 'DISPATCHING',
    needsManualAssignment: true,
    dispatchRound: 3,
    customerId: 'cust-1',
    customer: { phoneNumber: '+2348000000000' },
  });
  // ...mock the rest of the happy path exactly as this file's existing
  // "assigns successfully" test already does (paymentLedger, paystackService,
  // the post-transaction rescueRequest.findUnique for `updated`) — copy that
  // setup rather than reinventing it.

  await service.assignOperator('req-1', { operatorId: 'op-1', priceKobo: 500000 });

  expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledTimes(1); // customer only
  expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalledWith(
    '+2348011111111',
    expect.anything(),
  );
});

it('clears needsManualAssignment on successful assignment', async () => {
  // Same setup as the previous test, or the existing WhatsApp-enabled
  // happy-path test — either operator type should clear the flag.
  // Assert the `tx.rescueRequest.updateMany` (the `claimed` call) includes
  // `needsManualAssignment: false` in its `data`.
});

it('does not assign when the manual flag is cleared between the pre-check and transactional claim', async () => {
  // Use a non-WhatsApp operator and an initial request read with
  // needsManualAssignment: true, then make tx.rescueRequest.updateMany return
  // count: 0. Assert no payment/provider call or notification follows.
});

it('is completely unaffected for a WhatsApp-enabled operator regardless of needsManualAssignment', async () => {
  prisma.operator.findUnique.mockResolvedValue({
    id: 'op-1',
    status: 'ACTIVE',
    whatsappEnabled: true,
    businessName: 'Normal Towing',
    phoneNumber: '+2348011111111',
  });
  prisma.rescueRequest.findUnique.mockResolvedValueOnce({
    id: 'req-1',
    status: 'DISPATCHING',
    needsManualAssignment: false,
    customerId: 'cust-1',
    customer: { phoneNumber: '+2348000000000' },
  });
  // ...rest of happy-path mocks, matching the file's existing pattern...

  await expect(
    service.assignOperator('req-1', { operatorId: 'op-1', priceKobo: 500000 }),
  ).resolves.toBeDefined();
});
```
Check this file's existing `describe('assignOperator', ...)` block for its established mock shape (how `prisma.operator.findUnique`/`prisma.rescueRequest.findUnique`/`prisma.$transaction`/`paymentLedger`/`paystackService`/`twilioService` are already stubbed for the happy path) and reuse it exactly — do not invent a different shape. The `prisma.rescueRequest.findUnique` mock needs `needsManualAssignment` and `whatsappEnabled`-adjacent fields added to whatever object it already returns.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/rescue-request/rescue-request-admin.service.spec.ts -t "assignOperator"`
Expected: FAIL on the new tests — the guard doesn't exist, the send isn't conditional, the flag isn't cleared, and the transactional claim does not yet enforce the manual flag.

- [ ] **Step 3: Implement**

In `src/rescue-request/rescue-request-admin.service.ts`, add the request lookup's `select`/fields needed (the existing `request` lookup at lines 133-136 already does `include: { customer: true }` with no explicit `select`, so `needsManualAssignment` is already included by default — no change needed there). Right after the existing operator-status check (after line 131, before the `request` lookup at line 133):

Actually — insert the new guard right after BOTH lookups exist (it needs `request.needsManualAssignment`), so place it right after line 154 (`if (!request.customer.phoneNumber) {...}` block ends) and before line 156 (`const config = ...`):
```ts
if (!operator.whatsappEnabled && !request.needsManualAssignment) {
  throw new BadRequestException(
    'This operator has no WhatsApp on file — it can only be assigned to a request flagged for manual assignment.',
  );
}
```

Change the `claimed` update (lines 190-205) to also clear the flag:
```ts
const claimed = await tx.rescueRequest.updateMany({
  where: {
    id,
    status: request.status,
    assignedOperatorId: request.assignedOperatorId,
    ...(!operator.whatsappEnabled && { needsManualAssignment: true }),
  },
  data: {
    assignedOperatorId: dto.operatorId,
    status: RescueRequestStatus.WAITING_FOR_DEPOSIT,
    needsManualAssignment: false,
    serviceFeeAmount,
    depositAmount,
    balanceAmount,
    depositWindowExpiresAt,
    depositRemindersSent: 0,
  },
});
```
Keep the friendly pre-transaction check for a precise error, but treat the
conditional claim as authoritative. If it returns `count: 0`, re-read enough
state to distinguish a stale request from a cleared manual flag and throw a
`BadRequestException`; do not continue to payment creation or Paystack.

Change the operator-directed send (currently line 312, unconditional) to be guarded — the surrounding code (lines 300-314):
```ts
const customerPhone = toWhatsAppAddress(request.customer.phoneNumber);
const operatorPhone = toWhatsAppAddress(operator.phoneNumber!);
const depositNaira = (depositAmount / 100).toLocaleString();
const balanceNaira = (balanceAmount / 100).toLocaleString();

void this.twilioService.sendWhatsAppMessage(
  customerPhone,
  `🚗 *Operator assigned!*\n\nBusiness: ${operator.businessName}\n💰 Deposit: *₦${depositNaira}* now · ₦${balanceNaira} balance on completion\n\n⚠️ *ACTION NEEDED* — tap the link below to pay and confirm. You have *30 minutes*:\n\n👉 ${checkoutUrl}\n\nReply CANCEL to cancel (no charge).`,
);
if (operator.whatsappEnabled) {
  void this.twilioService.sendWhatsAppMessage(
    operatorPhone,
    `🚗 You've been assigned a job (₦${(dto.priceKobo / 100).toLocaleString()}). Waiting for the customer to confirm payment.`,
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/rescue-request/rescue-request-admin.service.spec.ts`
Expected: PASS, including every pre-existing test in this file.

- [ ] **Step 5: Full suite, lint, commit**

```bash
npx jest --silent
npx eslint "{src,apps,libs,test}/**/*.ts" --max-warnings 525
git add src/rescue-request/rescue-request-admin.service.ts src/rescue-request/rescue-request-admin.service.spec.ts
git commit -m "Enforce non-WhatsApp assignment only on manually-flagged requests"
```

---

### Task 6: Guard operator-directed WhatsApp sends — `payment-events.service.ts`

**Files:**
- Modify: `src/rescue-request/payment-events.service.ts:142,238,242` (see exact context below)
- Test: `src/rescue-request/payment-events.service.spec.ts`

**Interfaces:**
- Consumes: `Operator.whatsappEnabled` (Task 1).

- [ ] **Step 1: Read the current surrounding code**

Run: `sed -n '55,150p' src/rescue-request/payment-events.service.ts` (the `confirmDeposit` method, containing line 142's send) and `sed -n '178,250p' src/rescue-request/payment-events.service.ts` (the `confirmBalance` method, containing lines 238/242's sends) to confirm the exact current variable names holding the operator record in scope at each site (line numbers may have shifted slightly from the research pass — re-read before editing).

- [ ] **Step 2: Write the failing tests**

In `src/rescue-request/payment-events.service.spec.ts`, find the existing `describe('confirmDeposit', ...)` and `describe('confirmBalance', ...)` blocks and add, in each:
```ts
it('skips the operator WhatsApp notification when the operator has no WhatsApp on file', async () => {
  // Reuse this test file's existing happy-path setup, but with the
  // operator record's whatsappEnabled: false.
  // ...
  expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalledWith(
    expect.stringContaining(operatorPhoneUsedInThisTest),
    expect.anything(),
  );
});
```
Write one such test per method (`confirmDeposit`, `confirmBalance` — the latter covers both the "payment received" and "rate the customer" sends in one pass since they're both operator-directed and adjacent).

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx jest src/rescue-request/payment-events.service.spec.ts -t "skips the operator"`
Expected: FAIL — sends aren't guarded yet.

- [ ] **Step 4: Implement**

Wrap each of the three operator-directed sends (the "job is live" notification in `confirmDeposit`, and the "payment received" + "rate the customer" sends in `confirmBalance`) in `if (operator.whatsappEnabled) { ... }`, using whatever the operator variable is actually named at each site (confirmed in Step 1). Do not touch any customer-directed send in this file.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest src/rescue-request/payment-events.service.spec.ts`
Expected: PASS, including every pre-existing test.

- [ ] **Step 6: Full suite, lint, commit**

```bash
npx jest --silent
npx eslint "{src,apps,libs,test}/**/*.ts" --max-warnings 525
git add src/rescue-request/payment-events.service.ts src/rescue-request/payment-events.service.spec.ts
git commit -m "Guard operator-directed WhatsApp sends in payment-events.service"
```

---

### Task 7: Guard operator-directed WhatsApp sends and disable masked chat — `whatsapp-customer-flow.service.ts`

**Files:**
- Modify: `src/rescue-request/whatsapp-customer-flow.service.ts:114,146,379,728,1128` (see exact context below)
- Test: `src/rescue-request/whatsapp-customer-flow.service.spec.ts`

**Interfaces:**
- Consumes: `Operator.whatsappEnabled` (Task 1).

- [ ] **Step 1: Read the current surrounding code for each of the five sites**

Run: `sed -n '100,155p' src/rescue-request/whatsapp-customer-flow.service.ts` (relay-forward + chat-driver-start), `sed -n '340,390p'` (CANCEL-command handler), `sed -n '700,735p'` (endChatRelay), `sed -n '970,1135p'` (handleQuoteSelected's losing-bidder loop) — confirm exact current line numbers and the operator-record variable name in scope at each (this file has had several unrelated edits today; line numbers WILL have shifted from the research pass's snapshot — re-read before editing each site).

- [ ] **Step 2: Write the failing tests**

In `src/rescue-request/whatsapp-customer-flow.service.spec.ts`, add one test per site to its corresponding existing `describe` block (relay-forward, chat-driver, CANCEL, end-chat-relay, quote-selection), each asserting `twilioService.sendWhatsAppMessage` is NOT called with the non-WhatsApp operator's phone when `whatsappEnabled: false`, following this file's existing per-block mock conventions (checked and confirmed exact per this session's memory: this file has several distinct `describe` blocks each with their own `beforeEach`/mock shape — match whichever block each test lands in, don't assume one shape fits all).

The `CHAT DRIVER` and relay-forward tests must assert behavior, not merely a
missing send:

- `CHAT DRIVER` for a non-WhatsApp assigned operator returns a clear message
  such as “Chat isn't available for this operator; please contact LRR support,”
  does not call `findOrCreateCustomer`, and does not set either participant's
  `relayTarget`.
- A stale customer session already carrying `relayTarget: 'OPERATOR'` for a
  non-WhatsApp operator clears the customer's relay state and returns the same
  unavailable message; it must not silently swallow the customer's text.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx jest src/rescue-request/whatsapp-customer-flow.service.spec.ts -t "no WhatsApp"`
Expected: FAIL — five new tests, sends not yet guarded.

- [ ] **Step 4: Implement**

For CANCEL, end-chat, and quote-selection notifications, guard/filter the
operator-directed send using `operator.whatsappEnabled` as appropriate.

`CHAT DRIVER` is different and must branch before creating the operator-side
User or writing either relay session. When the assigned operator has
`whatsappEnabled: false`, return the unavailable-chat response immediately.
In the existing relay-forward branch, load `assignedOperator.whatsappEnabled`;
if false, clear the customer's stale `relayTarget` and return the unavailable
response instead of silently dropping the message. Never create or preserve a
half-open relay for an off-platform operator.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest src/rescue-request/whatsapp-customer-flow.service.spec.ts`
Expected: PASS, including every pre-existing test in this file.

- [ ] **Step 6: Full suite, lint, commit**

```bash
npx jest --silent
npx eslint "{src,apps,libs,test}/**/*.ts" --max-warnings 525
git add src/rescue-request/whatsapp-customer-flow.service.ts src/rescue-request/whatsapp-customer-flow.service.spec.ts
git commit -m "Guard operator-directed WhatsApp sends in whatsapp-customer-flow.service"
```

---

### Task 8: Guard operator-directed WhatsApp sends — `dispatch.service.ts`

**Files:**
- Modify: `src/rescue-request/dispatch.service.ts` (`sendDispatchOfferMessage` at ~103-179; `notifyPendingOperatorsOfCountdown` at ~397-440; `manualOfferToOperator` at ~1070-1180)
- Test: `src/rescue-request/dispatch.service.spec.ts`

**Interfaces:**
- Consumes: `Operator.whatsappEnabled` (Task 1).

- [ ] **Step 1: Read the current surrounding code**

Run: `sed -n '90,180p' src/rescue-request/dispatch.service.ts` (`sendDispatchOfferMessage` — the shared low-level send helper both `deliverOffers` and `manualOfferToOperator` call through), `sed -n '395,440p'` (countdown-warning loop), `sed -n '1065,1180p'` (`manualOfferToOperator`).

**Note on scope:** `sendDispatchOfferMessage` itself is reached two ways — (a) through `deliverOffers`, fed only by `resolveExhaustion`'s WhatsApp-only candidate search (Task 3), so it can never actually receive a non-WhatsApp operator through that path; (b) through `manualOfferToOperator`, a *different*, pre-existing admin action (`POST :id/offer-to/:operatorId`) that takes a raw `operatorId` with no filter at all — this one genuinely can reach a non-WhatsApp operator today. Guard at the `manualOfferToOperator` level (Step 3 below) rather than inside the shared helper, since offering (not assigning) a job to a non-WhatsApp operator makes no sense at all — they have no channel to respond through — so this is a reject, not a silent skip.

- [ ] **Step 2: Write the failing tests**

In `src/rescue-request/dispatch.service.spec.ts`, find or add a `describe('manualOfferToOperator', ...)` block:
```ts
it('rejects offering a job to a non-WhatsApp operator — use assignOperator instead', async () => {
  prisma.operator.findUnique.mockResolvedValue({
    id: 'op-1',
    whatsappEnabled: false,
    phoneNumber: '+2348011111111',
  });

  await expect(
    service.manualOfferToOperator('req-1', 'op-1'),
  ).rejects.toThrow(
    'This operator has no WhatsApp on file — use "Assign this operator" instead of offering.',
  );
  expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalled();
});
```
Also add, to the countdown-warning test coverage (find the existing `describe` for `notifyPendingOperatorsOfCountdown` or the method that calls it):
```ts
it('does not warn a non-WhatsApp operator whose offer is still pending', async () => {
  // Reuse the existing countdown test's setup with one PENDING offer's
  // operator set to whatsappEnabled: false.
  // ...
  expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx jest src/rescue-request/dispatch.service.spec.ts -t "non-WhatsApp"`
Expected: FAIL.

- [ ] **Step 4: Implement**

In `manualOfferToOperator`, right after the existing operator lookup, add:
```ts
if (!operator.whatsappEnabled) {
  throw new BadRequestException(
    'This operator has no WhatsApp on file — use "Assign this operator" instead of offering.',
  );
}
```
In `notifyPendingOperatorsOfCountdown`, filter the pending-offers list to `whatsappEnabled` operators before building the `Promise.allSettled` send list (confirm this query already includes/selects `operator.whatsappEnabled` in its Prisma call — add it if not).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest src/rescue-request/dispatch.service.spec.ts`
Expected: PASS, including every pre-existing test.

- [ ] **Step 6: Full suite, lint, commit**

```bash
npx jest --silent
npx eslint "{src,apps,libs,test}/**/*.ts" --max-warnings 525
git add src/rescue-request/dispatch.service.ts src/rescue-request/dispatch.service.spec.ts
git commit -m "Guard remaining operator-directed WhatsApp sends in dispatch.service"
```

---

### Task 8A: Block non-WhatsApp operators at the inbound WhatsApp router

**Files:**
- Modify: `src/rescue-request/whatsapp-inbound.service.ts`
- Test: `src/rescue-request/whatsapp-inbound.service.spec.ts`

**Source correction:** this file contains no operator-directed outbound send,
so there is no send call to wrap. It does, however, route any matching Operator
phone into `WhatsAppOperatorFlowService`, which would let an operator registered
as off-platform drive ARRIVED/DONE and other operator commands over WhatsApp.
That contradicts the manual-control model and is the reason this design's
inventory named the file.

- [ ] **Step 1: Write the failing test**

Add a test where `operator.findUnique` returns an operator with
`whatsappEnabled: false`. Assert `operatorFlow.handleOperatorMessage` and
`customerFlow.handleCustomerMessage` are both untouched, and the router returns
a clear inert TwiML response telling the sender that this operator line is not
WhatsApp-enabled and to contact LRR staff. Add a sibling test proving a
WhatsApp-enabled operator still routes exactly as before.

- [ ] **Step 2: Implement**

Immediately after the Operator lookup and before the existing operator-flow
call, branch on `operatorRecord.whatsappEnabled === false` and return the inert
reply. Do not route the same phone into the customer flow: that would create a
second identity/behavior for a registered operator number. Use the project's
existing TwiML response helper or inject the smallest equivalent response in
this router, matching current inbound tests.

- [ ] **Step 3: Verify and commit**

```bash
npx jest src/rescue-request/whatsapp-inbound.service.spec.ts
npx jest --silent
npx eslint "{src,apps,libs,test}/**/*.ts" --max-warnings 525
git add src/rescue-request/whatsapp-inbound.service.ts src/rescue-request/whatsapp-inbound.service.spec.ts
git commit -m "Block off-platform operators from the WhatsApp command flow"
```

---

### Task 8B: Clear `needsManualAssignment` on every cancellation path

**Files:**
- Modify every RescueRequest writer that sets `status: CANCELLED`, currently:
  `dispatch.service.ts`, `whatsapp-customer-flow.service.ts`,
  `rescue-request-admin.service.ts`, `reconciler/checks/batch-resolve.check.ts`,
  `reconciler/checks/deposit-expiry.check.ts`, and
  `reconciler/checks/quote-selection-timeout.check.ts`
- Test each owning service/check's existing spec

- [ ] **Step 1: Add regression coverage**

At minimum cover the live routes that can cancel a manually flagged
`DISPATCHING` request: customer `CANCEL`, admin `cancel`, admin `updateStatus`,
and the stale-request replacement path. Assert every cancellation update writes
both `status: CANCELLED` and `needsManualAssignment: false`. Also update the
existing reconciler/dispatch cancellation assertions so the invariant applies
to every writer, even where a true flag is not normally reachable today.

- [ ] **Step 2: Implement the invariant**

Every Prisma `update`/`updateMany` that transitions a RescueRequest to
`CANCELLED` must include `needsManualAssignment: false` in the same write. Do
not clear it afterward in a second statement.

- [ ] **Step 3: Verify and commit**

Run the focused specs for all touched services/checks, then the full unit suite
and lint. Commit the invariant as one change so a future cancellation path can
copy the established shape.

---

### Task 9: Extract `notifyCustomerOperatorArrived`; add `startManualCompletionConfirmation`

**Files:**
- Modify: `src/rescue-request/whatsapp-operator-flow.service.ts:554-679`
- Test: `src/rescue-request/whatsapp-operator-flow.service.spec.ts`

**Interfaces:**
- Produces: `WhatsAppOperatorFlowService.notifyCustomerOperatorArrived(rescueRequestId: string): Promise<void>` (public, notification-only — no status write; shared between `handleOperatorArrived`'s unconditional WhatsApp-path write and, Task 10, the new controller's atomic conditional claim) and `WhatsAppOperatorFlowService.startManualCompletionConfirmation(rescueRequestId: string): Promise<{claimed: boolean}>` (public, manual-only, self-contained atomic — owns its own conditional claim internally; NOT called by `handleOperatorJobDone`, which keeps requiring completion media exactly as today).

- [ ] **Step 1: Write the failing tests**

In `src/rescue-request/whatsapp-operator-flow.service.spec.ts`, add:
```ts
describe('notifyCustomerOperatorArrived', () => {
  it('notifies the customer — does NOT write status itself', async () => {
    prisma.rescueRequest.findUnique.mockResolvedValue({
      id: 'req-1',
      customer: { phoneNumber: '+2348000000000' },
      assignedOperator: { businessName: 'Swift Towing' },
    });

    await service.notifyCustomerOperatorArrived('req-1');

    // Deliberately not asserted as `not.toHaveBeenCalled()` — this method
    // is pure notification. The status write is each caller's own
    // responsibility (see below): the WhatsApp path's unconditional write
    // (already gated by its own session-state check) and the manual
    // path's atomic conditional claim (Task 10) are NOT the same operation
    // and must not be collapsed into one shared write here — doing so is
    // exactly the bug an earlier draft of this plan had, where a shared
    // unconditional write made the manual path's claim redundant-but-racy.
    expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
      '+2348000000000',
      expect.stringContaining('arrived'),
    );
  });

  it('does nothing when the request no longer exists', async () => {
    prisma.rescueRequest.findUnique.mockResolvedValue(null);

    await service.notifyCustomerOperatorArrived('req-1');

    expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalled();
  });
});

describe('startManualCompletionConfirmation', () => {
  it('claims ARRIVED→confirmation atomically, moves the customer session, and sends the confirm prompt with no media check', async () => {
    prisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(prisma));
    prisma.rescueRequest.updateMany.mockResolvedValue({ count: 1 });
    prisma.rescueRequest.findUnique.mockResolvedValue({
      customerId: 'cust-1',
      customer: { phoneNumber: '+2348000000000' },
      assignedOperator: { businessName: 'Swift Towing' },
    });

    const result = await service.startManualCompletionConfirmation('req-1');

    expect(result).toEqual({ claimed: true });
    expect(prisma.rescueRequest.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'req-1',
        status: 'ARRIVED',
        assignedOperator: { whatsappEnabled: false },
      },
      data: { confirmationDueAt: expect.any(Date) },
    });
    expect(prisma.whatsAppSession.updateMany).toHaveBeenCalledWith({
      where: { userId: 'cust-1' },
      data: { state: 'AWAITING_COMPLETION_CONFIRM', rescueRequestId: 'req-1' },
    });
    expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
      '+2348000000000',
      expect.stringContaining('CONFIRM'),
    );
  });

  it('claims nothing and sends no notification when the status already moved on', async () => {
    prisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(prisma));
    prisma.rescueRequest.updateMany.mockResolvedValue({ count: 0 });

    const result = await service.startManualCompletionConfirmation('req-1');

    expect(result).toEqual({ claimed: false });
    expect(prisma.whatsAppSession.updateMany).not.toHaveBeenCalled();
    expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalled();
  });
});
```
Check this file's existing spec setup for the exact `prisma`/`twilioService` mock shape already used for `handleOperatorArrived`/`handleOperatorJobDone` tests and match it — do not invent a different mock structure. Confirm `prisma.$transaction` is already a `jest.fn()` in this file's mock; add it if missing.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/rescue-request/whatsapp-operator-flow.service.spec.ts -t "notifyCustomerOperatorArrived|startManualCompletionConfirmation"`
Expected: FAIL — neither method exists yet.

- [ ] **Step 3: Implement**

Add both as new public methods on `WhatsAppOperatorFlowService` (anywhere in the class; placing them just before `handleOperatorArrived`/`handleOperatorJobDone` at line 554 keeps the customer-facing and operator-facing versions readably adjacent):
```ts
/**
 * The customer-facing NOTIFICATION half of ARRIVED — deliberately does
 * NOT write the ARRIVED status itself. Shared between the WhatsApp
 * handler (which does its own unconditional status write, already gated
 * by its own session-state check, immediately before calling this) and
 * the manual-arrived controller action (Task 10, which does an atomic
 * CONDITIONAL claim of that same status write before calling this) —
 * those two callers need different concurrency guarantees for the write
 * itself, so the write can't live in this shared method without collapsing
 * that difference. Keeping this method to "read the current state, tell
 * the customer" only is what lets both callers share it safely.
 */
async notifyCustomerOperatorArrived(rescueRequestId: string): Promise<void> {
  const rescueRequest = await this.prisma.rescueRequest.findUnique({
    where: { id: rescueRequestId },
    include: { customer: true, assignedOperator: true },
  });
  if (!rescueRequest) return;
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
 * completion media: a non-WhatsApp job is exempt from the mandatory
 * evidence rule by explicit product decision, verified by phone instead.
 * `handleOperatorJobDone` (the WhatsApp path) is completely untouched by
 * this method and still requires media first, exactly as today.
 *
 * Unlike `notifyCustomerOperatorArrived`, this one is NOT shared with any
 * WhatsApp-path method (the WhatsApp DONE flow has no manual-only
 * equivalent to share with), so it owns its own atomic conditional claim
 * end to end — the claim (`status: ARRIVED` → sets `confirmationDueAt`)
 * is the first statement inside its own transaction, closing the same
 * race Task 10's callout describes, self-contained, with no separate
 * claim helper needed elsewhere.
 */
async startManualCompletionConfirmation(
  rescueRequestId: string,
): Promise<{ claimed: boolean }> {
  const result = await this.prisma.$transaction(async (tx) => {
    const claimed = await tx.rescueRequest.updateMany({
      where: {
        id: rescueRequestId,
        status: RescueRequestStatus.ARRIVED,
        assignedOperator: { whatsappEnabled: false },
      },
      data: { confirmationDueAt: new Date(Date.now() + STALLED_CONFIRMATION_MS) },
    });
    if (claimed.count === 0) return null;

    const rescueRequest = await tx.rescueRequest.findUnique({
      where: { id: rescueRequestId },
      select: {
        customerId: true,
        customer: { select: { phoneNumber: true } },
        assignedOperator: { select: { businessName: true } },
      },
    });
    if (rescueRequest?.customerId) {
      await tx.whatsAppSession.updateMany({
        where: { userId: rescueRequest.customerId },
        data: { state: WhatsAppFlowState.AWAITING_COMPLETION_CONFIRM, rescueRequestId },
      });
    }
    return rescueRequest;
  });

  if (!result) return { claimed: false };

  const customerPhone = result.customer?.phoneNumber;
  if (customerPhone) {
    await this.twilioService.sendWhatsAppMessage(
      customerPhone,
      `🔧 ${result.assignedOperator?.businessName} says the job is done!\n\nReply *CONFIRM* to release your vehicle and receive the balance payment link.\n\nIf there's a problem, reply *DISPUTE* and our team will investigate.`,
    );
  }
  return { claimed: true };
}
```
`handleOperatorArrived` (lines 554-603) is **not** modified in this task —
it keeps its own unconditional `rescueRequest.update({data: {status: ARRIVED}})`
exactly as today, immediately followed by a new call to
`this.notifyCustomerOperatorArrived(rescueRequestId)` in place of the inline
customer-notification block it previously had (the status write itself
stays where it already is, right above where the inline notification used
to be — only the notification send moves into the shared method call):
```ts
private async handleOperatorArrived(
  operatorPhone: string,
  operatorUserId: string,
  rescueRequestId: string,
  operator: { id: string; businessName: string },
) {
  const rescueRequest = await this.prisma.rescueRequest.findUnique({
    where: { id: rescueRequestId },
    include: { customer: true },
  });
  if (
    !rescueRequest ||
    rescueRequest.status === RescueRequestStatus.CANCELLED ||
    rescueRequest.status === RescueRequestStatus.COMPLETED
  ) {
    logger.info('whatsapp: ARRIVED rejected — request already ended', {
      operatorId: operator.id,
      rescueRequestId,
      status: rescueRequest?.status ?? 'NOT_FOUND',
    });
    await this.sessionStore.clear(operatorUserId);
    return this.reply(
      `${formatJobRef(rescueRequestId)} has already ended. Watch out for new dispatch offers.`,
    );
  }

  // Update request status to ARRIVED — unconditional here, exactly as
  // before this task: this path's own session-state check (line 330,
  // OPERATOR_ON_JOB) is what already guards this write; it does not need
  // the manual path's atomic conditional claim, which exists specifically
  // because the manual path has no session state to check instead.
  await this.prisma.rescueRequest.update({
    where: { id: rescueRequestId },
    data: { status: RescueRequestStatus.ARRIVED },
  });

  await this.sessionStore.update(operatorUserId, {
    state: WhatsAppFlowState.OPERATOR_AT_LOCATION,
  });

  await this.notifyCustomerOperatorArrived(rescueRequestId);

  return this.reply(
    `✅ ${formatJobRef(rescueRequestId)} — Arrival confirmed! The customer has been notified.\n\nSend *DONE* when the job is complete.`,
  );
}
```
`handleOperatorJobDone` (lines 605-679) is **not** modified at all in this task.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/rescue-request/whatsapp-operator-flow.service.spec.ts`
Expected: PASS, including every pre-existing `handleOperatorArrived`/`handleOperatorJobDone` test — the refactor must be behavior-preserving for the WhatsApp path.

- [ ] **Step 5: Full suite, lint, commit**

```bash
npx jest --silent
npx eslint "{src,apps,libs,test}/**/*.ts" --max-warnings 525
git add src/rescue-request/whatsapp-operator-flow.service.ts src/rescue-request/whatsapp-operator-flow.service.spec.ts
git commit -m "Extract notifyCustomerOperatorArrived; add startManualCompletionConfirmation"
```

---

### Task 10: `manual-arrived` / `manual-done` controller actions

> **Concurrency correction (authoritative over the illustrative snippets
> below):** do not implement either endpoint as controller read → service
> write. Put each precondition and transition in one transactional service
> operation. `manual-arrived` performs a conditional `updateMany` from
> `OPERATOR_ASSIGNED` to `ARRIVED` whose `where` also requires
> `assignedOperator.whatsappEnabled: false`; only `count: 1` may trigger the
> customer notification. `manual-done` starts its transaction with the same
> conditional claim (`status: ARRIVED`, assigned operator non-WhatsApp) before
> setting `confirmationDueAt` and the customer session. On `count: 0`, re-read
> only to produce the precise not-found/operator-channel/current-status error.
> Two concurrent clicks therefore produce one transition and one notification,
> and cancellation cannot be overwritten by a later blind status update.

**Files:**
- Modify: `src/rescue-request/rescue-request.controller.ts`
- Test: `src/rescue-request/rescue-request.controller.spec.ts` (create if it doesn't exist — check first)

**Interfaces:**
- Consumes: `WhatsAppOperatorFlowService.notifyCustomerOperatorArrived(rescueRequestId): Promise<void>` (notification-only) and `.startManualCompletionConfirmation(rescueRequestId): Promise<{claimed: boolean}>` (self-contained atomic) — both Task 9. Produces, for its own use in this task: `RescueRequestAdminService.findRawForManualAction(id)` (pre-check read) and `.claimManualArrived(id): Promise<{claimed: boolean}>` (atomic conditional claim) — both added in Step 4 below.
- Produces: `PATCH /rescue-requests/:id/manual-arrived`, `PATCH /rescue-requests/:id/manual-done`, both `ADMIN`/`SUPER_ADMIN`-gated.

- [ ] **Step 1: Check for an existing controller spec, and add the new dependency**

Run: `ls src/rescue-request/rescue-request.controller.spec.ts` — if absent, this task creates the first one for this controller, following the mocking style already established in this repo's other controller specs this session (e.g. `src/account-deletion/account-deletion.controller.spec.ts`: `Test.createTestingModule({ controllers: [...], providers: [{provide: Service, useValue: mock}, {provide: JwtService, useValue: {}}] })`).

`RescueRequestController` needs a new injected dependency: `WhatsAppOperatorFlowService`. Since it's declared in the same module (`RescueRequestModule`) and already in that module's `providers` array (confirmed — Task 9 doesn't change that), no module changes are needed for the controller to inject it — only the controller's own constructor changes.

- [ ] **Step 2: Write the failing tests**

Create or extend `src/rescue-request/rescue-request.controller.spec.ts`:
```ts
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { RescueRequestController } from './rescue-request.controller';
import { DisputeService } from './dispute.service';
import { RescueRequestAdminService } from './rescue-request-admin.service';
import { DispatchService } from './dispatch.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { WhatsAppOperatorFlowService } from './whatsapp-operator-flow.service';

const req = { user: { userId: 'admin-1' } } as never;

describe('RescueRequestController — manual dispatch actions', () => {
  let controller: RescueRequestController;
  let rescueRequestAdminService: {
    findRawForManualAction: jest.Mock;
    claimManualArrived: jest.Mock;
  };
  let operatorFlowService: {
    notifyCustomerOperatorArrived: jest.Mock;
    startManualCompletionConfirmation: jest.Mock;
  };
  let auditLogService: { record: jest.Mock };

  beforeEach(async () => {
    rescueRequestAdminService = {
      findRawForManualAction: jest.fn(),
      claimManualArrived: jest.fn(),
    };
    operatorFlowService = {
      notifyCustomerOperatorArrived: jest.fn(),
      startManualCompletionConfirmation: jest.fn(),
    };
    auditLogService = { record: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [RescueRequestController],
      providers: [
        { provide: DisputeService, useValue: {} },
        { provide: RescueRequestAdminService, useValue: rescueRequestAdminService },
        { provide: DispatchService, useValue: {} },
        { provide: AuditLogService, useValue: auditLogService },
        { provide: WhatsAppOperatorFlowService, useValue: operatorFlowService },
        { provide: JwtService, useValue: {} },
      ],
    }).compile();

    controller = module.get(RescueRequestController);
  });

  describe('manualArrived', () => {
    it("rejects a WhatsApp-enabled operator's request, without attempting a claim", async () => {
      rescueRequestAdminService.findRawForManualAction.mockResolvedValue({
        status: 'OPERATOR_ASSIGNED',
        assignedOperator: { whatsappEnabled: true },
      });

      await expect(controller.manualArrived(req, 'req-1')).rejects.toThrow(
        'no WhatsApp',
      );
      expect(rescueRequestAdminService.claimManualArrived).not.toHaveBeenCalled();
      expect(operatorFlowService.notifyCustomerOperatorArrived).not.toHaveBeenCalled();
    });

    it('rejects a request not in OPERATOR_ASSIGNED, without attempting a claim', async () => {
      rescueRequestAdminService.findRawForManualAction.mockResolvedValue({
        status: 'WAITING_FOR_DEPOSIT',
        assignedOperator: { whatsappEnabled: false },
      });

      await expect(controller.manualArrived(req, 'req-1')).rejects.toThrow(
        'WAITING_FOR_DEPOSIT',
      );
      expect(rescueRequestAdminService.claimManualArrived).not.toHaveBeenCalled();
    });

    it('claims, notifies, and audit-logs for an eligible request', async () => {
      rescueRequestAdminService.findRawForManualAction.mockResolvedValue({
        status: 'OPERATOR_ASSIGNED',
        assignedOperatorId: 'op-1',
        assignedOperator: { whatsappEnabled: false },
      });
      rescueRequestAdminService.claimManualArrived.mockResolvedValue({ claimed: true });

      await controller.manualArrived(req, 'req-1');

      expect(rescueRequestAdminService.claimManualArrived).toHaveBeenCalledWith('req-1');
      expect(operatorFlowService.notifyCustomerOperatorArrived).toHaveBeenCalledWith('req-1');
      expect(auditLogService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'manual_operator_arrived',
          actorId: 'admin-1',
        }),
      );
    });

    it('rejects and does not notify when the atomic claim loses the race — pre-check passed but status changed before the claim ran', async () => {
      rescueRequestAdminService.findRawForManualAction.mockResolvedValue({
        status: 'OPERATOR_ASSIGNED',
        assignedOperatorId: 'op-1',
        assignedOperator: { whatsappEnabled: false },
      });
      rescueRequestAdminService.claimManualArrived.mockResolvedValue({ claimed: false });

      await expect(controller.manualArrived(req, 'req-1')).rejects.toThrow(
        /no longer eligible|already/i,
      );
      expect(operatorFlowService.notifyCustomerOperatorArrived).not.toHaveBeenCalled();
      expect(auditLogService.record).not.toHaveBeenCalled();
    });
  });

  describe('manualDone', () => {
    it('rejects a request not in ARRIVED, without attempting confirmation', async () => {
      rescueRequestAdminService.findRawForManualAction.mockResolvedValue({
        status: 'OPERATOR_ASSIGNED',
        assignedOperator: { whatsappEnabled: false },
      });

      await expect(controller.manualDone(req, 'req-1')).rejects.toThrow('OPERATOR_ASSIGNED');
      expect(operatorFlowService.startManualCompletionConfirmation).not.toHaveBeenCalled();
    });

    it('starts completion confirmation and audit-logs when the atomic claim succeeds', async () => {
      rescueRequestAdminService.findRawForManualAction.mockResolvedValue({
        status: 'ARRIVED',
        assignedOperatorId: 'op-1',
        assignedOperator: { whatsappEnabled: false },
      });
      operatorFlowService.startManualCompletionConfirmation.mockResolvedValue({ claimed: true });

      await controller.manualDone(req, 'req-1');

      expect(operatorFlowService.startManualCompletionConfirmation).toHaveBeenCalledWith('req-1');
      expect(auditLogService.record).toHaveBeenCalledWith(
        expect.objectContaining({ category: 'manual_operator_done', actorId: 'admin-1' }),
      );
    });

    it('rejects and does not audit-log when the atomic claim loses the race — pre-check passed but ARRIVED changed before the claim ran', async () => {
      rescueRequestAdminService.findRawForManualAction.mockResolvedValue({
        status: 'ARRIVED',
        assignedOperatorId: 'op-1',
        assignedOperator: { whatsappEnabled: false },
      });
      operatorFlowService.startManualCompletionConfirmation.mockResolvedValue({ claimed: false });

      await expect(controller.manualDone(req, 'req-1')).rejects.toThrow(
        /no longer eligible|already/i,
      );
      expect(auditLogService.record).not.toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx jest src/rescue-request/rescue-request.controller.spec.ts`
Expected: FAIL — `manualArrived`/`manualDone` don't exist, `findRawForManualAction` doesn't exist on the real service yet.

- [ ] **Step 4: Add `findRawForManualAction` and `claimManualArrived` to `RescueRequestAdminService`**

Two additions to `src/rescue-request/rescue-request-admin.service.ts`, near `detailForUser`. `findRawForManualAction` is a plain read used only to produce a precise, friendly error message (which of the three possible reasons — not found, wrong channel, wrong status — the caller should see); it is a pre-check, not the guard. The guard is `claimManualArrived`'s own atomic conditional `updateMany`, which re-verifies the exact same two conditions at the moment of the write — the same lock-as-mutex idiom `assignOperator` already uses (Task 5), applied here to the ARRIVED transition specifically:
```ts
async findRawForManualAction(id: string) {
  return this.prisma.rescueRequest.findUnique({
    where: { id },
    select: {
      status: true,
      assignedOperatorId: true,
      assignedOperator: { select: { whatsappEnabled: true } },
    },
  });
}

/**
 * Atomically claims the ARRIVED transition for a manually-operated job.
 * `count: 0` means the pre-check (`findRawForManualAction`, read moments
 * earlier by the controller) is now stale — status or the operator's
 * whatsappEnabled flag changed in between — and the caller must not
 * proceed to notify the customer or write an audit entry.
 */
async claimManualArrived(id: string): Promise<{ claimed: boolean }> {
  const claimed = await this.prisma.rescueRequest.updateMany({
    where: {
      id,
      status: RescueRequestStatus.OPERATOR_ASSIGNED,
      assignedOperator: { whatsappEnabled: false },
    },
    data: { status: RescueRequestStatus.ARRIVED },
  });
  return { claimed: claimed.count === 1 };
}
```

- [ ] **Step 5: Implement the controller actions**

In `src/rescue-request/rescue-request.controller.ts`, add the import and constructor param:
```ts
import { WhatsAppOperatorFlowService } from './whatsapp-operator-flow.service';
```
```ts
constructor(
  private readonly disputeService: DisputeService,
  private readonly rescueRequestAdminService: RescueRequestAdminService,
  private readonly dispatchService: DispatchService,
  private readonly auditLogService: AuditLogService,
  private readonly operatorFlowService: WhatsAppOperatorFlowService,
) {}
```
Add two new endpoints, placed after the existing `cancel` endpoint (after line 172). Both follow the same shape: a plain read for a precise error message, then an atomic conditional claim, and only on `claimed: true` does the customer get notified and the action get audit-logged:
```ts
/**
 * Staff stand-in for an operator sending ARRIVED over WhatsApp — only
 * usable when the assigned operator has no WhatsApp on file. A
 * WhatsApp-enabled operator's job is never manually advanced, so staff
 * and the operator's own replies can never race over the same status.
 *
 * The pre-check below (`findRawForManualAction`) is what produces a
 * precise error message; it is NOT the concurrency guard. The guard is
 * `claimManualArrived`'s own atomic conditional update — if two staff
 * members click this at once, or the request moved on between the
 * pre-check and the claim, only one claim can ever succeed, and only the
 * winner notifies the customer or writes an audit entry.
 */
@Patch(':id/manual-arrived')
@UseGuards(RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
async manualArrived(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
  const request = await this.rescueRequestAdminService.findRawForManualAction(id);
  if (!request) throw new NotFoundException('Rescue request not found');
  if (request.assignedOperator?.whatsappEnabled !== false) {
    throw new BadRequestException(
      'This operator has WhatsApp on file — arrival is tracked automatically for this job.',
    );
  }
  if (request.status !== RescueRequestStatus.OPERATOR_ASSIGNED) {
    throw new BadRequestException(
      `Cannot mark arrived — request is ${request.status}, expected OPERATOR_ASSIGNED.`,
    );
  }

  const { claimed } = await this.rescueRequestAdminService.claimManualArrived(id);
  if (!claimed) {
    throw new BadRequestException(
      'This request is no longer eligible for a manual arrival — it may already have been marked, or its status changed.',
    );
  }

  await this.operatorFlowService.notifyCustomerOperatorArrived(id);
  await this.auditLogService.record({
    category: 'manual_operator_arrived',
    message: `Marked operator arrived for request ${id} (no WhatsApp on file)`,
    details: { targetType: 'RescueRequest', targetId: id, operatorId: request.assignedOperatorId },
    actorId: req.user.userId,
  });
  return { message: 'Marked arrived' };
}

/**
 * Staff stand-in for an operator sending DONE over WhatsApp — same
 * whatsappEnabled guard as manual-arrived. Deliberately does NOT require
 * completion media (product decision, see the design spec) — the WhatsApp
 * path's own DONE handler is completely untouched and still requires it.
 *
 * Unlike manual-arrived, the atomic claim itself lives inside
 * `startManualCompletionConfirmation` (Task 9) — that method is
 * self-contained since it isn't shared with any WhatsApp-path method, so
 * there's no separate `claimManualDone` helper here; this endpoint's own
 * two checks below are still pre-check-only, for the same precise-error
 * reason as manual-arrived.
 */
@Patch(':id/manual-done')
@UseGuards(RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
async manualDone(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
  const request = await this.rescueRequestAdminService.findRawForManualAction(id);
  if (!request) throw new NotFoundException('Rescue request not found');
  if (request.assignedOperator?.whatsappEnabled !== false) {
    throw new BadRequestException(
      'This operator has WhatsApp on file — completion is tracked automatically for this job.',
    );
  }
  if (request.status !== RescueRequestStatus.ARRIVED) {
    throw new BadRequestException(
      `Cannot mark done — request is ${request.status}, expected ARRIVED.`,
    );
  }

  const { claimed } = await this.operatorFlowService.startManualCompletionConfirmation(id);
  if (!claimed) {
    throw new BadRequestException(
      'This request is no longer eligible for manual completion — it may already have been marked, or its status changed.',
    );
  }

  await this.auditLogService.record({
    category: 'manual_operator_done',
    message: `Marked operator done for request ${id} (no WhatsApp on file)`,
    details: { targetType: 'RescueRequest', targetId: id, operatorId: request.assignedOperatorId },
    actorId: req.user.userId,
  });
  return { message: 'Marked done — awaiting customer confirmation' };
}
```
Add `BadRequestException`, `NotFoundException`, and `RescueRequestStatus` (from `@prisma/client`) to this file's imports if not already present — check first.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx jest src/rescue-request/rescue-request.controller.spec.ts`
Expected: PASS.

- [ ] **Step 7: Full suite, lint, commit**

```bash
npx jest --silent
npx eslint "{src,apps,libs,test}/**/*.ts" --max-warnings 525
git add src/rescue-request/rescue-request.controller.ts src/rescue-request/rescue-request.controller.spec.ts src/rescue-request/rescue-request-admin.service.ts
git commit -m "Add manual-arrived and manual-done endpoints for non-WhatsApp operators"
```

---

### Task 11: Audit log the non-WhatsApp manual assignment itself

> **Ordering correction (found in review):** an earlier draft of this task
> had its controller code read `result.data.assignedOperator?.whatsappEnabled`
> while its own Step 1 test mocked a flat `{ assignedOperatorId, businessName }`
> shape with no `whatsappEnabled` at all — and `whatsappEnabled` was only
> ever added to `OperatorDetailDto`/`mapToDetailDto` in what was then Task 14,
> three tasks later. Run in order, this task's own tests couldn't have
> passed: `assignedOperator.whatsappEnabled` would be `undefined` against
> the real (not-yet-updated) `mapToDetailDto`, so the audit branch would
> never fire. Fixed below — this task now adds the field itself, and Task
> 14 reuses it instead of adding it a second time.

**Files:**
- Modify: `src/rescue-request/rescue-request.controller.ts` (`assignOperator` endpoint, lines 113-121)
- Modify: `src/rescue-request/rescue-request-admin.service.ts` — three sites: `mapToDetailDto`'s `assignedOperator` mapping (lines ~903-908), and the narrowed `assignedOperator.select` in both `operatorDetail()` (~572-579) and `detailForUser()` (~686-693)
- Modify: `src/rescue-request/dto/rescue-request-response.dto.ts` (`OperatorDetailDto`)
- Test: `src/rescue-request/rescue-request.controller.spec.ts`
- Test: `src/rescue-request/rescue-request-admin.service.spec.ts` (if `mapToDetailDto`'s output shape has direct test coverage — check first)

**Interfaces:**
- Consumes: `AuditLogService.record` (already injected in this controller).
- Produces: `OperatorDetailDto.whatsappEnabled: boolean` — consumed by this task's own controller code AND, later, by Task 14's frontend work (which must NOT re-add this field; it reuses what this task already exposes).

- [ ] **Step 1: Add `whatsappEnabled` to the detail response, first**

In `src/rescue-request/dto/rescue-request-response.dto.ts`, add to `OperatorDetailDto`:
```ts
export class OperatorDetailDto {
  id: string;
  businessName: string;
  phoneNumber: string;
  email?: string;
  whatsappEnabled: boolean;
}
```
In `src/rescue-request/rescue-request-admin.service.ts`, find `mapToDetailDto`'s `assignedOperator` mapping (currently ~lines 903-908) and add the field:
```ts
assignedOperator: raw.assignedOperator
  ? {
      id: raw.assignedOperator.id,
      businessName: raw.assignedOperator.businessName,
      phoneNumber: raw.assignedOperator.phoneNumber,
      email: raw.assignedOperator.email,
      whatsappEnabled: raw.assignedOperator.whatsappEnabled,
    }
  : undefined,
```
**A Prisma query change IS needed at two of the four call sites.** Not every
`mapToDetailDto` caller does a full-row `include: { assignedOperator: true }`
— two use a narrowed `select` that would silently omit `whatsappEnabled`
even after this step's DTO/mapping change:

- `assignOperator` (line ~298-303) and `updateStatus`/`cancel` (lines
  ~465-468, ~498-501) already do full-row includes (`assignedOperator: true`,
  or omit the relation entirely) — no change needed there. (`updateStatus`
  and `cancel` don't include `assignedOperator` at all today; that's
  pre-existing behavior this task doesn't touch or fix.)
- `operatorDetail()` (line ~572-579) and `detailForUser()` (line ~686-693)
  both use a narrowed `select: { id, businessName, phoneNumber, email }` on
  `assignedOperator`. Add `whatsappEnabled: true` to **both**:
```ts
assignedOperator: {
  select: {
    id: true,
    businessName: true,
    phoneNumber: true,
    email: true,
    whatsappEnabled: true,
  },
},
```
Without this, `raw.assignedOperator.whatsappEnabled` is `undefined` for any
request fetched through `operatorDetail`/`detailForUser` — the two most
common detail-view paths (operator's own view, and the customer/operator
branches of `detailForUser`) — even though `mapToDetailDto`'s own mapping is
correct. This is not a hypothetical: it was checked against current source,
not assumed.

- [ ] **Step 2: Write the failing test**

Add to `src/rescue-request/rescue-request.controller.spec.ts` (a new `describe('assignOperator', ...)` block, or extend one if this task's Task 10 setup already created a describe structure covering this controller):
```ts
it('audit-logs a manual assignment to a non-WhatsApp operator with its id and business name', async () => {
  rescueRequestAdminService.assignOperator = jest.fn().mockResolvedValue({
    data: {
      assignedOperator: {
        id: 'op-1',
        businessName: 'Backup Towing',
        whatsappEnabled: false,
      },
    },
  });
  // ...construct via TestingModule as in Task 10, providing rescueRequestAdminService.assignOperator...

  await controller.assignOperator(req, 'req-1', { operatorId: 'op-1', priceKobo: 500000 });

  expect(auditLogService.record).toHaveBeenCalledWith(
    expect.objectContaining({
      category: 'manual_assignment_confirmed',
      actorId: 'admin-1',
      details: expect.objectContaining({
        operatorId: 'op-1',
        businessName: 'Backup Towing',
      }),
    }),
  );
});

it('does not add the manual-assignment audit category for a normal WhatsApp operator', async () => {
  rescueRequestAdminService.assignOperator = jest.fn().mockResolvedValue({
    data: {
      assignedOperator: {
        id: 'op-2',
        businessName: 'Normal Towing',
        whatsappEnabled: true,
      },
    },
  });

  await controller.assignOperator(req, 'req-1', { operatorId: 'op-2', priceKobo: 500000 });

  expect(auditLogService.record).not.toHaveBeenCalled();
});
```

Also add, to `src/rescue-request/rescue-request-admin.service.spec.ts`, in whatever `describe` blocks already cover `operatorDetail` and `detailForUser` (find them first — do not invent new ones):
```ts
it('operatorDetail requests whatsappEnabled on the narrowed assignedOperator select', async () => {
  prisma.rescueRequest.findUnique.mockResolvedValue({
    id: 'req-1',
    assignedOperatorId: 'op-1',
    customer: {},
    assignedOperator: { id: 'op-1', businessName: 'B', phoneNumber: 'p', email: null, whatsappEnabled: false },
    payments: [],
  });
  operatorMembershipService.findActiveOperatorIdsForUser.mockResolvedValue(['op-1']);

  await service.operatorDetail('user-1', 'req-1');

  expect(prisma.rescueRequest.findUnique).toHaveBeenCalledWith(
    expect.objectContaining({
      include: expect.objectContaining({
        assignedOperator: expect.objectContaining({
          select: expect.objectContaining({ whatsappEnabled: true }),
        }),
      }),
    }),
  );
});

it('detailForUser requests whatsappEnabled on the narrowed assignedOperator select', async () => {
  prisma.rescueRequest.findUnique.mockResolvedValue({
    id: 'req-1',
    customerId: 'cust-1',
    customer: {},
    assignedOperator: { id: 'op-1', businessName: 'B', phoneNumber: 'p', email: null, whatsappEnabled: false },
    media: [],
    dispatchOffers: [],
    ratings: [],
    payments: [],
  });

  await service.detailForUser({ role: 'CUSTOMER', userId: 'cust-1' }, 'req-1');

  expect(prisma.rescueRequest.findUnique).toHaveBeenCalledWith(
    expect.objectContaining({
      include: expect.objectContaining({
        assignedOperator: expect.objectContaining({
          select: expect.objectContaining({ whatsappEnabled: true }),
        }),
      }),
    }),
  );
});
```
Reuse whatever mock shape this file's existing `operatorDetail`/`detailForUser` tests already establish for `prisma`/`operatorMembershipService` — do not invent a different shape.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx jest src/rescue-request/rescue-request.controller.spec.ts -t "audit"`
Run: `npx jest src/rescue-request/rescue-request-admin.service.spec.ts -t "whatsappEnabled on the narrowed"`
Expected: FAIL — no audit call exists in `assignOperator` yet; the narrowed selects don't request `whatsappEnabled` yet.

- [ ] **Step 4: Implement the controller change**

In `src/rescue-request/rescue-request.controller.ts`, change the `assignOperator` endpoint (currently lines 113-121) to accept `@Req()` and record after success:
```ts
@Patch(':id/assign-operator')
@UseGuards(RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
async assignOperator(
  @Req() req: AuthenticatedRequest,
  @Param('id') id: string,
  @Body() dto: AssignOperatorDto,
) {
  const result = await this.rescueRequestAdminService.assignOperator(id, dto);
  if (result.data.assignedOperator?.whatsappEnabled === false) {
    await this.auditLogService.record({
      category: 'manual_assignment_confirmed',
      message: `Manually assigned ${result.data.assignedOperator.businessName} to request ${id}`,
      details: {
        targetType: 'RescueRequest',
        targetId: id,
        operatorId: result.data.assignedOperator.id,
        businessName: result.data.assignedOperator.businessName,
      },
      actorId: req.user.userId,
    });
  }
  return result;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest src/rescue-request/rescue-request.controller.spec.ts src/rescue-request/rescue-request-admin.service.spec.ts`
Expected: PASS, including every pre-existing test — `mapToDetailDto`'s existing tests (if any assert its exact output shape with strict equality) now also need `whatsappEnabled` added to their expected `assignedOperator` object, same reasoning as Task 3's `extraRadiusKm` fix. This also confirms the `operatorDetail`/`detailForUser` select-clause fix from Step 1 is real, not just claimed.

- [ ] **Step 6: Full suite, lint, commit**

```bash
npx jest --silent
npx eslint "{src,apps,libs,test}/**/*.ts" --max-warnings 525
git add src/rescue-request/rescue-request.controller.ts src/rescue-request/rescue-request.controller.spec.ts src/rescue-request/rescue-request-admin.service.ts src/rescue-request/rescue-request-admin.service.spec.ts src/rescue-request/dto/rescue-request-response.dto.ts
git commit -m "Audit-log manual operator assignments, expose whatsappEnabled on operator detail"
```

---

### Task 12: Backend — `whatsappEnabled` on registration

**Files:**
- Modify: `src/operator/dto/create-operator.dto.ts`
- Modify: `src/operator/operator.service.ts:272-286`
- Test: `src/operator/operator.service.spec.ts`

**Interfaces:**
- Produces: `CreateOperatorDto.whatsappEnabled?: boolean` (defaults to `true` when omitted, so existing/other API consumers of `POST /operators` are unaffected).

- [ ] **Step 1: Write the failing test**

In `src/operator/operator.service.spec.ts`, find the existing `describe('create', ...)`-style coverage (or wherever `operator.service.ts`'s `create()` happy path is tested) and add:
```ts
it('persists whatsappEnabled: false when explicitly provided at registration', async () => {
  // Reuse the existing successful-registration test's full mock setup,
  // adding `whatsappEnabled: false` to the input DTO.
  await service.create({ ...validCreateOperatorDto, whatsappEnabled: false });

  expect(prisma.operator.create).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({ whatsappEnabled: false }),
    }),
  );
});

it('defaults to whatsappEnabled: true when omitted', async () => {
  await service.create(validCreateOperatorDto); // no whatsappEnabled field

  expect(prisma.operator.create).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({ whatsappEnabled: true }),
    }),
  );
});
```
Reuse whatever this file already names its baseline valid-DTO fixture — do not invent a new one.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/operator/operator.service.spec.ts -t "whatsappEnabled"`
Expected: FAIL — the field isn't threaded through yet.

- [ ] **Step 3: Implement**

In `src/operator/dto/create-operator.dto.ts`, add:
```ts
import { IsArray, IsBoolean, IsEmail, IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';
```
```ts
@IsBoolean()
@IsOptional()
whatsappEnabled?: boolean;
```
(placed anywhere among the existing optional fields).

In `src/operator/operator.service.ts`, change the `tx.operator.create()` call (lines 272-286):
```ts
const operator = await tx.operator.create({
  data: {
    type: data.type ?? OperatorType.TOW_TRUCK,
    truckClasses: data.truckClasses,
    businessName: data.businessName,
    contactName: data.contactName,
    phoneNumber: businessPhone,
    email: data.email,
    address: data.address,
    latitude: data.latitude,
    longitude: data.longitude,
    serviceRadius: data.serviceRadius ?? 10,
    status: OperatorStatus.PENDING,
    whatsappEnabled: data.whatsappEnabled ?? true,
  },
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/operator/operator.service.spec.ts`
Expected: PASS, including every pre-existing test.

- [ ] **Step 5: Full suite, lint, commit**

```bash
npx jest --silent
npx eslint "{src,apps,libs,test}/**/*.ts" --max-warnings 525
git add src/operator/dto/create-operator.dto.ts src/operator/operator.service.ts src/operator/operator.service.spec.ts
git commit -m "Accept whatsappEnabled on operator registration"
```

---

### Task 13: lrr-web — registration checkbox

**Files:**
- Modify: `lrr-web/app/register/page.tsx`
- Modify: `lrr-web/app/types.ts:63-78`

**Interfaces:**
- Consumes: `CreateOperatorDto.whatsappEnabled` (Task 12, via `POST /operators`).

- [ ] **Step 1: Add the field to the request type**

In `lrr-web/app/types.ts`, add to `RegisterOperatorRequest` (lines 63-78):
```ts
export interface RegisterOperatorRequest {
  name: string;
  businessName: string;
  contactName: string;
  phoneNumber: string;
  businessPhoneNumber: string;
  email?: string;
  password: string;
  type: OperatorType;
  address: string;
  latitude: number;
  longitude: number;
  truckClasses: TruckClass[];
  serviceRadius: number;
  phoneVerificationToken: string;
  whatsappEnabled: boolean;
}
```

- [ ] **Step 2: Add form state and the checkbox**

In `lrr-web/app/register/page.tsx`, add to the `formData` state (lines 85-96):
```tsx
const [formData, setFormData] = useState({
  contactName: "",
  businessName: "",
  phoneNumber: "",
  businessPhoneNumber: "",
  operatorType: OperatorType.TOW_TRUCK,
  truckClasses: [] as TruckClass[],
  serviceRadius: "50",
  email: "",
  password: "",
  confirmPassword: "",
  whatsappEnabled: true,
});
```
Add a checkbox to the form JSX — find the section rendering `businessPhoneNumber`/`sameAsPersonalPhone` (since this field is conceptually about the same dispatch line) and add nearby:
```tsx
<label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "0.9rem" }}>
  <input
    type="checkbox"
    checked={formData.whatsappEnabled}
    onChange={(e) =>
      setFormData((prev) => ({ ...prev, whatsappEnabled: e.target.checked }))
    }
  />
  This business has WhatsApp on this phone number
</label>
```

- [ ] **Step 3: Include it in the submit payload**

In the payload-construction block (currently lines 254-269), add:
```tsx
const payload: RegisterOperatorRequest = {
  name: formData.contactName,
  businessName: formData.businessName,
  contactName: formData.contactName,
  phoneNumber: formData.phoneNumber,
  businessPhoneNumber: formData.businessPhoneNumber,
  type: formData.operatorType,
  email: formData.email || undefined,
  password: formData.password,
  address: address,
  latitude: latLng.lat,
  longitude: latLng.lng,
  truckClasses: formData.truckClasses,
  serviceRadius: Number(formData.serviceRadius),
  phoneVerificationToken: otpToken,
  whatsappEnabled: formData.whatsappEnabled,
};
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 5: Manual verification**

Per this project's standing rule, start the dev server and exercise this in a browser: confirm the checkbox defaults to checked, confirm unchecking it and completing registration produces an operator with `whatsappEnabled: false` (check via `GET /operators` or the Operators admin tab once Task 15 lands — until then, checking the DB row directly is fine), confirm the OTP verification step is completely unaffected either way.

- [ ] **Step 6: Commit**

```bash
git add app/register/page.tsx app/types.ts
git commit -m "Add WhatsApp-enabled checkbox to operator registration"
```

---

### Task 14: lrr-web — "needs manual assignment" surfacing and assign action

**Files:**
- Modify: `app/components/tabs/RescueRequestsTabAdmin.tsx` (or wherever the Requests tab and its status badges live — confirm exact filename first)
- Modify: `app/hooks/useRescueRequestApi.ts` (or wherever the request-list/detail types live — confirm exact filename first)
- Modify: `src/rescue-request/rescue-request-admin.service.ts` (`buildListResponse`'s Prisma select + mapping; `mapToDetailDto`'s top-level `needsManualAssignment` — NOT its `assignedOperator.whatsappEnabled`, already done in Task 11)
- Modify: `src/rescue-request/dto/rescue-request-response.dto.ts` (`OperatorSummaryDto`, `RescueRequestListItemDto`, `RescueRequestDetailDto`, `DispatchBoardRowDto` — NOT `OperatorDetailDto`, already done in Task 11)
- Modify: `src/rescue-request/dispatch.service.ts` (`getDispatchBoard()`, ~lines 1369-1409 — the Dispatch Board is a separate projection from the Requests list, confirmed by direct read, and needs its own field added)
- Modify: `app/hooks/useDispatchBoardApi.ts` (`DispatchBoardRow`)
- Modify: `app/components/tabs/DispatchBoardTab.tsx`
- Modify: `src/rescue-request/rescue-request.module.ts` if required by the current provider/export graph
- Update every `RescueRequestAdminService` TestingModule/direct constructor in affected specs for its new `OperatorService` dependency

**Interfaces:**
- Consumes: `RescueRequest.needsManualAssignment` (Task 1), `OperatorDetailDto.whatsappEnabled` (Task 11 — the *nested* `assignedOperator.whatsappEnabled` field is already exposed on the detail response; this task does NOT re-add that specific field. It does still need to add the separate, *top-level* `needsManualAssignment` field to the detail response, the list response, AND the Dispatch Board response — Task 11 only touched the operator sub-object, not any of these three top-level shapes).

**Why the Dispatch Board is its own step, not covered by Steps 1-3:** the
design spec requires the "Needs manual call" badge on both the Requests tab
*and* the Dispatch Board — those are two genuinely separate frontend views
backed by two separate backend projections, confirmed by direct read, not
assumed: `GET /rescue-requests` → `buildListResponse()` → `RescueRequestListItemDto`
vs. `GET /rescue-requests/dispatch-board` → `DispatchService.getDispatchBoard()`
→ `DispatchBoardRowDto`, a distinct DTO with only
`id/status/vehicleType/destination/round/createdAt/quoteCollectionDeadline/offers`
today. Steps 1-3 below only touch the Requests-tab path. Step 4 covers the
Dispatch Board path.

- [ ] **Step 1: Expose the required fields on the list response — the detail response already has them (Task 11)**

The list and detail paths use two different DTOs (confirmed:
`RescueRequestListItemDto.assignedOperator` is `OperatorSummaryDto` —
`id`/`businessName` only — while the detail path's `OperatorDetailDto`
already gained `whatsappEnabled` in Task 11). `buildListResponse()`
(`rescue-request-admin.service.ts:757-822`) also uses a *narrowed* Prisma
`select` for `assignedOperator` (`select: { id: true, businessName: true }`,
line 772) — unlike the detail path's full `include: { assignedOperator: true }`,
this one won't even fetch `whatsappEnabled` from the database unless the
`select` itself is extended, not just the output mapping. Two changes, both
in `buildListResponse`:
```ts
// The findMany's include (line 768-776) — add whatsappEnabled to the
// existing narrowed select:
assignedOperator: { select: { id: true, businessName: true, whatsappEnabled: true } },
```
```ts
// The output mapping (lines 782-818) — add both new fields:
needsManualAssignment: item.needsManualAssignment,
assignedOperator: item.assignedOperator
  ? {
      id: item.assignedOperator.id,
      businessName: item.assignedOperator.businessName,
      whatsappEnabled: item.assignedOperator.whatsappEnabled,
    }
  : undefined,
```
And to `OperatorSummaryDto`/`RescueRequestListItemDto` in
`src/rescue-request/dto/rescue-request-response.dto.ts`:
```ts
export class OperatorSummaryDto {
  id: string;
  businessName: string;
  whatsappEnabled: boolean;
}
```
```ts
// RescueRequestListItemDto gains:
needsManualAssignment: boolean;
```
Do not leave this as a discovery step: add assertions to `buildListResponse`'s
existing tests (if any assert its exact output shape) proving both new fields
survive serialization, and update the corresponding lrr-web list-item response
type to match.

Separately, add the top-level `needsManualAssignment` field to the **detail**
response too — `mapToDetailDto`'s own `return {...}` object
(`rescue-request-admin.service.ts:873-...`) currently has no
`needsManualAssignment` field at all (Task 11 only touched the nested
`assignedOperator` sub-object, not this top-level shape):
```ts
return {
  id: raw.id,
  status: raw.status,
  needsManualAssignment: raw.needsManualAssignment,
  // ...every other existing field, unchanged...
```
And to `RescueRequestDetailDto` (`rescue-request-response.dto.ts`) and its
lrr-web equivalent:
```ts
needsManualAssignment: boolean;
```

- [ ] **Step 2: Add the "Needs manual call" badge**

In the Requests tab's row-rendering, next to the existing status badge, add a conditional badge:
```tsx
{request.needsManualAssignment && (
  <span style={{ display: "inline-block", padding: "0.3rem 0.7rem", background: "#fff3cd", color: "#856404", borderRadius: 4, fontSize: "0.82rem", fontWeight: 600, marginLeft: 6 }}>
    Needs manual call
  </span>
)}
```
Match this file's existing badge styling conventions exactly rather than inventing new colors — check the existing status-badge `STATUS_STYLES`-equivalent map in this file first and reuse its palette if one fits.

- [ ] **Step 3: Add the "deposit paid, dispatch now" badge**

Alongside it, a second, derived (no new field — computed from two existing ones) badge:
```tsx
{request.assignedOperator?.whatsappEnabled === false &&
  request.status === "OPERATOR_ASSIGNED" && (
  <span style={{ display: "inline-block", padding: "0.3rem 0.7rem", background: "#d1ecf1", color: "#0c5460", borderRadius: 4, fontSize: "0.82rem", fontWeight: 600, marginLeft: 6 }}>
    Call operator — deposit paid, dispatch now
  </span>
)}
```

- [ ] **Step 4: Surface the same "Needs manual call" badge on the Dispatch Board**

`DispatchService.getDispatchBoard()` (`dispatch.service.ts:1369-1409`) is a
separate query from `buildListResponse` — its `findMany` has no `select` on
the base `RescueRequest` row (only an `include` for the `dispatchOffers`
relation), so every scalar column, including `needsManualAssignment` once
Task 1's migration lands, is already present on each `r` in the `.map()`
below; only the DTO type and the mapped return object are missing it. No
Prisma query change is needed here — only the two lines below.

In `src/rescue-request/dto/rescue-request-response.dto.ts`, add to
`DispatchBoardRowDto`:
```ts
export class DispatchBoardRowDto {
  id: string;
  status: RescueRequestStatus;
  vehicleType?: VehicleType;
  destination?: string;
  round: number;
  createdAt: Date;
  quoteCollectionDeadline?: Date;
  needsManualAssignment: boolean;
  offers: DispatchOfferAdminDto[];
}
```
In `src/rescue-request/dispatch.service.ts`, `getDispatchBoard()`'s
`requests.map(...)` (currently lines ~1394-1409), add one field to the
returned object:
```ts
return requests.map((r) => ({
  id: r.id,
  status: r.status,
  vehicleType: r.vehicleType ?? undefined,
  destination: r.destination ?? undefined,
  round: r.dispatchRound,
  createdAt: r.createdAt,
  quoteCollectionDeadline: r.quoteCollectionDeadline ?? undefined,
  needsManualAssignment: r.needsManualAssignment,
  offers: r.dispatchOffers.map((o) => ({
    operatorId: o.operatorId,
    businessName: o.operator.businessName,
    status: o.status,
    quotedPrice: o.quotedPrice ?? undefined,
    offeredAt: o.offeredAt,
    respondedAt: o.respondedAt ?? undefined,
  })),
}));
```
Add a test to `src/rescue-request/dispatch.service.spec.ts`'s existing
`getDispatchBoard` coverage (find it first — do not invent a new `describe`
block) asserting `needsManualAssignment` survives the mapping for a row
where `prisma.rescueRequest.findMany` resolves it `true`.

In `app/hooks/useDispatchBoardApi.ts`, add to the `DispatchBoardRow`
interface (currently lines 13-23):
```ts
export interface DispatchBoardRow {
  id: string;
  status: string;
  vehicleType: string | null;
  destination: string | null;
  round: number;
  createdAt: string;
  quoteCollectionDeadline: string | null;
  needsManualAssignment: boolean;
  offers: DispatchBoardOffer[];
}
```
In `app/components/tabs/DispatchBoardTab.tsx`, render the same badge
markup as Step 2 above, next to the existing status label (currently lines
173-175):
```tsx
<span style={{ fontSize: "0.82rem", fontWeight: 600, color: isLive ? "#084298" : "#666" }}>
  {REQUEST_STATUS_LABELS[row.status] ?? row.status}
</span>
{row.needsManualAssignment && (
  <span style={{ display: "inline-block", padding: "0.3rem 0.7rem", background: "#fff3cd", color: "#856404", borderRadius: 4, fontSize: "0.82rem", fontWeight: 600, marginLeft: 8 }}>
    Needs manual call
  </span>
)}
```
No new endpoint or architecture — this is the same boolean and the same
badge markup as Step 2, given a second consumer.

- [ ] **Step 5: Add candidate display and the "Assign this operator" action on the request detail view**

In the request detail modal/view, when `needsManualAssignment` is true, fetch and show the suggested non-WhatsApp candidate(s) — check whether a backend endpoint already exists for this (Task 3/4 only persist a boolean, per the spec's design candidates are re-ranked live, not persisted) or whether this task needs a new small read endpoint, e.g. `GET /rescue-requests/:id/manual-candidates`, returning `operatorService.findAndRankCandidates(..., false)` scoped to that request's lat/lon/vehicleType. If no such endpoint exists yet, add it:
```ts
// rescue-request.controller.ts
@Get(':id/manual-candidates')
@UseGuards(RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
async manualCandidates(@Param('id') id: string) {
  return this.rescueRequestAdminService.manualCandidatesFor(id);
}
```
```ts
// rescue-request-admin.service.ts
async manualCandidatesFor(id: string) {
  const request = await this.prisma.rescueRequest.findUnique({
    where: { id },
    select: {
      status: true,
      needsManualAssignment: true,
      latitude: true,
      longitude: true,
      vehicleType: true,
      offeredOperatorIds: true,
      dispatchRound: true,
    },
  });
  if (!request) throw new NotFoundException('Rescue request not found');
  if (
    request.status !== RescueRequestStatus.DISPATCHING ||
    !request.needsManualAssignment
  ) {
    throw new BadRequestException('This request does not currently need manual assignment.');
  }
  const eligibleTruckClasses = request.vehicleType
    ? getEligibleTruckClasses(request.vehicleType)
    : undefined;
  const candidates = await this.operatorService.findAndRankCandidates(
    Number(request.latitude),
    Number(request.longitude),
    request.offeredOperatorIds,
    Math.max(0, request.dispatchRound - 1) * RADIUS_EXPANSION_KM,
    undefined,
    eligibleTruckClasses,
    false,
  );
  return { data: candidates };
}
```
(Check `getEligibleTruckClasses`'s import path from `dispatch.service.ts` and import it the same way here.)

`RescueRequestAdminService` currently has no `OperatorService` dependency.
Explicitly import and inject it, make sure `OperatorModule` exports it and the
rescue-request module imports that module (or use the existing module graph if
already present), and update every TestingModule/direct constructor affected by
the new constructor parameter. Export/reuse a shared radius-expansion helper or
constant from the dispatch domain rather than duplicating a magic `2` in this
service; candidate display must use the same final expansion as fallback.

On the frontend, render each candidate with business name, phone, distance and
acceptance rate. The primary workflow is **Call operator** first. Only after
staff confirms availability and agrees the price should **Confirm assignment**
open/submit the existing price-entry flow. This ordering prevents a customer
receiving a deposit link before the off-platform operator has accepted.

- [ ] **Step 6: Type-check and manual verification**

Run: `npx tsc --noEmit`
Expected: no new errors.

Per this project's standing rule, start both dev servers and exercise this in a browser as SUPER_ADMIN: register a non-WhatsApp test operator, drive a test request through dispatch until it exhausts (or seed one directly flagged `needsManualAssignment: true` if driving a real exhaustion is impractical in dev), confirm the badge and candidate card appear on BOTH the Requests tab and the Dispatch Board, confirm "Assign this operator" completes the assignment and both badges disappear, confirm the "deposit paid, dispatch now" badge appears once a deposit clears (simulate via whatever this project's existing dev-mode payment-confirmation shortcut is, if one exists — check the QA test plan's §2 for the established way to confirm a deposit in dev).

- [ ] **Step 7: Commit**

This task touches both repos across Steps 1, 4, and 5 — the backend files
below are not optional extras, they're what those steps actually modify:

```bash
# lrr-service
git add src/rescue-request/rescue-request-admin.service.ts src/rescue-request/rescue-request-admin.service.spec.ts src/rescue-request/dto/rescue-request-response.dto.ts src/rescue-request/dispatch.service.ts src/rescue-request/dispatch.service.spec.ts src/rescue-request/rescue-request.controller.ts src/rescue-request/rescue-request.module.ts
npx jest --silent
npx eslint "{src,apps,libs,test}/**/*.ts" --max-warnings 525
git commit -m "Surface manual-assignment state and manual candidates on Requests tab, Dispatch Board, and detail view"

# lrr-web
git add app/components/tabs/RescueRequestsTabAdmin.tsx app/hooks/useRescueRequestApi.ts app/hooks/useDispatchBoardApi.ts app/components/tabs/DispatchBoardTab.tsx
git commit -m "Surface manual-assignment and dispatch-now states on the Requests tab and Dispatch Board"
```
(Adjust the exact file list to whatever Steps 1, 4, and 5 actually touched —
e.g. if Step 5's `OperatorService` injection required module-graph changes
beyond `rescue-request.module.ts`, include those files too.)

---

### Task 15: Integration test — full manual-dispatch scenario

**Files:**
- Create: `test/integration/non-whatsapp-manual-dispatch.int-spec.ts`

**Interfaces:**
- Consumes: the complete backend workflow, including the existing customer CONFIRM, balance-payment confirmation, and completion services — this is a service-level integration test, not browser-driven.

- [ ] **Step 1: Write the test**

Follow this repo's established integration-test conventions (`test/integration/factories.ts`'s `createCustomer`/`createOperator`/`createRequest` helpers, `truncateAll` in `beforeEach`, real `PrismaService` instances, real service instantiation rather than DI where these services' constructors are simple enough — check how `test/integration/payment-deposit-flow.int-spec.ts` or `account-deletion.int-spec.ts` instantiate services directly for the established pattern):
```ts
import { PrismaService } from '../../src/prisma/prisma.service';
import { DispatchService } from '../../src/rescue-request/dispatch.service';
import { RescueRequestAdminService } from '../../src/rescue-request/rescue-request-admin.service';
import { WhatsAppOperatorFlowService } from '../../src/rescue-request/whatsapp-operator-flow.service';
import { OperatorService } from '../../src/operator/operator.service';
import { truncateAll, createCustomer, createOperator, createRequest } from './factories';

describe('Non-WhatsApp operator manual dispatch (integration)', () => {
  let prisma: PrismaService;

  beforeAll(() => {
    prisma = new PrismaService();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  it('flags for manual assignment, gets assigned, dispatched, arrived, and completed — all without any WhatsApp send to the operator', async () => {
    const customer = await createCustomer(prisma);
    const operator = await createOperator(prisma, undefined, { whatsappEnabled: false });
    const request = await createRequest(prisma, customer.id, {
      status: 'DISPATCHING',
      dispatchRound: 0,
    });

    // 1. Simulate exhaustion directly (a full round-by-round dispatch drive
    //    is covered by dispatch.service's own integration tests) — call
    //    resolveExhaustion directly inside a transaction, the same way
    //    startDispatch/BatchResolveCheck do.
    // ...

    // 2. Assert needsManualAssignment flipped true.
    // 3. Call RescueRequestAdminService.assignOperator — assert it succeeds,
    //    the flag clears, status is WAITING_FOR_DEPOSIT.
    // 4. Manually move status to OPERATOR_ASSIGNED (simulating deposit
    //    confirmation, already covered elsewhere) and assert the
    //    "deposit paid, dispatch now" derived condition
    //    (assignedOperator.whatsappEnabled === false && status ===
    //    OPERATOR_ASSIGNED) is now true via a fresh read.
    // 5. Call RescueRequestAdminService.claimManualArrived (the atomic
    //    status write — this is what PATCH manual-arrived actually calls
    //    before notifying) — assert status is ARRIVED and claimed: true.
    //    THEN call WhatsAppOperatorFlowService.notifyCustomerOperatorArrived
    //    separately — assert the customer receives the arrival message.
    //    notifyCustomerOperatorArrived does NOT write status itself (Task
    //    9's fix) — calling only it, without the claim first, would leave
    //    status unchanged and this assertion would catch that regression.
    // 6. Call the same service operation used by PATCH manual-done — assert
    //    confirmationDueAt is set and the customer's WhatsAppSession moved to
    //    AWAITING_COMPLETION_CONFIRM, with NO RequestMedia row required.
    // 7. Send the customer's real CONFIRM command through the existing
    //    customer-flow entry point. Assert the request advances to the
    //    balance-payment state and a BALANCE Payment/link is created exactly
    //    as it is for a WhatsApp-operated job.
    // 8. Confirm that BALANCE payment through the existing payment-events
    //    service/webhook path. Assert the request reaches COMPLETED and the
    //    normal customer completion/rating side effects occur.
    // 9. Assert no outbound WhatsApp recipient was ever the operator's phone,
    //    and RequestMedia count remains zero by deliberate exemption. Compare
    //    the remaining financial/status state to the normal completed flow;
    //    do not claim the media state is indistinguishable.
  });
});
```
Check `createOperator`'s current signature in `test/integration/factories.ts` — it may not currently accept an overrides parameter; if not, extend it the same way `createRequest`'s `overrides: Record<string, unknown> = {}` parameter already works, rather than adding a separate one-off helper.

- [ ] **Step 2: Run and verify**

Run: `npx jest --config test/integration/jest-integration.json test/integration/non-whatsapp-manual-dispatch.int-spec.ts`
Expected: PASS.

The test is incomplete unless its final persisted request status is
`COMPLETED`, a successful BALANCE payment exists, the customer's actual
CONFIRM branch was exercised, and the non-WhatsApp operator received zero
WhatsApp sends across the whole scenario.

- [ ] **Step 3: Full suite, lint, commit**

```bash
npx jest --silent
npx jest --config test/integration/jest-integration.json
npx eslint "{src,apps,libs,test}/**/*.ts" --max-warnings 525
git add test/integration/non-whatsapp-manual-dispatch.int-spec.ts test/integration/factories.ts
git commit -m "Add end-to-end integration test for non-WhatsApp manual dispatch"
```

---

### Task 16: QA test plan — new section

**Files:**
- Modify: `docs/qa/2026-09-10-full-system-test-plan.md`

- [ ] **Step 1: Add a new numbered section**

Following the exact style of §17/§18 (numbered checkboxes, **Expected:** blocks, a short intro paragraph), add a new section covering: registering a non-WhatsApp operator (checkbox unchecked), confirming no dispatch offer ever reaches them during normal automatic dispatch, driving a request to exhaustion (or seeding one directly) and confirming the "Needs manual call" badge + candidate card appear, calling the candidate before confirming assignment and confirming no WhatsApp message reaches the operator, confirming `CHAT DRIVER` reports chat unavailable without opening a relay, confirming the "deposit paid, dispatch now" badge appears once the customer pays, using `manual-arrived`/`manual-done` and confirming the customer receives the identical WhatsApp prompts a normal job would send, cancelling a flagged request and confirming the manual-call badge disappears, and confirming the whole job completes through the customer's existing CONFIRM/balance-payment flow with no photo evidence required.

- [ ] **Step 2: Commit**

```bash
git add docs/qa/2026-09-10-full-system-test-plan.md
git commit -m "docs: add QA section for non-WhatsApp operator manual dispatch"
```

---

## Self-Review

**Spec coverage:**
- Section 1 (data model) → Task 1.
- Section 2 (candidate ranking filter) → Task 2.
- Section 3 (round-exhaustion resolver, preservation of the final expanded radius, both callers, the `alertAdminNoOperator` correction, the ordering note) → Tasks 3, 4.
- Section 4 (`assignOperator` — skip-send, clear flag, backend enforcement) → Task 5.
- Background's operator-channel inventory → Tasks 5 (site in `rescue-request-admin.service.ts`), 6 (`payment-events.service.ts`), 7 (`whatsapp-customer-flow.service.ts`, including full CHAT DRIVER/relay behavior), 8 (`dispatch.service.ts`), and 8A (`whatsapp-inbound.service.ts`; it has no outbound send, but its operator-routing behavior is explicitly blocked for off-platform operators).
- The "attention now, not history" invariant for `needsManualAssignment` → Task 5 clears on assignment; Task 8B clears atomically at every cancellation writer.
- Section 5 (badge on BOTH the Requests tab and the Dispatch Board, candidate cards + Assign action, the second deposit-paid handoff badge) → Task 14 (plus the small new `manual-candidates` read endpoint it required, not explicitly named in the spec but necessary to serve live-ranked candidates to the frontend — the spec's Section 5 said candidates are "re-ranked live," which requires *some* endpoint to do that ranking on demand; added as part of Task 14 rather than a separate task since it's small and the frontend task can't be completed without it). Found in review: an earlier draft only covered the Requests tab — the Dispatch Board is a genuinely separate projection (`DispatchService.getDispatchBoard()` → `DispatchBoardRowDto`, not `buildListResponse()` → `RescueRequestListItemDto`) with its own frontend (`DispatchBoardTab.tsx`/`useDispatchBoardApi.ts`), confirmed by direct read, and needed its own step (Task 14 Step 4) to carry the same badge.
- Section 6 (atomic status guards, evidence-exemption decision, `notifyCustomerOperatorArrived`/`startManualCompletionConfirmation`, the two new endpoints) → Tasks 9, 10.
- Section 7 (audit logging for both new actions, and for `assignOperator` itself) → Tasks 10, 11. Task 11 also exposes `OperatorDetailDto.whatsappEnabled`, moved forward from an earlier draft's Task 14 to fix a real task-ordering dependency bug found in review — Task 11's own controller code and tests needed this field to exist from the start, not three tasks later. A second review pass found Task 11's own Step 1 had a false claim alongside that fix — it said every `mapToDetailDto` caller does a full-row `include: { assignedOperator: true }`, but `operatorDetail()` and `detailForUser()` both use a narrowed `select` that would silently omit `whatsappEnabled`; confirmed by direct read and fixed by adding `whatsappEnabled: true` to both selects, with regression tests asserting the select shape.
- Section 8 (registration) → Tasks 12, 13.
- Testing section → distributed across every task's own Step 1/2, plus Task 15's integration test.

**Placeholder scan:** No bare "TBD"/"TODO". Task 14 now explicitly requires the known list/detail mapping changes and the new `OperatorService` dependency/module/test wiring. Task 15's factory-extension note still directs the implementer to inspect the helper's current signature before making the mechanical extension; the required final scenario and assertions are fully specified.

**Type consistency:** `PrepareNextRoundResult` carries `extraRadiusKm` on every exhausted result; both Task 3 and Task 4 pass it unchanged to `resolveExhaustion`. `ExhaustionResolution`'s two variants are consumed identically in both callers. `findAndRankCandidates`'s 7th parameter (`whatsappOnly: boolean = true`, Task 2) is called with `false` identically in Task 3's resolver and Task 14's guarded live-candidate endpoint. Task 10's manual transitions own their status/channel checks transactionally; controller reads are used only to explain a failed claim and build audit details, never as the guard itself. `notifyCustomerOperatorArrived(): Promise<void>` (notification-only, no status write) vs. `startManualCompletionConfirmation(): Promise<{claimed: boolean}>` (self-contained atomic) are two different shapes for a deliberate reason (Task 9) — the first is shared with an unconditional WhatsApp-path write and can't own a conditional claim itself without breaking that sharing; the second has no WhatsApp-path equivalent to share with, so it owns its claim internally. `OperatorDetailDto.whatsappEnabled` (Task 11, added ahead of when it's first read, fixing a real task-ordering bug an earlier draft had — Task 11's own controller code read this field, and its own tests mocked it, three tasks before anything added it) is consumed by Task 11 itself; Task 14 explicitly does not re-add it, only the separate `OperatorSummaryDto.whatsappEnabled` (list path, a different DTO with its own narrowed Prisma `select`) and the top-level `needsManualAssignment` field on both list and detail DTOs, which Task 11 never touched.
