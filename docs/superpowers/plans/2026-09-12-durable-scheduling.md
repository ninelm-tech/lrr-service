# Durable Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every in-memory `setTimeout` job with a database-driven reconciler, so a deploy or restart can no longer strand in-flight rescue requests.

**Architecture:** Deadlines become columns on `RescueRequest` and `DispatchOffer`. A single `ReconcilerService` wakes every 15 seconds and runs independent checks; each check matches only rows whose work is outstanding, claims them with a conditional update inside a transaction, and sends notifications only after that transaction commits. Acting moves a row out of its own match, so no check can fire twice.

**Tech Stack:** NestJS, Prisma (Postgres via `@prisma/adapter-pg`), Jest. Integration tests run against real Postgres via `docker-compose.test.yml` and `yarn test:integration`.

**Spec:** `docs/superpowers/specs/2026-09-12-durable-scheduling-design.md` — read it before starting. This plan implements it and does not restate its reasoning.

## Global Constraints

- **Tick interval is 15 seconds.** `RECONCILER_INTERVAL_MS = 15 * 1000`.
- **The query is the guard.** Every check matches only outstanding work; the claim must move the row out of that match. Never filter in JavaScript what belongs in the `WHERE`.
- **Claim and required domain writes share one transaction.** Notifications happen only after it commits, are best-effort, and failures go to Sentry — never retried.
- **Never read-then-act across a boundary.** Any condition a decision depends on must appear in the conditional update itself, not in a prior `SELECT`.
- **Every added column is nullable or has a default** (including a temporary one dropped in the same migration). A `NOT NULL` column with no default fails on populated staging while passing on empty CI and prod.
- **Deposit window:** 30 minutes. Reminder marks: 25, 15 and 5 minutes **before** expiry.
- **All eight timer call sites are deleted** by the end of this plan. `grep -rn "setTimeout\|scheduleSafely" src --include="*.ts" | grep -v spec | grep -v safe-timer` must return nothing outside the reconciler's own `setInterval`.
- **No backfill.** The product has no live users; in-flight rows simply never fire.
- Run `yarn tsc --noEmit`, `yarn jest` and `yarn test:integration` before every commit.
- Integration tests need Postgres: `yarn test:integration:up` once per session.

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/rescue-request/reconciler/reconciler-check.interface.ts` | The `ReconcilerCheck` contract every check implements |
| `src/rescue-request/reconciler/reconciler.service.ts` | The 15s loop: ordering, per-check isolation, overlap guard |
| `src/rescue-request/reconciler/checks/offer-sweep.check.ts` | Absorbs `DispatchOfferSweeperService`'s two sweeps |
| `src/rescue-request/reconciler/checks/deposit-expiry.check.ts` | Cancel at the 30-minute deadline |
| `src/rescue-request/reconciler/checks/deposit-reminder.check.ts` | The 25/15/5-minutes-left nudges |
| `src/rescue-request/reconciler/checks/bidding-close.check.ts` | Close bidding, send the shortlist |
| `src/rescue-request/reconciler/checks/batch-resolve.check.ts` | Expire a batch; progress dispatch under CAS |
| `src/rescue-request/reconciler/checks/quote-selection-timeout.check.ts` | Cancel when the motorist never chooses |
| `src/rescue-request/reconciler/checks/stalled-confirmation.check.ts` | Alert staff on an unconfirmed job |

**Deleted:**

| File | Why |
|---|---|
| `src/rescue-request/dispatch-offer-sweeper.service.ts` | Absorbed by `offer-sweep.check.ts` |
| `src/common/safe-timer.ts` | No scheduled callbacks remain to wrap |

**Modified:** `prisma/schema.prisma`, `src/rescue-request/rescue-request.module.ts`, `src/rescue-request/rescue-request-shared.service.ts`, `src/rescue-request/dispatch.service.ts`, `src/rescue-request/whatsapp-customer-flow.service.ts`, `src/rescue-request/whatsapp-operator-flow.service.ts`, `src/rescue-request/rescue-request-admin.service.ts`, `src/rescue-request/state/whatsapp-session.store.ts`, `src/rescue-request/state/whatsapp-session.types.ts`.

---

### Task 1: Schema and migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_durable_scheduling/migration.sql`
- Test: `test/integration/migration.int-spec.ts`

**Interfaces:**
- Produces: `RescueRequest.depositWindowExpiresAt`, `.depositRemindersSent`, `.biddingClosedAt`, `.quoteSelectionExpiresAt`, `.confirmationDueAt`, `.dispatchRound`, `.offeredOperatorIds`; `DispatchOffer.dispatchRound`.

- [ ] **Step 1: Add the columns to the Prisma schema**

In `model RescueRequest`, after `quoteCollectionDeadline`:

```prisma
  depositWindowExpiresAt  DateTime?
  depositRemindersSent    Int       @default(0)
  biddingClosedAt         DateTime?
  quoteSelectionExpiresAt DateTime?
  confirmationDueAt       DateTime?
  dispatchRound           Int       @default(0)
  offeredOperatorIds      String[]  @default([])

  @@index([depositWindowExpiresAt])
  @@index([quoteCollectionDeadline])
  @@index([quoteSelectionExpiresAt])
  @@index([confirmationDueAt])
```

In `model DispatchOffer`, after `batchId` — note **no** `@default`:

```prisma
  dispatchRound    Int
```

- [ ] **Step 2: Generate the migration without applying it**

Run: `npx prisma migrate dev --name durable_scheduling --create-only`

Expected: a migration directory is created. Prisma will have generated
`ALTER TABLE "DispatchOffer" ADD COLUMN "dispatchRound" INTEGER NOT NULL;`
which fails on a populated table.

- [ ] **Step 3: Hand-edit the generated SQL**

Replace the `DispatchOffer` statement with exactly these two lines:

```sql
ALTER TABLE "DispatchOffer" ADD COLUMN "dispatchRound" INTEGER NOT NULL DEFAULT -1;
ALTER TABLE "DispatchOffer" ALTER COLUMN "dispatchRound" DROP DEFAULT;
```

Leave the `RescueRequest` statements as generated — every one of those columns is nullable or defaulted already.

- [ ] **Step 4: Write the failing test**

Create `test/integration/migration.int-spec.ts`:

```ts
import { execSync } from 'child_process';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createCustomer, createOperator, createRequest, truncateAll } from './factories';

describe('durable_scheduling migration (integration)', () => {
  let prisma: PrismaService;

  beforeAll(() => { prisma = new PrismaService(); });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(async () => { await truncateAll(prisma); });

  it('leaves legacy offers on a round no request can ever occupy', async () => {
    const customer = await createCustomer(prisma);
    const operator = await createOperator(prisma);
    const request = await createRequest(prisma, customer.id);

    // Simulate a row written before the migration: insert bypassing the
    // Prisma client's now-required dispatchRound, then read it back.
    await prisma.$executeRawUnsafe(`
      INSERT INTO "DispatchOffer"
        ("id","rescueRequestId","operatorId","status","expiresAt","batchId","dispatchRound","offeredAt")
      VALUES ('legacy-1', $1, $2, 'PENDING', now() + interval '10 minutes', 'legacy-batch', -1, now())
    `, request.id, operator.id);

    const legacy = await prisma.dispatchOffer.findUnique({ where: { id: 'legacy-1' } });
    expect(legacy?.dispatchRound).toBe(-1);

    // A fresh request starts at round 0, so -1 can never match it.
    expect(request.dispatchRound).toBe(0);
    expect(legacy!.dispatchRound).not.toBe(request.dispatchRound);
  });

  it('requires an explicit dispatchRound on new offers — the column has no default', async () => {
    const customer = await createCustomer(prisma);
    const operator = await createOperator(prisma);
    const request = await createRequest(prisma, customer.id);

    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "DispatchOffer"
          ("id","rescueRequestId","operatorId","status","expiresAt","batchId","offeredAt")
        VALUES ('no-round', $1, $2, 'PENDING', now() + interval '10 minutes', 'b', now())
      `, request.id, operator.id),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `yarn test:integration:up && yarn test:integration migration`
Expected: FAIL — the columns do not exist yet.

- [ ] **Step 6: Apply the migration and regenerate the client**

Run: `npx prisma migrate dev && npx prisma generate`

- [ ] **Step 7: Verify the migration is safe against a populated table**

This is the failure CI cannot catch, so prove it locally — and note that the
proof requires a row to exist **before** the new migration runs. Migrating an
empty database always succeeds and demonstrates nothing:

```bash
# 1. Fresh database.
docker compose -f docker-compose.test.yml down -v
yarn test:integration:up
export DATABASE_URL=postgresql://lrr:lrr@localhost:5433/lrr_test

# 2. Build the schema as it was BEFORE this change, by holding the new
#    migration back.
mv prisma/migrations/*_durable_scheduling /tmp/pending-migration
npx prisma migrate deploy

# 3. Seed a DispatchOffer, so the table is populated exactly as staging is.
docker compose -f docker-compose.test.yml exec -T postgres-test \
  psql -U lrr -d lrr_test -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO "User" (id, "phoneNumber", role, "createdAt", "updatedAt")
  VALUES ('mig-user', '+2348000000001', 'CUSTOMER', now(), now());
INSERT INTO "Operator" (id, "businessName", "contactName", "phoneNumber", address, latitude, longitude, status, "createdAt", "updatedAt")
  VALUES ('mig-op', 'Swift', 'Ada', '+2349000000001', 'Lekki', 6.4281, 3.4219, 'ACTIVE', now(), now());
INSERT INTO "RescueRequest" (id, "customerId", status, "createdAt", "updatedAt")
  VALUES ('mig-req', 'mig-user', 'DISPATCHING', now(), now());
INSERT INTO "DispatchOffer" (id, "rescueRequestId", "operatorId", status, "expiresAt", "batchId", "offeredAt")
  VALUES ('mig-offer', 'mig-req', 'mig-op', 'PENDING', now() + interval '10 minutes', 'mig-batch', now());
SQL

# 4. Now apply the real thing. THIS is the test.
mv /tmp/pending-migration prisma/migrations/
npx prisma migrate deploy

# 5. The legacy row must have been given the sentinel.
docker compose -f docker-compose.test.yml exec -T postgres-test \
  psql -U lrr -d lrr_test -c 'SELECT "dispatchRound" FROM "DispatchOffer" WHERE id = '"'"'mig-offer'"'"';'
```

Expected: step 4 applies cleanly and step 5 prints `-1`. If the migration
still carries `ADD COLUMN ... NOT NULL` with no default, step 4 fails with
*"column contains null values"* — which is exactly what would have happened on
staging while CI stayed green.

Reset afterwards: `docker compose -f docker-compose.test.yml down -v && yarn test:integration:up`

- [ ] **Step 8: Run the tests**

Run: `yarn test:integration migration`
Expected: PASS, both tests.

- [ ] **Step 9: Give the test factory a round**

`DispatchOffer.dispatchRound` is now required, so every existing factory call
fails to compile until it has a value. In `test/integration/factories.ts`, add
it to `createOffer`'s defaults — before the `...overrides` spread, so a test
can still choose its own round:

```ts
      status: 'PENDING',
      dispatchRound: 0,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
```

Do this now rather than in a later task: without it, the offer-sweep tests
migrated in Task 2 break for a reason unrelated to Task 2's change.

- [ ] **Step 9b: Stamp a round at all three offer-creation sites**

`DispatchOffer.dispatchRound` is required from this migration onward, so the
production code stops compiling until every create supplies one. Deferring
this to Task 5 would leave Tasks 1-4 unable to typecheck, so the tree could
not be committed green — the fix belongs here.

Use the round each site's *current* authority already holds; Task 5 changes
where that authority lives, not what these writes mean. There are **three**
sites, not the two Task 5 lists:

`dispatch.service.ts`, `startDispatch`'s `createMany` — `round` is already in
scope:

```ts
        batchId,
        dispatchRound: round,
```

`dispatch.service.ts`, `manualOfferToOperator` — the session read that follows
the create must be hoisted above it, so the round is known when the offer is
written:

```ts
    const session = await this.sessionStore.getOrCreate(rescueRequest.customerId);

    await this.prisma.dispatchOffer.create({
      data: { rescueRequestId, operatorId, expiresAt, batchId,
              dispatchRound: session.dispatchRound ?? 0 },
    });
```

`rescue-request-admin.service.ts` (~line 145) — a direct admin assignment,
which Task 5's list omits. It belongs to no bidding round, so the request's
own round is the truthful value; the offer is created
`SELECTED_PENDING_PAYMENT` rather than `PENDING`, so batch resolve never
matches it and the round is bookkeeping only:

```ts
        batchId,
        dispatchRound: request.dispatchRound,
```

- [ ] **Step 10: Run the full suite**

Run: `yarn tsc --noEmit && yarn jest && yarn test:integration`
Expected: all green — existing tests unaffected by the new columns.

- [ ] **Step 11: Commit**

```bash
git add prisma/schema.prisma prisma/migrations test/integration
git commit -m "feat: add durable scheduling deadline columns"
```

---

### Task 2: Reconciler skeleton, absorbing the offer sweeper

**Files:**
- Create: `src/rescue-request/reconciler/reconciler-check.interface.ts`
- Create: `src/rescue-request/reconciler/reconciler.service.ts`
- Create: `src/rescue-request/reconciler/checks/offer-sweep.check.ts`
- Create: `src/rescue-request/reconciler/reconciler.service.spec.ts`
- Create: `test/integration/reconciler-offer-sweep.int-spec.ts`
- Delete: `src/rescue-request/dispatch-offer-sweeper.service.ts`, `src/rescue-request/dispatch-offer-sweeper.service.spec.ts`, `test/integration/dispatch-offer-sweeper.int-spec.ts`
- Modify: `src/rescue-request/rescue-request.module.ts`

**Interfaces:**
- Produces: `ReconcilerCheck { readonly name: string; run(now: Date): Promise<number> }`; `ReconcilerService.tick(now?: Date): Promise<void>`; `RECONCILER_CHECKS` injection token.

- [ ] **Step 1: Define the check contract**

Create `src/rescue-request/reconciler/reconciler-check.interface.ts`:

```ts
/**
 * One unit of due work. A check matches only rows whose work is still
 * outstanding, claims them with a conditional update, and returns how many
 * it acted on. Acting must move the row out of its own match, so running a
 * check twice is harmless.
 */
export interface ReconcilerCheck {
  /** Used in logs and Sentry context — a bare stack trace from inside the loop identifies nothing. */
  readonly name: string;
  run(now: Date): Promise<number>;
}

export const RECONCILER_CHECKS = Symbol('RECONCILER_CHECKS');
```

- [ ] **Step 2: Write the failing test for the loop**

Create `src/rescue-request/reconciler/reconciler.service.spec.ts`:

```ts
import { ReconcilerService } from './reconciler.service';
import { ReconcilerCheck } from './reconciler-check.interface';

const check = (name: string, impl: () => Promise<number>): ReconcilerCheck => ({ name, run: impl });

describe('ReconcilerService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('runs every check', async () => {
    const a = jest.fn().mockResolvedValue(0);
    const b = jest.fn().mockResolvedValue(0);
    const service = new ReconcilerService([check('a', a), check('b', b)]);

    await service.tick();

    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
  });

  it('keeps running later checks when an earlier one throws', async () => {
    const boom = jest.fn().mockRejectedValue(new Error('db down'));
    const after = jest.fn().mockResolvedValue(0);
    const service = new ReconcilerService([check('boom', boom), check('after', after)]);

    await expect(service.tick()).resolves.toBeUndefined();
    expect(after).toHaveBeenCalled();
  });

  it('skips a tick while the previous one is still running, so a slow database cannot pile ticks up', async () => {
    let release!: () => void;
    const slow = jest.fn().mockImplementation(() => new Promise<number>((r) => { release = () => r(0); }));
    const service = new ReconcilerService([check('slow', slow)]);

    const first = service.tick();
    await service.tick(); // must return immediately without invoking the check again

    expect(slow).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  it('passes one consistent timestamp to every check', async () => {
    const seen: Date[] = [];
    const record = jest.fn().mockImplementation((now: Date) => { seen.push(now); return Promise.resolve(0); });
    const service = new ReconcilerService([check('a', record), check('b', record)]);

    await service.tick();

    expect(seen[0]).toBe(seen[1]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `yarn jest reconciler.service`
Expected: FAIL — `Cannot find module './reconciler.service'`.

- [ ] **Step 4: Implement the loop**

Create `src/rescue-request/reconciler/reconciler.service.ts`:

```ts
import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { logger } from '@sentry/node';
import { RECONCILER_CHECKS, ReconcilerCheck } from './reconciler-check.interface';

@Injectable()
export class ReconcilerService implements OnModuleInit, OnModuleDestroy {
  private readonly INTERVAL_MS = 15 * 1000;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(@Inject(RECONCILER_CHECKS) private readonly checks: ReconcilerCheck[]) {}

  onModuleInit() {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * One pass over every check.
   *
   * Never rejects: a check that throws is reported and the rest still run,
   * because one failing query must not stop unrelated work. Overlapping
   * ticks are skipped rather than queued — a database slow enough to
   * outlast the interval would otherwise accumulate concurrent passes.
   */
  async tick(now: Date = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const check of this.checks) {
        try {
          const acted = await check.run(now);
          if (acted > 0) logger.info('reconciler: acted', { check: check.name, count: acted });
        } catch (error) {
          console.error(`Reconciler check "${check.name}" failed:`, error);
          Sentry.captureException(error, { extra: { reconcilerCheck: check.name } });
        }
      }
    } finally {
      this.running = false;
    }
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `yarn jest reconciler.service`
Expected: PASS, 4 tests.

- [ ] **Step 6: Move the sweeper's two sweeps into a check**

Create `src/rescue-request/reconciler/checks/offer-sweep.check.ts`, carrying over the logic and comments from `dispatch-offer-sweeper.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { RescueRequestStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { ReconcilerCheck } from '../reconciler-check.interface';

/**
 * Closes dispatch offers that can no longer be answered: those past their
 * own expiry, and those on a request that has already ended.
 *
 * CRITICAL — this check must NOT touch expired offers on a request that is
 * still DISPATCHING. Those belong to BatchResolveCheck, which needs to see
 * them to decide whether to shortlist or start the next round. Sweeping
 * them here would consume the batch first and dispatch would silently stop
 * progressing: batch resolve would find nothing to resolve, every round,
 * forever. Ownership is expressed in the predicate below, not in run order,
 * so re-ordering the checks cannot reintroduce it.
 */
@Injectable()
export class OfferSweepCheck implements ReconcilerCheck {
  readonly name = 'offer-sweep';
  private readonly MAX_PER_PASS = 500;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * One query, because both sweeps share the same exclusion. Prisma's
   * updateMany takes scalar filters only, so the relation conditions live
   * in a findMany and the write is by id.
   */
  async run(now: Date): Promise<number> {
    const sweepable = await this.prisma.dispatchOffer.findMany({
      where: {
        status: 'PENDING',
        // Batch resolve owns anything on a live dispatch.
        rescueRequest: { status: { not: RescueRequestStatus.DISPATCHING } },
        OR: [
          { expiresAt: { lt: now } },
          { rescueRequest: { status: { in: [RescueRequestStatus.COMPLETED, RescueRequestStatus.CANCELLED] } } },
        ],
      },
      select: { id: true },
      take: this.MAX_PER_PASS,
    });
    if (sweepable.length === 0) return 0;

    const { count } = await this.prisma.dispatchOffer.updateMany({
      where: { id: { in: sweepable.map((o) => o.id) }, status: 'PENDING' },
      data: { status: 'TIMED_OUT', respondedAt: now },
    });
    return count;
  }
}
```

Add a test to `reconciler-offer-sweep.int-spec.ts` pinning this ownership —
without it, a later "simplification" of the predicate silently kills dispatch:

```ts
  it('leaves expired offers alone while the request is still dispatching — batch resolve owns those', async () => {
    const customer = await createCustomer(prisma);
    const operator = await createOperator(prisma);
    const request = await createRequest(prisma, customer.id, { status: 'DISPATCHING' });
    const offer = await createOffer(prisma, request.id, operator.id, {
      expiresAt: new Date(Date.now() - 60_000),
    });

    await check.run(new Date());

    expect((await prisma.dispatchOffer.findUnique({ where: { id: offer.id } }))?.status).toBe('PENDING');
  });
```

Note this changes one of the five migrated assertions: the existing "still
closes an expired offer on a live request" test used a `DISPATCHING` request.
Change that test's request status to `WAITING_FOR_DEPOSIT` — it is still a
live request, but not one batch resolve owns.

- [ ] **Step 7: Move the sweeper's integration tests onto the check**

Rename `test/integration/dispatch-offer-sweeper.int-spec.ts` to `test/integration/reconciler-offer-sweep.int-spec.ts`. Replace its construction with:

```ts
    prisma = new PrismaService();
    check = new OfferSweepCheck(prisma);
```

and every `await sweeper.sweep()` with `await check.run(new Date())`. Keep all five existing assertions unchanged — they are the regression suite for behaviour this task must preserve.

- [ ] **Step 8: Register the reconciler and delete the sweeper**

In `src/rescue-request/rescue-request.module.ts`, remove the `DispatchOfferSweeperService` import and provider, and add:

```ts
import { ReconcilerService } from './reconciler/reconciler.service';
import { RECONCILER_CHECKS } from './reconciler/reconciler-check.interface';
import { OfferSweepCheck } from './reconciler/checks/offer-sweep.check';
```

and to `providers`:

```ts
    OfferSweepCheck,
    ReconcilerService,
    {
      provide: RECONCILER_CHECKS,
      useFactory: (offerSweep: OfferSweepCheck) => [offerSweep],
      inject: [OfferSweepCheck],
    },
```

Then delete `src/rescue-request/dispatch-offer-sweeper.service.ts` and `src/rescue-request/dispatch-offer-sweeper.service.spec.ts`.

- [ ] **Step 9: Verify**

Run: `yarn tsc --noEmit && yarn jest && yarn test:integration`
Expected: all green; the five offer-sweep integration tests still pass against the new check.

- [ ] **Step 10: Commit**

```bash
git add src/rescue-request/reconciler src/rescue-request/rescue-request.module.ts test/integration
git rm src/rescue-request/dispatch-offer-sweeper.service.ts src/rescue-request/dispatch-offer-sweeper.service.spec.ts
git commit -m "refactor: replace the offer sweeper with a reconciler loop"
```

---

### Task 3: Deposit expiry check

**Files:**
- Create: `src/rescue-request/reconciler/checks/deposit-expiry.check.ts`
- Create: `test/integration/reconciler-deposit-expiry.int-spec.ts`
- Create: `src/rescue-request/deposit.constants.ts`
- Modify: `src/rescue-request/rescue-request-shared.service.ts` (delete `scheduleDepositWindow`), `src/rescue-request/whatsapp-customer-flow.service.ts` (`handleQuoteSelected`'s claim, ~line 1010), `src/rescue-request/rescue-request-admin.service.ts` (~line 206), `src/rescue-request/rescue-request.module.ts`

**Interfaces:**
- Consumes: `ReconcilerCheck`, `RESCUE_REQUEST.depositWindowExpiresAt`.
- Produces: `DepositExpiryCheck`; `DEPOSIT_WINDOW_MS` as a shared constant. **Removes** `RescueRequestSharedService.scheduleDepositWindow` with no helper replacing it — see Step 5.

- [ ] **Step 1: Write the failing test**

Create `test/integration/reconciler-deposit-expiry.int-spec.ts`:

```ts
import { DepositExpiryCheck } from '../../src/rescue-request/reconciler/checks/deposit-expiry.check';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createCustomer, createOffer, createOperator, createRequest, truncateAll } from './factories';

describe('DepositExpiryCheck (integration)', () => {
  let prisma: PrismaService;
  let twilio: { sendWhatsAppMessage: jest.Mock };
  let check: DepositExpiryCheck;

  const past = () => new Date(Date.now() - 60_000);
  const future = () => new Date(Date.now() + 60_000);

  beforeAll(() => { prisma = new PrismaService(); });
  afterAll(async () => { await prisma.$disconnect(); });

  beforeEach(async () => {
    await truncateAll(prisma);
    twilio = { sendWhatsAppMessage: jest.fn().mockResolvedValue(undefined) };
    check = new DepositExpiryCheck(prisma, twilio as any);
  });

  async function awaitingDeposit(expiresAt: Date) {
    const customer = await createCustomer(prisma);
    const operator = await createOperator(prisma);
    const request = await createRequest(prisma, customer.id, {
      status: 'WAITING_FOR_DEPOSIT',
      depositWindowExpiresAt: expiresAt,
      assignedOperatorId: operator.id,
    });
    const offer = await createOffer(prisma, request.id, operator.id, {
      status: 'SELECTED_PENDING_PAYMENT',
      dispatchRound: 0,
    });
    return { request, operator, offer };
  }

  it('cancels the request once the window has passed', async () => {
    const { request } = await awaitingDeposit(past());

    await check.run(new Date());

    const after = await prisma.rescueRequest.findUnique({ where: { id: request.id } });
    expect(after?.status).toBe('CANCELLED');
  });

  it('releases the operator’s held offer in the same transaction as the cancel', async () => {
    const { offer } = await awaitingDeposit(past());

    await check.run(new Date());

    const after = await prisma.dispatchOffer.findUnique({ where: { id: offer.id } });
    expect(after?.status).toBe('TIMED_OUT');
  });

  it('does nothing before the window passes', async () => {
    const { request } = await awaitingDeposit(future());

    await check.run(new Date());

    const after = await prisma.rescueRequest.findUnique({ where: { id: request.id } });
    expect(after?.status).toBe('WAITING_FOR_DEPOSIT');
    expect(twilio.sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it('does not act twice — the cancel moves the row out of its own match', async () => {
    await awaitingDeposit(past());

    await check.run(new Date());
    twilio.sendWhatsAppMessage.mockClear();
    await check.run(new Date());

    expect(twilio.sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it('acts once when two ticks run concurrently', async () => {
    await awaitingDeposit(past());

    await Promise.all([check.run(new Date()), check.run(new Date())]);

    // Two messages for one cancellation: one to the motorist, one to the operator.
    expect(twilio.sendWhatsAppMessage).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:integration deposit-expiry`
Expected: FAIL — `Cannot find module '.../deposit-expiry.check'`.

- [ ] **Step 3: Implement the check**

Create `src/rescue-request/reconciler/checks/deposit-expiry.check.ts`:

```ts
import { Injectable } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { DispatchOfferStatus, RescueRequestStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { TwilioService } from '../../../integrations/twilio/twilio.service';
import { toWhatsAppAddress } from '../../../common/phone.util';
import { formatJobRef } from '../../domain/rescue-request-formatting';
import { ReconcilerCheck } from '../reconciler-check.interface';

@Injectable()
export class DepositExpiryCheck implements ReconcilerCheck {
  readonly name = 'deposit-expiry';
  private readonly MAX_PER_PASS = 100;

  constructor(
    private readonly prisma: PrismaService,
    private readonly twilioService: TwilioService,
  ) {}

  async run(now: Date): Promise<number> {
    const due = await this.prisma.rescueRequest.findMany({
      where: {
        status: RescueRequestStatus.WAITING_FOR_DEPOSIT,
        depositWindowExpiresAt: { lt: now },
      },
      select: { id: true },
      take: this.MAX_PER_PASS,
    });

    let acted = 0;
    for (const { id } of due) {
      if (await this.expire(id, now)) acted += 1;
    }
    return acted;
  }

  /**
   * Claim and every write that must be consistent with it commit together.
   * Cancelling without releasing the held offer would leave a request no
   * check can ever match again: the claim below requires
   * WAITING_FOR_DEPOSIT, which the cancel itself removes.
   */
  private async expire(rescueRequestId: string, now: Date): Promise<boolean> {
    const claimed = await this.prisma.$transaction(async (tx) => {
      // The deadline belongs in the claim, not only in the query above: if
      // it were extended between the two (an admin granting more time), a
      // claim on status alone would still cancel.
      const { count } = await tx.rescueRequest.updateMany({
        where: {
          id: rescueRequestId,
          status: RescueRequestStatus.WAITING_FOR_DEPOSIT,
          depositWindowExpiresAt: { lt: now },
        },
        data: { status: RescueRequestStatus.CANCELLED },
      });
      if (count === 0) return null;

      await tx.dispatchOffer.updateMany({
        where: { rescueRequestId, status: DispatchOfferStatus.SELECTED_PENDING_PAYMENT },
        data: { status: DispatchOfferStatus.TIMED_OUT, respondedAt: now },
      });

      return tx.rescueRequest.findUnique({
        where: { id: rescueRequestId },
        include: { customer: true, assignedOperator: true },
      });
    });

    if (!claimed) return false;

    // Notifications only after the transaction commits: best-effort, never retried.
    const jobRef = formatJobRef(rescueRequestId);
    try {
      if (claimed.customer?.phoneNumber) {
        await this.twilioService.sendWhatsAppMessage(
          claimed.customer.phoneNumber,
          `We didn't receive payment confirmation within 30 minutes, so your request was cancelled. If your payment completes after this, we'll refund it.`,
        );
      }
      if (claimed.assignedOperator?.phoneNumber) {
        await this.twilioService.sendWhatsAppMessage(
          toWhatsAppAddress(claimed.assignedOperator.phoneNumber),
          `⏰ ${jobRef} is no longer available — the customer didn't pay in time.`,
        );
      }
    } catch (error) {
      console.error('Deposit expiry notification failed:', error);
      Sentry.captureException(error, { extra: { rescueRequestId, stage: 'deposit-expiry-notify' } });
    }

    return true;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test:integration deposit-expiry`
Expected: PASS, 5 tests.

- [ ] **Step 4b: Add the atomicity test**

The spec's central claim is that a crash between the claim and the offer
release cannot happen. Prove it by making the second write fail and asserting
the first rolled back. Add to `reconciler-deposit-expiry.int-spec.ts`:

Spying on `prisma.dispatchOffer.updateMany` would **not** work: inside
`$transaction` the check uses the transaction client `tx`, a different object
the spy never touches. Intercept the transaction itself and hand the callback
a proxied `tx`:

```ts
  it('rolls the cancel back if releasing the offer fails, leaving the request still matchable', async () => {
    const { request, offer } = await awaitingDeposit(past());

    // Fail the offer release INSIDE the transaction, as a crash would.
    const realTransaction = prisma.$transaction.bind(prisma);
    const spy = jest.spyOn(prisma, '$transaction').mockImplementation((fn: any) =>
      realTransaction(async (tx: any) =>
        fn({
          ...tx,
          dispatchOffer: {
            ...tx.dispatchOffer,
            updateMany: () => Promise.reject(new Error('connection lost')),
          },
        }),
      ),
    );

    await expect(check.run(new Date())).rejects.toThrow('connection lost');

    // The claim must NOT have survived: a cancelled request whose offer is
    // still held matches no check ever again.
    const during = await prisma.rescueRequest.findUnique({ where: { id: request.id } });
    expect(during?.status).toBe('WAITING_FOR_DEPOSIT');
    expect((await prisma.dispatchOffer.findUnique({ where: { id: offer.id } }))?.status)
      .toBe('SELECTED_PENDING_PAYMENT');

    // And the next tick completes it cleanly.
    spy.mockRestore();
    await check.run(new Date());

    expect((await prisma.rescueRequest.findUnique({ where: { id: request.id } }))?.status).toBe('CANCELLED');
    expect((await prisma.dispatchOffer.findUnique({ where: { id: offer.id } }))?.status).toBe('TIMED_OUT');
  });
```

Note this test expects `run` to reject: the transaction error propagates out
of the check, and `ReconcilerService.tick` is what contains it. That is the
correct division — a check reports failure, the loop decides to carry on.

- [ ] **Step 4c: Run it**

Run: `yarn test:integration deposit-expiry`
Expected: PASS, 6 tests. If the cancel survives the failed release, the
transaction boundary is wrong — fix `expire` before continuing.

- [ ] **Step 5: Delete `scheduleDepositWindow` and move the window constant**

In `src/rescue-request/rescue-request-shared.service.ts`, delete
`scheduleDepositWindow` entirely — both `scheduleSafely` calls, the
`DEPOSIT_REMINDER_MARKS_MS` loop, and the constants.

Do **not** replace it with a `startDepositWindow()` helper. A helper invites
exactly the bug this design exists to remove: the request transitions to
`WAITING_FOR_DEPOSIT` in one write and the helper sets the deadline in
another, and a crash between them leaves
`WAITING_FOR_DEPOSIT` with `depositWindowExpiresAt = null` — which
`DepositExpiryCheck` can never match, so the request waits forever and holds
its operator with it.

Move the window length to the constants file created in Task 6 — or create
`src/rescue-request/deposit.constants.ts` now if Task 6 has not run yet:

```ts
/** How long the motorist has to pay the deposit before the request is cancelled. */
export const DEPOSIT_WINDOW_MS = 30 * 60 * 1000;
```

- [ ] **Step 6: Set the deadline in the SAME write that opens the window**

Both paths that move a request into `WAITING_FOR_DEPOSIT` must set the
deadline in that same statement.

In `src/rescue-request/whatsapp-customer-flow.service.ts`, `handleQuoteSelected`
already claims the transition atomically. Add the two columns to that claim —
not to a later write:

```ts
    const claimed = await this.prisma.rescueRequest.updateMany({
      where: { id: rescueRequestId, status: RescueRequestStatus.DISPATCHING },
      data: {
        status: RescueRequestStatus.WAITING_FOR_DEPOSIT,
        // Same statement as the transition. A request cannot exist in
        // WAITING_FOR_DEPOSIT without a deadline, so there is no window in
        // which a crash can produce a row no check will ever match.
        depositWindowExpiresAt: new Date(Date.now() + DEPOSIT_WINDOW_MS),
        depositRemindersSent: 0,
      },
    });
    if (claimed.count === 0) {
      return this.reply(`Sorry, this request has already moved on.`);
    }
```

Do the same at the admin path in `src/rescue-request/rescue-request-admin.service.ts`
(~line 206), wherever it sets `WAITING_FOR_DEPOSIT`, and delete its
`scheduleDepositWindow({ ... })` call.

Two consequences worth knowing. The window now starts a few seconds earlier —
at the claim rather than after the Paystack round-trip — which costs the
motorist a moment of a thirty-minute window and is not worth a second write to
avoid. And if generating the payment link then fails, the request is cancelled
30 minutes later instead of sitting in `WAITING_FOR_DEPOSIT` indefinitely as
it does today: a strict improvement.

The `customerPhone`, `operatorPhone` and `paymentUrl` arguments the old helper
took are gone — the check looks them up when it fires, so they cannot go stale.

- [ ] **Step 6b: Pin the invariant**

`WAITING_FOR_DEPOSIT` without a deadline is unmatchable by every check, so
assert the two are inseparable. Add to
`test/integration/reconciler-deposit-expiry.int-spec.ts`:

```ts
  it('never leaves a request awaiting deposit without a deadline', async () => {
    // Whatever path produced it, such a row is invisible to every check —
    // it would hold its operator and block the motorist forever.
    const orphans = await prisma.rescueRequest.count({
      where: {
        status: 'WAITING_FOR_DEPOSIT',
        depositWindowExpiresAt: null,
      },
    });
    expect(orphans).toBe(0);
  });
```

Also extend the dispatch-round integration spec from Task 5 to drive a real
quote selection and assert both columns land together:

```ts
  it('opens the deposit window in the same write that starts it', async () => {
    // ...select a quote through WhatsAppCustomerFlowService...
    const after = await prisma.rescueRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(after.status).toBe('WAITING_FOR_DEPOSIT');
    expect(after.depositWindowExpiresAt).not.toBeNull();
    expect(after.depositRemindersSent).toBe(0);
  });
```

- [ ] **Step 7: Register the check**

In `rescue-request.module.ts`, add `DepositExpiryCheck` to `providers`, to the `RECONCILER_CHECKS` factory arguments and to its `inject` array.

- [ ] **Step 8: Verify and commit**

Run: `yarn tsc --noEmit && yarn jest && yarn test:integration`

```bash
git add -A src/rescue-request test/integration
git commit -m "feat: expire the deposit window from the database, not a timer"
```

---

### Task 4: Deposit reminder check

**Files:**
- Create: `src/rescue-request/reconciler/checks/deposit-reminder.check.ts`
- Create: `test/integration/reconciler-deposit-reminder.int-spec.ts`
- Modify: `src/rescue-request/rescue-request.module.ts`

**Interfaces:**
- Consumes: `RescueRequest.depositWindowExpiresAt`, `.depositRemindersSent`.
- Produces: `DepositReminderCheck`.

- [ ] **Step 1: Write the failing test**

Create `test/integration/reconciler-deposit-reminder.int-spec.ts`:

```ts
import { DepositReminderCheck } from '../../src/rescue-request/reconciler/checks/deposit-reminder.check';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createCustomer, createRequest, truncateAll } from './factories';

const MINUTE = 60_000;

describe('DepositReminderCheck (integration)', () => {
  let prisma: PrismaService;
  let twilio: { sendWhatsAppMessage: jest.Mock };
  let check: DepositReminderCheck;

  beforeAll(() => { prisma = new PrismaService(); });
  afterAll(async () => { await prisma.$disconnect(); });

  beforeEach(async () => {
    await truncateAll(prisma);
    twilio = { sendWhatsAppMessage: jest.fn().mockResolvedValue(undefined) };
    check = new DepositReminderCheck(prisma, twilio as any);
  });

  /** `minutesLeft` before the deposit deadline. */
  async function withWindow(minutesLeft: number, remindersSent = 0) {
    const customer = await createCustomer(prisma);
    return createRequest(prisma, customer.id, {
      status: 'WAITING_FOR_DEPOSIT',
      depositWindowExpiresAt: new Date(Date.now() + minutesLeft * MINUTE),
      depositRemindersSent: remindersSent,
    });
  }

  it('sends nothing before the first mark (more than 25 minutes left)', async () => {
    await withWindow(28);
    await check.run(new Date());
    expect(twilio.sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it('sends the first reminder once 25 minutes remain', async () => {
    const request = await withWindow(24);

    await check.run(new Date());

    expect(twilio.sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    const after = await prisma.rescueRequest.findUnique({ where: { id: request.id } });
    expect(after?.depositRemindersSent).toBe(1);
  });

  it('does not repeat a reminder already sent', async () => {
    await withWindow(24, 1);
    await check.run(new Date());
    expect(twilio.sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it('sends ONE message after downtime, not one per missed mark', async () => {
    const request = await withWindow(3, 0); // all three marks are overdue

    await check.run(new Date());

    expect(twilio.sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    const after = await prisma.rescueRequest.findUnique({ where: { id: request.id } });
    expect(after?.depositRemindersSent).toBe(3);
  });

  it('sends nothing once the window has already expired — cancellation handles it', async () => {
    await withWindow(-5, 0);
    await check.run(new Date());
    expect(twilio.sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it('sends once when two ticks run concurrently', async () => {
    await withWindow(24);
    await Promise.all([check.run(new Date()), check.run(new Date())]);
    expect(twilio.sendWhatsAppMessage).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:integration deposit-reminder`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the check**

Create `src/rescue-request/reconciler/checks/deposit-reminder.check.ts`:

```ts
import { Injectable } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { RescueRequestStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { TwilioService } from '../../../integrations/twilio/twilio.service';
import { ReconcilerCheck } from '../reconciler-check.interface';

/** Minutes remaining at which a reminder is due. Descending: index 0 is the earliest nudge. */
const REMINDER_MARKS_MINUTES_LEFT = [25, 15, 5];

@Injectable()
export class DepositReminderCheck implements ReconcilerCheck {
  readonly name = 'deposit-reminder';
  private readonly MAX_PER_PASS = 100;

  constructor(
    private readonly prisma: PrismaService,
    private readonly twilioService: TwilioService,
  ) {}

  async run(now: Date): Promise<number> {
    // Every condition is in the predicate, so all 100 rows fetched are rows
    // that genuinely need a reminder.
    //
    // Filtering dueness in JavaScript would be a real defect, not a style
    // preference: non-due requests would fill the page and starve requests
    // that actually need nudging, silently and only under load.
    //
    // `depositWindowExpiresAt > now` matters too — an expired window must
    // produce no nudge at all, or a motorist receives "you have 5 minutes
    // left" seconds before "your request was cancelled".
    //
    // The OR expresses "the next unsent mark has been reached": with none
    // sent, that is the 25-minute mark; with one sent, the 15-minute mark;
    // and so on.
    const candidates = await this.prisma.rescueRequest.findMany({
      where: {
        status: RescueRequestStatus.WAITING_FOR_DEPOSIT,
        depositWindowExpiresAt: { gt: now },
        OR: REMINDER_MARKS_MINUTES_LEFT.map((mark, index) => ({
          depositRemindersSent: index,
          depositWindowExpiresAt: { lte: new Date(now.getTime() + mark * 60_000) },
        })),
      },
      select: { id: true, depositWindowExpiresAt: true, customer: { select: { phoneNumber: true } } },
      take: this.MAX_PER_PASS,
    });

    let acted = 0;
    for (const request of candidates) {
      const dueCount = this.dueCount(request.depositWindowExpiresAt!, now);
      if (await this.send(request.id, dueCount, request.customer?.phoneNumber ?? null, request.depositWindowExpiresAt!, now)) {
        acted += 1;
      }
    }
    return acted;
  }

  /** How many marks have been reached. Marks are minutes-remaining thresholds, so fewer minutes left means more are due. */
  private dueCount(expiresAt: Date, now: Date): number {
    const minutesLeft = (expiresAt.getTime() - now.getTime()) / 60_000;
    return REMINDER_MARKS_MINUTES_LEFT.filter((mark) => minutesLeft <= mark).length;
  }

  /**
   * Sets the counter TO dueCount rather than incrementing it. Fast-forward
   * after downtime is then inherent — skipped marks can never come due
   * again — and a second instance finds the counter already at dueCount and
   * matches nothing.
   */
  private async send(
    rescueRequestId: string,
    dueCount: number,
    phoneNumber: string | null,
    expiresAt: Date,
    now: Date,
  ): Promise<boolean> {
    // `depositWindowExpiresAt: expiresAt` binds the claim to the exact
    // deadline dueCount was computed from. Without it, a deposit window
    // reset between the read and the claim would be fast-forwarded using
    // the old deadline — skipping reminders the new window is owed.
    const { count } = await this.prisma.rescueRequest.updateMany({
      where: {
        id: rescueRequestId,
        status: RescueRequestStatus.WAITING_FOR_DEPOSIT,
        depositWindowExpiresAt: expiresAt,
        depositRemindersSent: { lt: dueCount },
      },
      data: { depositRemindersSent: dueCount },
    });
    if (count === 0) return false;
    if (!phoneNumber) return true;

    const minutesLeft = Math.max(1, Math.round((expiresAt.getTime() - now.getTime()) / 60_000));
    try {
      await this.twilioService.sendWhatsAppMessage(
        phoneNumber,
        `⏰ Reminder — your rescue request is still waiting for payment.\n\nYou have about ${minutesLeft} minutes left before it is cancelled.`,
      );
    } catch (error) {
      console.error('Deposit reminder failed:', error);
      Sentry.captureException(error, { extra: { rescueRequestId, stage: 'deposit-reminder-notify' } });
    }
    return true;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test:integration deposit-reminder`
Expected: PASS, 6 tests.

- [ ] **Step 5: Register, verify and commit**

Add `DepositReminderCheck` to `providers`, the `RECONCILER_CHECKS` factory and its `inject` array.

Run: `yarn tsc --noEmit && yarn jest && yarn test:integration`

```bash
git add -A src/rescue-request test/integration
git commit -m "feat: send deposit reminders from the database, not timers"
```

---

### Task 5: Move dispatch round state onto the request

**Files:**
- Modify: `src/rescue-request/state/whatsapp-session.types.ts`, `src/rescue-request/state/whatsapp-session.store.ts`, `src/rescue-request/dispatch.service.ts`
- Create: `test/integration/dispatch-round-state.int-spec.ts`

**Interfaces:**
- Produces: `RescueRequest.dispatchRound` and `.offeredOperatorIds` as the sole home of dispatch progression; `DispatchOffer.dispatchRound` set on every offer created.

- [ ] **Step 1: Write the failing test**

Create `test/integration/dispatch-round-state.int-spec.ts`:

A test that merely writes those columns and reads them back would already
pass, because Task 1 created them — it would gate nothing. The test must
assert that **`DispatchService` is the thing reading and writing them**, which
is false until this task is done:

```ts
import { PrismaService } from '../../src/prisma/prisma.service';
import { createCustomer, createOperator, createRequest, truncateAll } from './factories';

describe('dispatch round state (integration)', () => {
  let prisma: PrismaService;

  beforeAll(() => { prisma = new PrismaService(); });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(async () => { await truncateAll(prisma); });

  it('records the round and the operators offered on the REQUEST, not the session', async () => {
    const customer = await createCustomer(prisma);
    const operator = await createOperator(prisma);
    const request = await createRequest(prisma, customer.id, { status: 'DISPATCHING' });

    // Drive one real dispatch round through the service under test.
    const dispatchService = await buildDispatchService(prisma); // see note below
    await dispatchService.startDispatch(request.id, customer.id);

    const after = await prisma.rescueRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(after.offeredOperatorIds).toContain(operator.id);

    // And the offer it created carries the round it belongs to.
    const offers = await prisma.dispatchOffer.findMany({ where: { rescueRequestId: request.id } });
    expect(offers[0].dispatchRound).toBe(after.dispatchRound);

    // The session must hold none of this any more.
    const session = await prisma.whatsAppSession.findUnique({ where: { userId: customer.id } });
    expect(session === null || !('dispatchRound' in (session as object))).toBe(true);
  });
});
```

`buildDispatchService` is a small local helper that constructs
`DispatchService` with the real `PrismaService` and stubs for `TwilioService`,
`GeocodingService`, `PlatformConfigService` and `RescueRequestSharedService` —
the same pattern the other integration specs use for their checks. Write it at
the bottom of this spec file; do not export it, no other test needs it.

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:integration dispatch-round-state`
Expected: FAIL — `offeredOperatorIds` on the request is empty, because
`DispatchService` still writes that list to the WhatsApp session.

- [ ] **Step 3: Remove the fields from the session — including the database**

In `src/rescue-request/state/whatsapp-session.types.ts`, delete `dispatchRound?: number;` and `offeredOperatorIds?: string[];`.

In `src/rescue-request/state/whatsapp-session.store.ts`, delete the two `if (updates.dispatchRound ...)` / `if (updates.offeredOperatorIds ...)` branches from `update`, the `offeredOperatorIds` line from `rowToSession`, and `offeredOperatorIds: '[]'` from the `create` block in `getOrCreate`.

**Then drop the columns themselves.** Removing the TypeScript while leaving
`dispatchRound` and `offeredOperatorIds` on the `WhatsAppSession` table would
leave the old copy sitting in the database — two places a future reader could
believe holds dispatch progression, which is the ambiguity this task exists to
remove. Delete both fields from `model WhatsAppSession` in
`prisma/schema.prisma`, then:

Run: `npx prisma migrate dev --name drop_session_dispatch_state`

The generated `DROP COLUMN` statements need no hand-editing, and dropping is
safe here because `RescueRequest` is now the only reader and there are no live
requests.

- [ ] **Step 4: Read and write the round on the request**

In `src/rescue-request/dispatch.service.ts`, replace every read of `session.dispatchRound` / `session.offeredOperatorIds` with a read of the request, and every `sessionStore.update(customerId, { dispatchRound, offeredOperatorIds })` with a `rescueRequest.update`. There are three such sites: `startDispatch`'s round read, the `offeredOperatorIds` accumulation after `createMany`, and the retry path's `dispatchRound: newRound` write.

```ts
    const { dispatchRound, offeredOperatorIds } = await this.prisma.rescueRequest.findUniqueOrThrow({
      where: { id: rescueRequestId },
      select: { dispatchRound: true, offeredOperatorIds: true },
    });
```

```ts
    // `push` appends in the database. Reading the array and writing a spread
    // would lose entries whenever two dispatch paths append concurrently —
    // the automatic round and an admin's manual offer, for instance — and
    // the lost operators would then be offered the same job again.
    await this.prisma.rescueRequest.update({
      where: { id: rescueRequestId },
      data: { offeredOperatorIds: { push: batchOperatorIds } },
    });
```

Task 7 moves this call inside `prepareNextRound`'s transaction, so the append
commits with the offers it describes. Write it here as its own statement; the
later task relocates it rather than changing its shape.

- [ ] **Step 5: Move each offer's round onto the request as its source**

Task 1 Step 9b already made all **three** creation sites compile — including
`rescue-request-admin.service.ts`, which this step does not otherwise touch
and which needs no further change: it already reads `request.dispatchRound`.
What changes here is where the other two get their round from, and what else
commits alongside the write. In `startDispatch`'s `createMany`:

```ts
      data: batch.map((op) => ({
        rescueRequestId,
        operatorId: op.id,
        expiresAt,
        batchId,
        dispatchRound,
      })),
```

`manualOfferToOperator` needs the same treatment, and more than just the
round. Creating the offer and recording that the operator was offered must
commit together, or an operator an admin already contacted can be picked again
by the next automatic round — and a crash between the two leaves the offer and
the exclusion list disagreeing about who has been asked:

```ts
    await this.prisma.$transaction(async (tx) => {
      const { dispatchRound } = await tx.rescueRequest.findUniqueOrThrow({
        where: { id: rescueRequestId },
        select: { dispatchRound: true },
      });

      await tx.dispatchOffer.create({
        data: { rescueRequestId, operatorId, expiresAt, batchId, dispatchRound },
      });

      // Same statement batch, so the offer and the record of it can never
      // disagree. `push` rather than a read-modify-write: an automatic round
      // appending concurrently must not lose this operator.
      await tx.rescueRequest.update({
        where: { id: rescueRequestId },
        data: { offeredOperatorIds: { push: [operatorId] } },
      });
    });
```

- [ ] **Step 6: Run the tests**

Run: `yarn tsc --noEmit && yarn jest && yarn test:integration`
Expected: all green. TypeScript is the safety net here — any missed `dispatchRound` on an offer create fails to compile.

- [ ] **Step 7: Commit**

```bash
git add -A src prisma test
git commit -m "refactor: move dispatch round state from the session to the request"
```

---

### Task 6: Bidding close check

**Files:**
- Create: `src/rescue-request/reconciler/checks/bidding-close.check.ts`
- Create: `test/integration/reconciler-bidding-close.int-spec.ts`
- Create: `src/rescue-request/dispatch.constants.ts`
- Modify: `src/rescue-request/dispatch.service.ts` (extract `QUOTE_SELECTION_WINDOW_MS`; rename `sendQuoteShortlist` → `deliverQuoteShortlist` **and make it message-only**; delete `closeBidding`, the `closeTimers` map, the `closedRequests` set and the `setTimeout` in `startQuoteCollectionCountdown`), `src/rescue-request/rescue-request.module.ts`

**Interfaces:**
- Consumes: `DispatchService.deliverQuoteShortlist(rescueRequestId: string, customerId: string): Promise<void>` (message-only; see Task 8).
- Produces: `BiddingCloseCheck`. **Removes** `DispatchService.closeBidding` — absorbed, see Step 3.

- [ ] **Step 1: Write the failing test**

Create `test/integration/reconciler-bidding-close.int-spec.ts`:

```ts
import { BiddingCloseCheck } from '../../src/rescue-request/reconciler/checks/bidding-close.check';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createCustomer, createOffer, createOperator, createRequest, truncateAll } from './factories';

describe('BiddingCloseCheck (integration)', () => {
  let prisma: PrismaService;
  let dispatch: { deliverQuoteShortlist: jest.Mock };
  let check: BiddingCloseCheck;

  beforeAll(() => { prisma = new PrismaService(); });
  afterAll(async () => { await prisma.$disconnect(); });

  beforeEach(async () => {
    await truncateAll(prisma);
    dispatch = { deliverQuoteShortlist: jest.fn().mockResolvedValue(undefined) };
    check = new BiddingCloseCheck(prisma, dispatch as any);
  });

  async function dispatching(deadlineOffsetMs: number, biddingClosedAt: Date | null = null) {
    const customer = await createCustomer(prisma);
    const operator = await createOperator(prisma);
    const request = await createRequest(prisma, customer.id, {
      status: 'DISPATCHING',
      quoteCollectionDeadline: new Date(Date.now() + deadlineOffsetMs),
      biddingClosedAt,
    });
    await createOffer(prisma, request.id, operator.id, { status: 'QUOTED', quotedPrice: 2_500_000, dispatchRound: 0 });
    return request;
  }

  it('closes bidding and hands the request to the selection window', async () => {
    const request = await dispatching(-60_000);

    await check.run(new Date());

    const after = await prisma.rescueRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(after.biddingClosedAt).not.toBeNull();
    // Both stamps must land in the SAME transaction: with biddingClosedAt set
    // and no selection deadline, neither check could ever match this row again.
    expect(after.quoteSelectionExpiresAt).not.toBeNull();
    expect(dispatch.deliverQuoteShortlist).toHaveBeenCalledWith(request.id, expect.any(String));
  });

  it('closes the remaining offers in the same transaction as the claim', async () => {
    const request = await dispatching(-60_000);
    const operator = await createOperator(prisma);
    const pending = await createOffer(prisma, request.id, operator.id, { status: 'PENDING' });

    await check.run(new Date());

    expect((await prisma.dispatchOffer.findUnique({ where: { id: pending.id } }))?.status).toBe('TIMED_OUT');
  });

  it('does nothing before the deadline', async () => {
    await dispatching(60_000);
    await check.run(new Date());
    expect(dispatch.deliverQuoteShortlist).not.toHaveBeenCalled();
  });

  it('does not close a second time', async () => {
    await dispatching(-60_000);

    await check.run(new Date());
    dispatch.deliverQuoteShortlist.mockClear();
    await check.run(new Date());

    expect(dispatch.deliverQuoteShortlist).not.toHaveBeenCalled();
  });

  it('closes once when two ticks run concurrently', async () => {
    await dispatching(-60_000);
    await Promise.all([check.run(new Date()), check.run(new Date())]);
    expect(dispatch.deliverQuoteShortlist).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 1b: Extract the constant and rename the shortlist sender FIRST**

The check written in Step 3 uses `QUOTE_SELECTION_WINDOW_MS` and
`deliverQuoteShortlist`, so both must exist before it compiles. Do this now
rather than in Task 8, or this task cannot build.

Create `src/rescue-request/dispatch.constants.ts`:

```ts
/** How long the motorist has to pick a quote once the shortlist is sent. */
export const QUOTE_SELECTION_WINDOW_MS = 5 * 60 * 1000;
```

Use the value currently on `DispatchService.QUOTE_SELECTION_WINDOW_MS` if it
differs from the 5 minutes above, and delete the class field once both the
service and the checks import the constant.

In `dispatch.service.ts`, rename `sendQuoteShortlist` to
**`deliverQuoteShortlist`**, update its existing callers, and **delete its
`scheduleSafely(...)` block now** — writing nothing in its place. The method
becomes message-only in this task, not in Task 8.

Deferring that deletion would leave the Task 6 and Task 7 commits carrying two
mechanisms for the same deadline: the check's claim writes
`quoteSelectionExpiresAt`, while the old in-memory timer inside this method is
still armed to cancel the request itself. Removing it here means that between
Task 6 and Task 8 quote selection simply has no timeout — a missing action,
which is recoverable and harmless with no live users, rather than two actors
racing to cancel the same request.

`QUOTE_SELECTION_WINDOW_MS` is no longer read by this method at all; only the
checks use it, from the constants file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:integration bidding-close`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the check**

Create `src/rescue-request/reconciler/checks/bidding-close.check.ts`:

```ts
import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { RescueRequestStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { DispatchService } from '../../dispatch.service';
import { QUOTE_SELECTION_WINDOW_MS } from '../../dispatch.constants';
import { ReconcilerCheck } from '../reconciler-check.interface';

/**
 * Phase 2 owns progression: once quoteCollectionDeadline is set, only this
 * check may send the shortlist. Stamping biddingClosedAt is the claim, so a
 * request can be progressed past bidding exactly once even if another
 * caller is added later.
 */
@Injectable()
export class BiddingCloseCheck implements ReconcilerCheck {
  readonly name = 'bidding-close';
  private readonly MAX_PER_PASS = 100;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => DispatchService))
    private readonly dispatchService: DispatchService,
  ) {}

  async run(now: Date): Promise<number> {
    const due = await this.prisma.rescueRequest.findMany({
      where: {
        status: RescueRequestStatus.DISPATCHING,
        quoteCollectionDeadline: { lt: now },
        biddingClosedAt: null,
      },
      select: { id: true },
      take: this.MAX_PER_PASS,
    });

    let acted = 0;
    for (const { id } of due) {
      if (await this.close(id, now)) acted += 1;
    }
    return acted;
  }

  /**
   * The claim, closing the request's offers, AND opening the selection
   * window all commit together.
   *
   * The selection deadline is the subtle one. Stamping biddingClosedAt and
   * then setting quoteSelectionExpiresAt inside the message-sending method
   * would, on a crash between the two, leave a request that bidding-close
   * can never match again (biddingClosedAt is set) and that
   * quote-selection-timeout can never match either (its deadline is null).
   * The request would sit in DISPATCHING forever — the same permanent
   * stranding this whole design exists to remove, arrived at through the
   * one transition that hands off between two checks.
   *
   * Only the message goes out after the commit.
   */
  private async close(rescueRequestId: string, now: Date): Promise<boolean> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.rescueRequest.updateMany({
        where: {
          id: rescueRequestId,
          status: RescueRequestStatus.DISPATCHING,
          quoteCollectionDeadline: { lt: now },
          biddingClosedAt: null,
        },
        data: {
          biddingClosedAt: now,
          // Hands the request to QuoteSelectionTimeoutCheck atomically.
          quoteSelectionExpiresAt: new Date(now.getTime() + QUOTE_SELECTION_WINDOW_MS),
        },
      });
      if (count === 0) return null; // another tick or instance claimed it

      await tx.dispatchOffer.updateMany({
        where: { rescueRequestId, status: 'PENDING' },
        data: { status: 'TIMED_OUT', respondedAt: now },
      });

      const request = await tx.rescueRequest.findUniqueOrThrow({
        where: { id: rescueRequestId },
        select: { customerId: true },
      });
      return { customerId: request.customerId };
    });

    if (!outcome) return false;

    await this.dispatchService.deliverQuoteShortlist(rescueRequestId, outcome.customerId);
    return true;
  }
}
```

This **absorbs `DispatchService.closeBidding` rather than calling it.** That
method's status guards now live in the claim and its timer draining is being
deleted, so what remains is the offer close — which must be inside the
transaction. Delete `closeBidding` from `DispatchService` instead of making
it public.

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test:integration bidding-close`
Expected: PASS, 5 tests.

- [ ] **Step 5: Delete the timer and the in-memory close guard**

In `dispatch.service.ts`:
- Delete the `closeTimers` map declaration and every use of it.
- Delete the `setTimeout` at the end of `startQuoteCollectionCountdown`; the method now only clamps offer expiries and sends the countdown notice.
- Delete the `closedRequests` set and its `has`/`add` calls — `biddingClosedAt` replaces it.
- **Delete `closeBidding` entirely.** Its status guards are now the check's claim, its timer draining is gone, and its offer close must happen inside the check's transaction. Leaving it callable would leave a second, non-transactional route to closing bidding.

The Step 1 tests are already written against this shape, so nothing there changes.

- [ ] **Step 6: Register, verify and commit**

Add `BiddingCloseCheck` to the module as before.

Run: `yarn tsc --noEmit && yarn jest && yarn test:integration`

```bash
git add -A src test
git commit -m "feat: close bidding from the database, not a timer"
```

---

### Task 7: Batch resolve check with the phase compare-and-swap

**Files:**
- Create: `src/rescue-request/reconciler/checks/batch-resolve.check.ts`
- Create: `test/integration/reconciler-batch-resolve.int-spec.ts`
- Modify: `src/rescue-request/dispatch.service.ts` (delete `batchTimers` and both `setTimeout` calls), `src/rescue-request/rescue-request.module.ts`

**Interfaces:**
- Consumes: `DispatchService.prepareNextRound`, `.deliverOffers`, `.deliverQuoteShortlist`, `.notifyNoOperatorAvailable` (all defined in Step 3b).
- Produces: `BatchResolveCheck`.

- [ ] **Step 1: Write the failing test**

Create `test/integration/reconciler-batch-resolve.int-spec.ts`:

```ts
import { BatchResolveCheck } from '../../src/rescue-request/reconciler/checks/batch-resolve.check';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createCustomer, createOffer, createOperator, createRequest, truncateAll } from './factories';

describe('BatchResolveCheck (integration)', () => {
  let prisma: PrismaService;
  let dispatch: {
    prepareNextRound: jest.Mock;
    deliverOffers: jest.Mock;
    deliverQuoteShortlist: jest.Mock;
    notifyNoOperatorAvailable: jest.Mock;
  };
  let check: BatchResolveCheck;

  const expired = () => new Date(Date.now() - 60_000);

  beforeAll(() => { prisma = new PrismaService(); });
  afterAll(async () => { await prisma.$disconnect(); });

  beforeEach(async () => {
    await truncateAll(prisma);
    // The mock must match the methods the check actually calls. Mocking
    // startDispatch/deliverQuoteShortlist here would make several assertions
    // vacuous AND throw on the happy path, since prepareNextRound would be
    // undefined.
    dispatch = {
      // Never `{ offers: [], exhausted: false }` — prepareNextRound's contract
      // forbids it, and a mock that models an impossible state tests nothing.
      prepareNextRound: jest.fn().mockResolvedValue({
        offers: [{ operatorPhone: '+2349000000001', jobRef: 'AAA111' } as any],
        exhausted: false,
      }),
      deliverOffers: jest.fn().mockResolvedValue(undefined),
      deliverQuoteShortlist: jest.fn().mockResolvedValue(undefined),
      notifyNoOperatorAvailable: jest.fn().mockResolvedValue(undefined),
    };
    check = new BatchResolveCheck(prisma, dispatch as any);
  });

  async function scenario(opts: { requestRound: number; batchRound: number; deadline: Date | null }) {
    const customer = await createCustomer(prisma);
    const operator = await createOperator(prisma);
    const request = await createRequest(prisma, customer.id, {
      status: 'DISPATCHING',
      dispatchRound: opts.requestRound,
      quoteCollectionDeadline: opts.deadline,
    });
    const offer = await createOffer(prisma, request.id, operator.id, {
      status: 'PENDING',
      expiresAt: expired(),
      dispatchRound: opts.batchRound,
    });
    return { request, offer };
  }

  it('expires its own offers and starts the next round in phase 1', async () => {
    const { request, offer } = await scenario({ requestRound: 0, batchRound: 0, deadline: null });

    await check.run(new Date());

    expect((await prisma.dispatchOffer.findUnique({ where: { id: offer.id } }))?.status).toBe('TIMED_OUT');
    expect(dispatch.prepareNextRound).toHaveBeenCalled();
    expect((await prisma.rescueRequest.findUnique({ where: { id: request.id } }))?.dispatchRound).toBe(1);
  });

  it('does not progress in phase 2 — bidding close owns it', async () => {
    const { request, offer } = await scenario({ requestRound: 0, batchRound: 0, deadline: new Date(Date.now() + 60_000) });

    await check.run(new Date());

    expect((await prisma.dispatchOffer.findUnique({ where: { id: offer.id } }))?.status).toBe('TIMED_OUT');
    expect(dispatch.prepareNextRound).not.toHaveBeenCalled();
    expect(dispatch.deliverQuoteShortlist).not.toHaveBeenCalled();
    expect((await prisma.rescueRequest.findUnique({ where: { id: request.id } }))?.dispatchRound).toBe(0);
  });

  it('a stale round-1 batch cannot advance a request already on round 2', async () => {
    const { request, offer } = await scenario({ requestRound: 2, batchRound: 1, deadline: null });

    await check.run(new Date());

    expect((await prisma.dispatchOffer.findUnique({ where: { id: offer.id } }))?.status).toBe('TIMED_OUT');
    expect(dispatch.prepareNextRound).not.toHaveBeenCalled();
    expect((await prisma.rescueRequest.findUnique({ where: { id: request.id } }))?.dispatchRound).toBe(2);
  });

  it('advances exactly one round when two ticks run concurrently', async () => {
    const { request } = await scenario({ requestRound: 0, batchRound: 0, deadline: null });

    await Promise.all([check.run(new Date()), check.run(new Date())]);

    expect((await prisma.rescueRequest.findUnique({ where: { id: request.id } }))?.dispatchRound).toBe(1);
    expect(dispatch.prepareNextRound).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:integration batch-resolve`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the check**

Create `src/rescue-request/reconciler/checks/batch-resolve.check.ts`:

```ts
import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { RescueRequestStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { DispatchService } from '../../dispatch.service';
import { QUOTE_SELECTION_WINDOW_MS } from '../../dispatch.constants';
import { ReconcilerCheck } from '../reconciler-check.interface';

@Injectable()
export class BatchResolveCheck implements ReconcilerCheck {
  readonly name = 'batch-resolve';
  private readonly MAX_PER_PASS = 100;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => DispatchService))
    private readonly dispatchService: DispatchService,
  ) {}

  async run(now: Date): Promise<number> {
    const expiredOffers = await this.prisma.dispatchOffer.findMany({
      where: {
        status: 'PENDING',
        expiresAt: { lt: now },
        rescueRequest: { status: RescueRequestStatus.DISPATCHING },
      },
      select: { id: true, rescueRequestId: true, batchId: true, dispatchRound: true },
      take: this.MAX_PER_PASS,
    });

    const batches = new Map<string, { rescueRequestId: string; round: number; offerIds: string[] }>();
    for (const offer of expiredOffers) {
      const key = `${offer.rescueRequestId}:${offer.batchId}`;
      const entry = batches.get(key) ?? { rescueRequestId: offer.rescueRequestId, round: offer.dispatchRound, offerIds: [] };
      entry.offerIds.push(offer.id);
      batches.set(key, entry);
    }

    let acted = 0;
    for (const batch of batches.values()) {
      if (await this.resolve(batch, now)) acted += 1;
    }
    return acted;
  }

  /**
   * Expiring the batch, claiming progression, AND creating the next round's
   * offers all commit together.
   *
   * Advancing the round and only then creating offers would, on a crash
   * between the two, leave the request on round N+1 with no offers for it —
   * and nothing can retry, because the CAS requires dispatchRound to equal
   * the batch's round, which is now behind. The request would sit in
   * DISPATCHING forever with no live offers and no check able to match it.
   *
   * Only the WhatsApp sends happen after the commit.
   */
  private async resolve(
    batch: { rescueRequestId: string; round: number; offerIds: string[] },
    now: Date,
  ): Promise<boolean> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      await tx.dispatchOffer.updateMany({
        where: { id: { in: batch.offerIds }, status: 'PENDING' },
        data: { status: 'TIMED_OUT', respondedAt: now },
      });

      // Progression is claimed, never merely read. quoteCollectionDeadline
      // must still be null AT THIS MOMENT (a first quote may have landed
      // since we queried), and the round must be THIS batch's — otherwise a
      // straggler from an earlier round would advance dispatch on behalf of
      // a round that already finished.
      const { count } = await tx.rescueRequest.updateMany({
        where: {
          id: batch.rescueRequestId,
          status: RescueRequestStatus.DISPATCHING,
          quoteCollectionDeadline: null,
          dispatchRound: batch.round,
        },
        data: { dispatchRound: batch.round + 1 },
      });
      if (count === 0) return null;

      const request = await tx.rescueRequest.findUniqueOrThrow({
        where: { id: batch.rescueRequestId },
        select: { customerId: true },
      });

      const quoted = await tx.dispatchOffer.count({
        where: { rescueRequestId: batch.rescueRequestId, status: 'QUOTED' },
      });
      if (quoted > 0) {
        // Opening the selection window belongs in THIS transaction, for the
        // same reason as in BiddingCloseCheck: committing the round advance
        // and setting the deadline inside the sending method would, on a
        // crash between them, leave a request no check can match — batch
        // resolve has no expired offers left, and quote-selection-timeout
        // has no deadline.
        // Close EVERY remaining PENDING offer on the request, not just this
        // batch's. Another batch — or an admin's manual offer — can still be
        // live, and an operator answering one after the motorist already has
        // a shortlist would quote into a closed auction.
        await tx.dispatchOffer.updateMany({
          where: { rescueRequestId: batch.rescueRequestId, status: 'PENDING' },
          data: { status: 'TIMED_OUT', respondedAt: now },
        });

        // biddingClosedAt is stamped here too. The design makes it the
        // backstop for ANY path that progresses a request past bidding, so a
        // phase-1 shortlist must claim it as well — otherwise bidding-close
        // could later match the same request and send a second shortlist.
        await tx.rescueRequest.update({
          where: { id: batch.rescueRequestId },
          data: {
            biddingClosedAt: now,
            quoteSelectionExpiresAt: new Date(now.getTime() + QUOTE_SELECTION_WINDOW_MS),
          },
        });
        return { outcome: 'shortlist' as const, customerId: request.customerId };
      }

      // No quotes: the next round's offer rows are written HERE, inside the
      // same transaction as the round advance, so the two can never
      // disagree. Only the sends are deferred.
      const next = await this.dispatchService.prepareNextRound(tx, batch.rescueRequestId, batch.round + 1);

      // Exhausted means no operator remains to try. Advancing the round and
      // creating nothing would leave a DISPATCHING request with no live
      // offers — nothing to expire, so batch resolve never sees it again and
      // the motorist waits forever. The cancel must commit with the advance.
      if (next.exhausted) {
        await tx.rescueRequest.update({
          where: { id: batch.rescueRequestId },
          data: { status: RescueRequestStatus.CANCELLED },
        });
        return { outcome: 'exhausted' as const, customerId: request.customerId };
      }

      return { outcome: 'nextRound' as const, customerId: request.customerId, offers: next.offers };
    });

    if (!outcome) return true; // offers expired; progression belongs to someone else

    switch (outcome.outcome) {
      case 'shortlist':
        await this.dispatchService.deliverQuoteShortlist(batch.rescueRequestId, outcome.customerId);
        break;
      case 'nextRound':
        await this.dispatchService.deliverOffers(outcome.offers);
        break;
      case 'exhausted':
        await this.dispatchService.notifyNoOperatorAvailable(batch.rescueRequestId, outcome.customerId);
        break;
    }
    return true;
  }
}
```

Note the CAS branch now returns `null` rather than `{ progress: false }`, so
the three real outcomes stay in one discriminated union.

- [ ] **Step 3b: Split offer creation from offer delivery in `DispatchService`**

The check above needs offer rows written inside its transaction, so
`startDispatch` must be separable into a database half and a messaging half.
Extract two methods; do not duplicate the ranking logic.

```ts
  /**
   * Selects and records the next round's offers. Takes a transaction client
   * so a caller can commit them atomically with whatever claimed the round.
   * Performs NO messaging — the returned payloads are what to send once the
   * caller's transaction has committed.
   *
   * `exhausted` is true when no operator remains to try: either no candidate
   * is within the maximum radius, or the round cap is reached. The caller
   * MUST cancel the request in the same transaction when it sees this —
   * returning an empty offer list without cancelling leaves a DISPATCHING
   * request with nothing to expire, which no check can ever match again.
   *
   * INVARIANT: `exhausted: false` guarantees at least one offer was created.
   * `{ offers: [], exhausted: false }` must never be returned — it is exactly
   * the stranded state this contract exists to prevent, and a caller acting
   * on it would advance the round having created nothing. If no offer could
   * be written, the answer is `exhausted: true`.
   *
   * This method also appends to `offeredOperatorIds`, on `tx`, in the same
   * statement batch that creates the offers. The two must not be separable:
   * a crash between them loses the record of who was asked, and the next
   * round re-offers the same operators — the re-offer loop the dispatch code
   * already carries a warning about. Use Prisma's `{ push: [...] }` rather
   * than reading the array and writing a spread, so concurrent appends
   * cannot overwrite one another.
   */
  async prepareNextRound(
    tx: Prisma.TransactionClient,
    rescueRequestId: string,
    round: number,
  ): Promise<{ offers: PendingOffer[]; exhausted: boolean }>;

  /** Sends the offers prepared above. Per-operator failures are tolerated, as today. */
  async deliverOffers(offers: PendingOffer[]): Promise<void>;

  /** Message-only. The selection deadline is set by the caller, inside its claim. */
  async deliverQuoteShortlist(rescueRequestId: string, customerId: string): Promise<void>;

  /** Message-only: tells the motorist no operator was found, and alerts staff. */
  async notifyNoOperatorAvailable(rescueRequestId: string, customerId: string): Promise<void>;
```

`prepareNextRound` absorbs the radius-expansion loop that `startDispatch`
performs today, so "expand and try again" happens within one call rather than
across reconciler ticks. That matters: with no offers created, nothing expires,
so a later tick would have no trigger to retry on.

`startDispatch` must handle `exhausted` **the same way the check does**, or
the initial dispatch strands a request that the reconciler can never rescue —
no offers means nothing expires, so batch resolve never sees it:

```ts
  async startDispatch(rescueRequestId: string, customerId: string): Promise<void> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const { dispatchRound } = await tx.rescueRequest.findUniqueOrThrow({
        where: { id: rescueRequestId },
        select: { dispatchRound: true },
      });
      const next = await this.prepareNextRound(tx, rescueRequestId, dispatchRound);
      if (next.exhausted) {
        await tx.rescueRequest.update({
          where: { id: rescueRequestId },
          data: { status: RescueRequestStatus.CANCELLED },
        });
        return { exhausted: true as const };
      }
      return { exhausted: false as const, offers: next.offers };
    });

    if (outcome.exhausted) {
      await this.notifyNoOperatorAvailable(rescueRequestId, customerId);
      return;
    }
    await this.deliverOffers(outcome.offers);
  }
```

Initial dispatch and the reconciler then share one path and one failure mode.
Define `PendingOffer` in `src/rescue-request/dto/pending-offer.dto.ts` per the
repo convention that shapes live in `dto/`, never inline in a service:

```ts
export interface PendingOffer {
  operatorPhone: string;
  jobRef: string;
  vehicle: string;
  destination: string;
  distanceLine: string;
  location: string;
  mediaSection: string;
  etaLine: string;
  window: string;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test:integration batch-resolve`
Expected: PASS, 4 tests.

- [ ] **Step 4b: Add the stale-phase-read test**

The phase must be checked *inside* the claim, not before it. This test sets
the deadline between the check's query and its claim — the interleaving a
first quote produces — and fails against any implementation that reads the
phase up front. Add to `reconciler-batch-resolve.int-spec.ts`:

```ts
  it('does not start a round when a first quote lands between the query and the claim', async () => {
    const { request } = await scenario({ requestRound: 0, batchRound: 0, deadline: null });

    // Set the deadline after the check has read its offers but before it
    // claims — exactly what an operator's first quote does concurrently.
    // Hook dispatchOffer.findMany: that is the query BatchResolveCheck
    // actually issues. (rescueRequest.findMany is never called here, so a
    // spy on it would make this test silently vacuous.)
    const findMany = prisma.dispatchOffer.findMany.bind(prisma.dispatchOffer);
    jest.spyOn(prisma.dispatchOffer, 'findMany').mockImplementation(async (args: any) => {
      const rows = await findMany(args);
      await prisma.rescueRequest.update({
        where: { id: request.id },
        data: { quoteCollectionDeadline: new Date(Date.now() + 60_000) },
      });
      return rows;
    });

    await check.run(new Date());

    expect(dispatch.prepareNextRound).not.toHaveBeenCalled();
    expect((await prisma.rescueRequest.findUnique({ where: { id: request.id } }))?.dispatchRound).toBe(0);
  });
```

If the check reads `quoteCollectionDeadline` before the transaction and
branches on it, this test fails — which is the point.

- [ ] **Step 4c: Add the progression-ownership test**

Bidding close and batch resolve must never both progress the same request.
This test runs both checks against one request where each has due work. Add
to `reconciler-batch-resolve.int-spec.ts`:

```ts
  it('yields to bidding close — the request is progressed exactly once, even concurrently', async () => {
    const { BiddingCloseCheck } = await import('../../src/rescue-request/reconciler/checks/bidding-close.check');
    const { request } = await scenario({ requestRound: 0, batchRound: 0, deadline: new Date(Date.now() - 60_000) });
    const biddingClose = new BiddingCloseCheck(prisma, dispatch as any);

    // Run them together. Sequentially, the first simply wins and the test
    // proves only ordering; the interesting claim is that the two claims
    // cannot both succeed when they interleave.
    await Promise.all([biddingClose.run(new Date()), check.run(new Date())]);

    // Exactly one shortlist, from bidding close. closeBidding no longer
    // exists — Task 6 absorbed it — so the observable is the delivery.
    expect(dispatch.deliverQuoteShortlist).toHaveBeenCalledTimes(1);
    expect(dispatch.prepareNextRound).not.toHaveBeenCalled();

    const after = await prisma.rescueRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(after.biddingClosedAt).not.toBeNull();
    expect(after.quoteSelectionExpiresAt).not.toBeNull();
    expect(after.dispatchRound).toBe(0);
  });
```

- [ ] **Step 4d: Add the exhaustion test**

When no operator remains, advancing the round without cancelling leaves a
`DISPATCHING` request with no offers — nothing expires, so no check ever sees
it again and the motorist waits forever. Add to
`reconciler-batch-resolve.int-spec.ts`:

```ts
  it('cancels in the same transaction when no operator remains, rather than advancing into silence', async () => {
    const { request } = await scenario({ requestRound: 0, batchRound: 0, deadline: null });
    dispatch.prepareNextRound.mockResolvedValue({ offers: [], exhausted: true });

    await check.run(new Date());

    const after = await prisma.rescueRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(after.status).toBe('CANCELLED');
    expect(dispatch.notifyNoOperatorAvailable).toHaveBeenCalledWith(request.id, expect.any(String));
    expect(dispatch.deliverOffers).not.toHaveBeenCalled();
  });

  it('opens the selection window in the same transaction when quotes exist', async () => {
    const { request } = await scenario({ requestRound: 0, batchRound: 0, deadline: null });
    const operator = await createOperator(prisma);
    await createOffer(prisma, request.id, operator.id, { status: 'QUOTED', quotedPrice: 2_000_000 });

    await check.run(new Date());

    const after = await prisma.rescueRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(after.quoteSelectionExpiresAt).not.toBeNull();
    expect(after.biddingClosedAt).not.toBeNull(); // claims the backstop too
    expect(dispatch.deliverQuoteShortlist).toHaveBeenCalled();
  });
```

- [ ] **Step 4e: Run them**

Run: `yarn test:integration batch-resolve`
Expected: PASS, 8 tests.

- [ ] **Step 5: Delete the batch timers**

In `dispatch.service.ts`, delete the `batchTimers` map, the `batchKey` helper, and both `setTimeout` calls that schedule `resolveBatch` (in `startDispatch` and in `manualOfferToOperator`). Delete the now-unused private `resolveBatch` and its early-return guards — the check replaces it wholesale.

- [ ] **Step 6: Register, verify and commit**

Run: `yarn tsc --noEmit && yarn jest && yarn test:integration`

```bash
git add -A src test
git commit -m "feat: resolve dispatch batches from the database under a round CAS"
```

---

### Task 8: Quote-selection timeout check

**Files:**
- Create: `src/rescue-request/reconciler/checks/quote-selection-timeout.check.ts`
- Create: `test/integration/reconciler-quote-selection.int-spec.ts`
- Modify: `src/rescue-request/rescue-request.module.ts` (registration only — `dispatch.service.ts` was finished in Task 6)

**Interfaces:**
- Produces: `QuoteSelectionTimeoutCheck`.

- [ ] **Step 1: Write the failing test**

Create `test/integration/reconciler-quote-selection.int-spec.ts`:

```ts
import { QuoteSelectionTimeoutCheck } from '../../src/rescue-request/reconciler/checks/quote-selection-timeout.check';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createCustomer, createOffer, createOperator, createRequest, truncateAll } from './factories';

describe('QuoteSelectionTimeoutCheck (integration)', () => {
  let prisma: PrismaService;
  let twilio: { sendWhatsAppMessage: jest.Mock };
  let check: QuoteSelectionTimeoutCheck;

  beforeAll(() => { prisma = new PrismaService(); });
  afterAll(async () => { await prisma.$disconnect(); });

  beforeEach(async () => {
    await truncateAll(prisma);
    twilio = { sendWhatsAppMessage: jest.fn().mockResolvedValue(undefined) };
    check = new QuoteSelectionTimeoutCheck(prisma, twilio as any);
  });

  async function awaitingSelection(offsetMs: number) {
    const customer = await createCustomer(prisma);
    const operator = await createOperator(prisma);
    const request = await createRequest(prisma, customer.id, {
      status: 'DISPATCHING',
      quoteSelectionExpiresAt: new Date(Date.now() + offsetMs),
    });
    await createOffer(prisma, request.id, operator.id, { status: 'QUOTED', quotedPrice: 2_000_000, dispatchRound: 0 });
    return request;
  }

  it('cancels when the motorist never chooses', async () => {
    const request = await awaitingSelection(-60_000);

    await check.run(new Date());

    expect((await prisma.rescueRequest.findUnique({ where: { id: request.id } }))?.status).toBe('CANCELLED');
  });

  it('releases the quoting operators', async () => {
    const request = await awaitingSelection(-60_000);

    await check.run(new Date());

    const offers = await prisma.dispatchOffer.findMany({ where: { rescueRequestId: request.id } });
    expect(offers.every((o) => o.status === 'TIMED_OUT')).toBe(true);
  });

  it('does nothing before the deadline', async () => {
    const request = await awaitingSelection(60_000);
    await check.run(new Date());
    expect((await prisma.rescueRequest.findUnique({ where: { id: request.id } }))?.status).toBe('DISPATCHING');
  });

  it('does not act twice', async () => {
    await awaitingSelection(-60_000);
    await check.run(new Date());
    twilio.sendWhatsAppMessage.mockClear();
    await check.run(new Date());
    expect(twilio.sendWhatsAppMessage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:integration quote-selection`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the check**

Create `src/rescue-request/reconciler/checks/quote-selection-timeout.check.ts`:

```ts
import { Injectable } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { RescueRequestStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { TwilioService } from '../../../integrations/twilio/twilio.service';
import { toWhatsAppAddress } from '../../../common/phone.util';
import { ReconcilerCheck } from '../reconciler-check.interface';

@Injectable()
export class QuoteSelectionTimeoutCheck implements ReconcilerCheck {
  readonly name = 'quote-selection-timeout';
  private readonly MAX_PER_PASS = 100;

  constructor(
    private readonly prisma: PrismaService,
    private readonly twilioService: TwilioService,
  ) {}

  async run(now: Date): Promise<number> {
    const due = await this.prisma.rescueRequest.findMany({
      where: {
        status: RescueRequestStatus.DISPATCHING,
        quoteSelectionExpiresAt: { lt: now },
      },
      select: { id: true },
      take: this.MAX_PER_PASS,
    });

    let acted = 0;
    for (const { id } of due) {
      if (await this.timeOut(id, now)) acted += 1;
    }
    return acted;
  }

  private async timeOut(rescueRequestId: string, now: Date): Promise<boolean> {
    const claimed = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.rescueRequest.updateMany({
        where: {
          id: rescueRequestId,
          status: RescueRequestStatus.DISPATCHING,
          quoteSelectionExpiresAt: { lt: now },
        },
        data: { status: RescueRequestStatus.CANCELLED },
      });
      if (count === 0) return null;

      const quoting = await tx.dispatchOffer.findMany({
        where: { rescueRequestId, status: 'QUOTED' },
        include: { operator: { select: { phoneNumber: true } } },
      });
      await tx.dispatchOffer.updateMany({
        where: { rescueRequestId, status: 'QUOTED' },
        data: { status: 'TIMED_OUT', respondedAt: now },
      });

      const request = await tx.rescueRequest.findUniqueOrThrow({
        where: { id: rescueRequestId },
        select: { customer: { select: { phoneNumber: true } } },
      });
      return { operatorPhones: quoting.map((o) => o.operator.phoneNumber), customerPhone: request.customer?.phoneNumber ?? null };
    });

    if (!claimed) return false;

    try {
      if (claimed.customerPhone) {
        await this.twilioService.sendWhatsAppMessage(
          claimed.customerPhone,
          `⏰ You didn't choose a quote in time. Your request has been cancelled — send SOS to start again.`,
        );
      }
      await Promise.all(
        claimed.operatorPhones.map((phone) =>
          this.twilioService.sendWhatsAppMessage(
            toWhatsAppAddress(phone),
            `This job is no longer available — the customer didn't choose in time. Thanks for bidding!`,
          ),
        ),
      );
    } catch (error) {
      console.error('Quote-selection timeout notification failed:', error);
      Sentry.captureException(error, { extra: { rescueRequestId, stage: 'quote-selection-notify' } });
    }
    return true;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test:integration quote-selection`
Expected: PASS, 4 tests.

- [ ] **Step 5: Confirm nothing else sets the deadline**

Task 6 already made `deliverQuoteShortlist` message-only, so there is no timer
left to delete here — this task only adds the check.

Verify it stayed that way:

```bash
grep -n "quoteSelectionExpiresAt" src/rescue-request/dispatch.service.ts
```

Expected: **no output.** The deadline is written only by the two checks, inside
the transaction that claims progression. A write here would sit outside that
claim, which is the gap Tasks 6 and 7 exist to close.

- [ ] **Step 6: Register, verify and commit**

Run: `yarn tsc --noEmit && yarn jest && yarn test:integration`

```bash
git add -A src test
git commit -m "feat: time out quote selection from the database, not a timer"
```

---

### Task 9: Stalled-confirmation check

**Files:**
- Create: `src/rescue-request/reconciler/checks/stalled-confirmation.check.ts`
- Create: `test/integration/reconciler-stalled-confirmation.int-spec.ts`
- Modify: `src/rescue-request/whatsapp-operator-flow.service.ts` (`handleOperatorJobDone`: set `confirmationDueAt`, delete the `scheduleSafely` block), `src/rescue-request/rescue-request.module.ts`

**Interfaces:**
- Produces: `StalledConfirmationCheck`.

- [ ] **Step 1: Write the failing test**

Create `test/integration/reconciler-stalled-confirmation.int-spec.ts`:

```ts
import { StalledConfirmationCheck } from '../../src/rescue-request/reconciler/checks/stalled-confirmation.check';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createCustomer, createOperator, createRequest, truncateAll } from './factories';

describe('StalledConfirmationCheck (integration)', () => {
  let prisma: PrismaService;
  let twilio: { sendWhatsAppMessage: jest.Mock };
  let config: { getConfig: jest.Mock };
  let check: StalledConfirmationCheck;

  beforeAll(() => { prisma = new PrismaService(); });
  afterAll(async () => { await prisma.$disconnect(); });

  beforeEach(async () => {
    await truncateAll(prisma);
    twilio = { sendWhatsAppMessage: jest.fn().mockResolvedValue(undefined) };
    config = { getConfig: jest.fn().mockResolvedValue({ disputeAlertPhoneNumber: '+2348000000000' }) };
    check = new StalledConfirmationCheck(prisma, twilio as any, config as any);
  });

  async function awaitingConfirmation(offsetMs: number, overrides: Record<string, unknown> = {}) {
    const customer = await createCustomer(prisma);
    const operator = await createOperator(prisma);
    return createRequest(prisma, customer.id, {
      status: 'ARRIVED',
      assignedOperatorId: operator.id,
      confirmationDueAt: new Date(Date.now() + offsetMs),
      ...overrides,
    });
  }

  it('alerts staff once the confirmation is overdue', async () => {
    await awaitingConfirmation(-60_000);
    await check.run(new Date());
    expect(twilio.sendWhatsAppMessage).toHaveBeenCalledTimes(1);
  });

  it('clears the due date so it cannot alert twice', async () => {
    const request = await awaitingConfirmation(-60_000);

    await check.run(new Date());
    twilio.sendWhatsAppMessage.mockClear();
    await check.run(new Date());

    expect(twilio.sendWhatsAppMessage).not.toHaveBeenCalled();
    expect((await prisma.rescueRequest.findUnique({ where: { id: request.id } }))?.confirmationDueAt).toBeNull();
  });

  it('does not alert before the due date', async () => {
    await awaitingConfirmation(60_000);
    await check.run(new Date());
    expect(twilio.sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it('does not alert on a disputed request — the dispute flow owns it', async () => {
    await awaitingConfirmation(-60_000, { disputed: true });
    await check.run(new Date());
    expect(twilio.sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it('does not alert on a request that already ended', async () => {
    await awaitingConfirmation(-60_000, { status: 'COMPLETED' });
    await check.run(new Date());
    expect(twilio.sendWhatsAppMessage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn test:integration stalled-confirmation`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the check**

Create `src/rescue-request/reconciler/checks/stalled-confirmation.check.ts`:

```ts
import { Injectable } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { RescueRequestStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { TwilioService } from '../../../integrations/twilio/twilio.service';
import { PlatformConfigService } from '../../../platform-config/platform-config.service';
import { toWhatsAppAddress } from '../../../common/phone.util';
import { formatJobRef } from '../../domain/rescue-request-formatting';
import { ReconcilerCheck } from '../reconciler-check.interface';

@Injectable()
export class StalledConfirmationCheck implements ReconcilerCheck {
  readonly name = 'stalled-confirmation';
  private readonly MAX_PER_PASS = 100;

  constructor(
    private readonly prisma: PrismaService,
    private readonly twilioService: TwilioService,
    private readonly platformConfigService: PlatformConfigService,
  ) {}

  async run(now: Date): Promise<number> {
    const due = await this.prisma.rescueRequest.findMany({
      where: {
        confirmationDueAt: { lt: now },
        disputed: false,
        status: { notIn: [RescueRequestStatus.COMPLETED, RescueRequestStatus.CANCELLED] },
      },
      select: { id: true },
      take: this.MAX_PER_PASS,
    });

    let acted = 0;
    for (const { id } of due) {
      // Clearing the due date is the claim: it removes the row from this match.
      const { count } = await this.prisma.rescueRequest.updateMany({
        where: {
          id,
          confirmationDueAt: { lt: now },
          disputed: false,
          status: { notIn: [RescueRequestStatus.COMPLETED, RescueRequestStatus.CANCELLED] },
        },
        data: { confirmationDueAt: null },
      });
      if (count === 0) continue;

      try {
        const config = await this.platformConfigService.getConfig();
        if (config.disputeAlertPhoneNumber) {
          await this.twilioService.sendWhatsAppMessage(
            toWhatsAppAddress(config.disputeAlertPhoneNumber),
            `⚠️ ${formatJobRef(id)} — the operator marked this job done 30 minutes ago and the customer has not confirmed. Please follow up.`,
          );
        }
      } catch (error) {
        console.error('Stalled-confirmation alert failed:', error);
        Sentry.captureException(error, { extra: { rescueRequestId: id, stage: 'stalled-confirmation-notify' } });
      }
      acted += 1;
    }
    return acted;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test:integration stalled-confirmation`
Expected: PASS, 5 tests.

- [ ] **Step 5: Persist the due date and delete the timer**

In `whatsapp-operator-flow.service.ts`, inside `handleOperatorJobDone`, delete the entire `scheduleSafely(...)` block.

`confirmationDueAt` must be written **in the same transaction that records the
DONE transition** — not as a second update afterwards. A separate write that
fails, or a process that dies between the two, loses the alert permanently:
nothing else ever sets that column, so no check will ever chase that job and
staff are never told the customer went quiet.

Today the DONE transition is two writes — the customer's session moves to
`AWAITING_COMPLETION_CONFIRM`, and the operator's session is cleared. With the
new column that is three mutations, and all three belong in one transaction:

```ts
    await this.prisma.$transaction(async (tx) => {
      await tx.rescueRequest.update({
        where: { id: rescueRequestId },
        data: { confirmationDueAt: new Date(Date.now() + 30 * 60 * 1000) },
      });
      await tx.whatsAppSession.update({
        where: { userId: customerId },
        data: {
          state: WhatsAppFlowState.AWAITING_COMPLETION_CONFIRM,
          rescueRequestId,
        },
      });
      // The operator's session is cleared here too, on the transaction
      // client. Calling sessionStore.clear() outside the transaction would
      // put it on the default client, so it would commit independently and
      // could survive a rollback of the other two.
      await tx.whatsAppSession.deleteMany({ where: { userId: operatorUserId } });
    });
```

The customer's "the driver says the job is done" message still goes out after
that transaction commits, like every other notification in this design.

- [ ] **Step 6: Register, verify and commit**

Run: `yarn tsc --noEmit && yarn jest && yarn test:integration`

```bash
git add -A src test
git commit -m "feat: alert on stalled confirmations from the database, not a timer"
```

---

### Task 10: Derive the rating timeout and remove the last timers

**Files:**
- Modify: `src/rescue-request/state/whatsapp-session.store.ts`, `src/rescue-request/whatsapp-customer-flow.service.ts`, `src/rescue-request/payment-events.service.ts`
- Delete: `src/common/safe-timer.ts`, `src/common/safe-timer.spec.ts` (if present)
- Test: `src/rescue-request/state/whatsapp-session.store.spec.ts`

**Interfaces:**
- Produces: `WhatsAppSessionStore.rowToSession` treating a stale `WAITING_FOR_RATING` as `IDLE`.

- [ ] **Step 1: Write the failing test**

Add to `src/rescue-request/state/whatsapp-session.store.spec.ts`:

```ts
  it('treats a rating prompt older than ten minutes as IDLE, without writing anything', async () => {
    prisma.whatsAppSession.upsert.mockResolvedValue({
      userId: 'u1',
      state: 'WAITING_FOR_RATING',
      rescueRequestId: 'req-1',
      updatedAt: new Date(Date.now() - 11 * 60 * 1000),
    });

    const session = await store.getOrCreate('u1');

    expect(session.state).toBe('IDLE');
    expect(prisma.whatsAppSession.update).not.toHaveBeenCalled();
  });

  it('keeps a recent rating prompt active', async () => {
    prisma.whatsAppSession.upsert.mockResolvedValue({
      userId: 'u1',
      state: 'WAITING_FOR_RATING',
      rescueRequestId: 'req-1',
      updatedAt: new Date(Date.now() - 60 * 1000),
    });

    const session = await store.getOrCreate('u1');

    expect(session.state).toBe('WAITING_FOR_RATING');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn jest whatsapp-session.store`
Expected: FAIL — the stale prompt is still reported as `WAITING_FOR_RATING`.

- [ ] **Step 3: Derive it in the read path**

In `whatsapp-session.store.ts`, add the constant and apply it in `rowToSession`:

```ts
/**
 * A rating prompt goes stale rather than being cleared by a timer. Nothing
 * outbound happens at the deadline — the prompt simply stops applying — so
 * this is derived on read instead of scheduled. One place, so no reader can
 * forget it.
 *
 * `updatedAt` is the prompt time because setting WAITING_FOR_RATING is the
 * last write to the row; a later unrelated write would extend the window,
 * which is acceptable for quiet cleanup that blocks nothing.
 */
const RATING_PROMPT_TTL_MS = 10 * 60 * 1000;
```

```ts
    const rawState = row.state as WhatsAppFlowState;
    const ratingExpired =
      rawState === WhatsAppFlowState.WAITING_FOR_RATING &&
      Date.now() - new Date(row.updatedAt).getTime() > RATING_PROMPT_TTL_MS;

    return {
      userId: row.userId,
      state: ratingExpired ? WhatsAppFlowState.IDLE : rawState,
      // The timer this replaces cleared BOTH state and rescueRequestId.
      // Returning IDLE while still carrying the finished job's id would
      // leave later code acting on a request the session no longer has any
      // business touching — a subtler version of the stale-state bugs this
      // work exists to remove.
      rescueRequestId: ratingExpired ? undefined : (row.rescueRequestId ?? undefined),
      // ...remaining fields unchanged
    };
```

Extend the Step 1 test to pin that, since it is the part most easily lost:

```ts
    expect(session.state).toBe('IDLE');
    expect(session.rescueRequestId).toBeUndefined();
```

- [ ] **Step 4: Delete `scheduleRatingTimeout` and its callers**

In `whatsapp-customer-flow.service.ts`, delete the `scheduleRatingTimeout` method, the `RATING_TIMEOUT_MS` constant and the `scheduleSafely` import. In `payment-events.service.ts`, delete both `this.customerFlowService.scheduleRatingTimeout(...)` calls and update the spec's expectations accordingly.

- [ ] **Step 5: Delete the timer helper**

```bash
git rm src/common/safe-timer.ts
```

- [ ] **Step 6: Prove no timers remain**

Run:

```bash
grep -rn "setTimeout\|scheduleSafely" src --include="*.ts" | grep -v spec | grep -v "reconciler.service.ts"
```

Expected: **no output.** Any hit is a scheduled job this plan failed to migrate.

- [ ] **Step 7: Run everything**

Run: `yarn tsc --noEmit && npx eslint "{src,apps,libs,test}/**/*.ts" --max-warnings <current ratchet> && yarn jest && yarn test:integration`

Take the ratchet from `.github/workflows/ci.yml`, not from this plan — deleting
files removes warnings with them, so the number falls as this work proceeds and
a figure written here would be stale. Whenever a task lowers the real count,
lower CI's number to match in the same commit; it may never go up.
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add -A src test
git commit -m "feat: derive the rating timeout and remove the last in-memory timers"
```

---

## Verification after the final task

- [ ] `grep -rn "setTimeout" src --include="*.ts" | grep -v spec` returns **no output**. (The reconciler uses `setInterval`, so it does not appear here.)
- [ ] `DispatchOffer.dispatchRound` has no default in `schema.prisma`, and its migration contains both the `DEFAULT -1` and the `DROP DEFAULT` statements.
- [ ] Restart the service locally with a request whose `depositWindowExpiresAt` is in the past; it is cancelled within 15 seconds, proving a restart no longer strands work.
- [ ] Test plan §13 still passes on staging after deploy.
