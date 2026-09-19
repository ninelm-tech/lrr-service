# Account Deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a SUPER_ADMIN delete a customer or operator account — anonymize identity data immediately, retain financial records for the CBN/AML window, purge after — without opening any of the concurrency races a naive implementation would.

**Architecture:** A `deletedAt` column on `User`/`Operator` gates deletion. Every guard follows one fixed three-step shape: **(1) lock** the parent row with a plain `updateMany({ where: { id, deletedAt: null }, data: { updatedAt: now } })` — no relational conditions in this `WHERE`; **(2) read** any child-table conditions (active requests, non-terminal payments, ownership) as a separate, ordinary query, now safe because the lock is held; **(3) write** the irreversible change, still inside the same transaction. This ordering isn't stylistic — Postgres's read-committed re-check (`EvalPlanQual`) only reliably re-evaluates conditions on the row actually being locked when it waits out a concurrent writer; it does not safely re-evaluate relational sub-conditions against fresh data for other tables, so baking `rescueRequests: { none: {...} }`-style conditions directly into the locking `WHERE` can silently approve an action against stale child-table state. Every other place in the codebase that creates a `Payment`, creates a `RescueRequest`, assigns `RescueRequest.assignedOperatorId`, or mutates `OperatorMember` is updated to take the same lock against the same `User`/`Operator` row **before** its own write, so the two sides always serialize on a real row lock rather than a query that only looks atomic. A standalone hourly ticker purges expired `Payment` rows and retries any S3 media deletes that failed inline.

**Tech Stack:** NestJS, Prisma (Postgres), Jest, Next.js/React (lrr-web).

**Spec:** `docs/superpowers/specs/2026-09-15-account-deletion-design.md` — this plan implements every section of it; read both.

## Global Constraints

- Never raise `.github/workflows/ci.yml`'s `--max-warnings 531` ceiling — only lower it. Run `npx eslint "{src,apps,libs,test}/**/*.ts" --max-warnings 531` (lrr-service) before every commit that touches `.ts` files.
- Migrations are hand-written and additive only (Prisma refuses destructive changes non-interactively) — match the style of existing migration files under `prisma/migrations/`.
- Every lock-as-mutex `updateMany` in this feature uses the exact shape `{ where: { id, deletedAt: null }, data: { updatedAt: new Date() } }` — a real column write, not a no-op, so Postgres actually takes the row lock. **This `WHERE` never carries a relational sub-condition** (no `rescueRequests: {...}`, `payments: {...}`, `operatorMembers: {...}` inside a lock's own `WHERE`) — only plain columns on the row being locked itself. Any check that needs to look at a child table happens as a separate read, issued only after the lock's `updateMany` has confirmed `count: 1`.
- `AuditLogService.record()` is never used for the deletion audit entry itself — that one write goes directly to `tx.auditLog.create()` inside the same transaction as the anonymizing update (spec Section 2, point 2).
- lrr-web: replicate the existing `confirm() → try/catch → err instanceof Error ? err.message : fallback` pattern (see `DispatchBoardTab.tsx`/`OperatorsTab.tsx`) for the delete actions — there is no dialog/modal component to build or reuse instead.

---

### Task 1: Schema migration — `deletedAt` columns and the media-deletion outbox table

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_account_deletion/migration.sql`

**Interfaces:**
- Produces: `User.deletedAt: DateTime | null`, `Operator.deletedAt: DateTime | null`, and a new `PendingMediaDeletion` model (`id`, `s3Key` unique, `createdAt`) — every later task depends on these three.
- Modify: `test/integration/factories.ts` — add `"PendingMediaDeletion"` to
  `truncateAll()`'s explicit `TRUNCATE TABLE` list. It has no foreign key to
  the other tables, so `CASCADE` will not clean it between integration tests.

- [ ] **Step 1: Add the fields to the schema**

In `prisma/schema.prisma`, inside `model User { ... }` add one line (anywhere after the existing fields, before the closing `}`):
```prisma
  deletedAt DateTime?
```
Inside `model Operator { ... }`, same addition:
```prisma
  deletedAt DateTime?
```
Add a new model anywhere in the file (convention in this repo is alongside related models — put it near `RequestMedia`):
```prisma
model PendingMediaDeletion {
  id        String   @id @default(cuid())
  s3Key     String   @unique
  createdAt DateTime @default(now())
}
```

- [ ] **Step 2: Write the migration file by hand**

Find today's date-based timestamp prefix convention by looking at the most recent folder under `prisma/migrations/` (format `YYYYMMDDHHMMSS_snake_case_name`). Create `prisma/migrations/<timestamp>_account_deletion/migration.sql`:
```sql
ALTER TABLE "User" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "Operator" ADD COLUMN "deletedAt" TIMESTAMP(3);

CREATE TABLE "PendingMediaDeletion" (
    "id" TEXT NOT NULL,
    "s3Key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PendingMediaDeletion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PendingMediaDeletion_s3Key_key" ON "PendingMediaDeletion"("s3Key");
```

- [ ] **Step 3: Apply the migration and regenerate the client**

Run: `npx prisma migrate dev --name account_deletion` if you have a local dev database configured, otherwise `npx prisma generate` alone is sufficient to update the TypeScript types this plan's later tasks compile against (the actual `migrate dev`/deploy against staging is the user's own action per this project's standing rule — do not run migrations against any shared database yourself).

Expected: `npx prisma generate` succeeds with no errors, and `npx tsc --noEmit` afterward shows `deletedAt` recognized as a valid field on `User`/`Operator` (no new type errors from this change alone).

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "Add deletedAt columns and PendingMediaDeletion table for account deletion"
```

---

### Task 2: `S3Service.deleteObject`

**Files:**
- Modify: `src/integrations/s3/s3.service.ts`
- Test: `src/integrations/s3/s3.service.spec.ts` (create if it doesn't exist — check first)

**Interfaces:**
- Produces: `S3Service.deleteObject(key: string): Promise<void>` — used by Task 10 (`deleteUser`) and Task 11 (`RetryMediaDeletionCheck`).

- [ ] **Step 1: Check for an existing spec file**

Run: `ls src/integrations/s3/*.spec.ts`. If none exists, this task creates the first one, following the mocking style used elsewhere in this repo for AWS SDK clients (mock `S3Client.send`).

- [ ] **Step 2: Write the failing test**

```ts
import { S3Service } from './s3.service';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';

describe('S3Service.deleteObject', () => {
  it('sends a DeleteObjectCommand for the given key', async () => {
    const send = jest.fn().mockResolvedValue({});
    const service = new S3Service({ get: () => 'test-bucket' } as never);
    (service as unknown as { client: { send: typeof send } }).client = { send };

    await service.deleteObject('some/key.jpg');

    expect(send).toHaveBeenCalledWith(expect.any(DeleteObjectCommand));
    const commandArg = send.mock.calls[0][0] as DeleteObjectCommand;
    expect(commandArg.input).toEqual({ Bucket: 'test-bucket', Key: 'some/key.jpg' });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest src/integrations/s3/s3.service.spec.ts`
Expected: FAIL — `deleteObject is not a function`.

- [ ] **Step 4: Implement**

In `src/integrations/s3/s3.service.ts`, add `DeleteObjectCommand` to the existing `@aws-sdk/client-s3` import line (it already imports `PutObjectCommand`, `GetObjectCommand`), then add the method next to `uploadMedia`:
```ts
async deleteObject(key: string): Promise<void> {
  await this.client.send(
    new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/integrations/s3/s3.service.spec.ts`
Expected: PASS.

- [ ] **Step 6: Lint and commit**

```bash
npx eslint "{src,apps,libs,test}/**/*.ts" --max-warnings 531
git add src/integrations/s3/s3.service.ts src/integrations/s3/s3.service.spec.ts
git commit -m "Add S3Service.deleteObject for account-deletion media cleanup"
```

---

### Task 3: `PaymentLedgerService.create()` locks against a deleted customer/operator

**Files:**
- Modify: `src/payment/payment-ledger.service.ts:33-49`
- Test: `src/payment/payment-ledger.service.spec.ts`

**Interfaces:**
- Consumes: `User.deletedAt`, `Operator.deletedAt` (Task 1).
- Produces: `PaymentLedgerService.create()` now throws `BadRequestException` for a deleted party and always runs atomically — every existing caller (`rescue-request-admin.service.ts:189,347`, `payment-events.service.ts:338`, `whatsapp-customer-flow.service.ts:709,1005`, `payout.service.ts:178`) is unaffected in the success path; none needs to change. Also now throws `BadRequestException` for a `PAYOUT` missing `operatorId` — previously such a call silently fell through to the customer-side check instead of failing outright.

- [ ] **Step 1: Read the current method**

Run: `sed -n '1,55p' src/payment/payment-ledger.service.ts` to confirm the exact current imports and the `create()` body before editing (it should match: `create(input: {rescueRequestId, type, amount, operatorId?, tx?}): Promise<Payment>`, a single `client.payment.create(...)` call, `client = input.tx ?? this.prisma`).

- [ ] **Step 2: Write the failing tests**

Add to `src/payment/payment-ledger.service.spec.ts` (find the existing `describe('create'` block — or create one if none exists — and add these inside it; check the existing mock setup for `prisma` in this file first and match its shape):
```ts
it('refuses a PAYOUT for a deleted operator', async () => {
  prisma.operator.updateMany.mockResolvedValue({ count: 0 });

  await expect(
    service.create({
      rescueRequestId: 'req-1',
      type: 'PAYOUT',
      amount: 500000,
      operatorId: 'op-1',
    }),
  ).rejects.toThrow('Cannot create a payout: this operator has been deleted.');

  expect(prisma.payment.create).not.toHaveBeenCalled();
});

it('refuses a DEPOSIT for a request whose customer is deleted', async () => {
  prisma.rescueRequest.findUnique.mockResolvedValue({ customerId: 'cust-1' });
  prisma.user.updateMany.mockResolvedValue({ count: 0 });

  await expect(
    service.create({ rescueRequestId: 'req-1', type: 'DEPOSIT', amount: 500000 }),
  ).rejects.toThrow('Cannot create this payment: the customer has been deleted.');

  expect(prisma.payment.create).not.toHaveBeenCalled();
});

it('creates the payment when the operator is still active', async () => {
  prisma.operator.updateMany.mockResolvedValue({ count: 1 });
  prisma.payment.create.mockResolvedValue({ id: 'pay-1' });

  const result = await service.create({
    rescueRequestId: 'req-1',
    type: 'PAYOUT',
    amount: 500000,
    operatorId: 'op-1',
  });

  expect(result).toEqual({ id: 'pay-1' });
});

it('opens its own transaction when the caller passed no tx', async () => {
  prisma.operator.updateMany.mockResolvedValue({ count: 1 });
  prisma.payment.create.mockResolvedValue({ id: 'pay-1' });
  prisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(prisma));

  await service.create({
    rescueRequestId: 'req-1',
    type: 'PAYOUT',
    amount: 500000,
    operatorId: 'op-1',
  });

  expect(prisma.$transaction).toHaveBeenCalled();
});

it('rejects a PAYOUT with no operatorId outright, rather than silently falling through to the customer-side check', async () => {
  // A malformed call: without this rejection, `type === PAYOUT && operatorId`
  // would be false (falsy operatorId), sending it down the customer branch
  // — which checks the WRONG party's deletedAt (the request's customer,
  // not any operator) and would then insert a payout row with
  // operatorId: null. This must fail before either branch's lock runs.
  await expect(
    service.create({ rescueRequestId: 'req-1', type: 'PAYOUT', amount: 500000 }),
  ).rejects.toThrow('A PAYOUT payment must have an operatorId.');

  expect(prisma.rescueRequest.findUnique).not.toHaveBeenCalled();
  expect(prisma.user.updateMany).not.toHaveBeenCalled();
  expect(prisma.payment.create).not.toHaveBeenCalled();
});
```
If the spec file's `prisma` mock doesn't already include `operator.updateMany`, `user.updateMany`, `rescueRequest.findUnique`, and `$transaction`, add `jest.fn()` entries for each in its `beforeEach` setup, matching the existing mock's style (look at how `payment.create` is already mocked there for the pattern).

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx jest src/payment/payment-ledger.service.spec.ts`
Expected: FAIL on all four new tests (the lock logic doesn't exist yet).

- [ ] **Step 4: Implement**

Replace `create()` in `src/payment/payment-ledger.service.ts`:
```ts
async create(input: {
  rescueRequestId: string;
  type: PaymentType;
  amount: number;
  operatorId?: string;
  tx?: Prisma.TransactionClient;
}): Promise<Payment> {
  const run = async (client: Prisma.TransactionClient | PrismaService) => {
    if (input.type === PaymentType.PAYOUT) {
      // Branch purely on `type`, not `type && operatorId` — the AND form
      // let a malformed PAYOUT call with no operatorId fall through to
      // the customer branch below (checking the wrong party's deletedAt
      // entirely) and then insert a payout row with operatorId: null.
      if (!input.operatorId) {
        throw new BadRequestException('A PAYOUT payment must have an operatorId.');
      }
      const stillActive = await client.operator.updateMany({
        where: { id: input.operatorId, deletedAt: null },
        data: { updatedAt: new Date() },
      });
      if (stillActive.count === 0) {
        throw new BadRequestException(
          'Cannot create a payout: this operator has been deleted.',
        );
      }
    } else {
      const rescueRequest = await client.rescueRequest.findUnique({
        where: { id: input.rescueRequestId },
        select: { customerId: true },
      });
      if (rescueRequest) {
        const stillActive = await client.user.updateMany({
          where: { id: rescueRequest.customerId, deletedAt: null },
          data: { updatedAt: new Date() },
        });
        if (stillActive.count === 0) {
          throw new BadRequestException(
            'Cannot create this payment: the customer has been deleted.',
          );
        }
      }
    }

    return client.payment.create({
      data: {
        rescueRequestId: input.rescueRequestId,
        type: input.type,
        amount: input.amount,
        operatorId: input.operatorId ?? null,
      },
    });
  };

  if (input.tx) return run(input.tx);
  return this.prisma.$transaction((tx) => run(tx));
}
```
Add `BadRequestException` to the `@nestjs/common` import if not already present.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest src/payment/payment-ledger.service.spec.ts`
Expected: PASS, including all pre-existing tests in this file (the `tx`-provided path must still work exactly as before for callers that already pass one, if any do — check for `tx:` in existing test cases).

- [ ] **Step 6: Full suite, lint, commit**

```bash
npx jest --silent
npx eslint "{src,apps,libs,test}/**/*.ts" --max-warnings 531
git add src/payment/payment-ledger.service.ts src/payment/payment-ledger.service.spec.ts
git commit -m "Lock PaymentLedgerService.create() against a deleted customer or operator"
```

---

### Task 4: Close the RescueRequest-creation race in the WhatsApp flow

**Files:**
- Modify: `src/rescue-request/rescue-request-shared.service.ts:28-34`
- Modify: `src/rescue-request/whatsapp-customer-flow.service.ts:415-426`
- Test: `src/rescue-request/rescue-request-shared.service.spec.ts`
- Test: `src/rescue-request/whatsapp-customer-flow.service.spec.ts`

**Interfaces:**
- Consumes: `User.deletedAt` (Task 1).
- Produces: `RescueRequestSharedService.findOrCreateCustomer(phoneNumber, client?)` — `client` is a new optional second parameter, `Prisma.TransactionClient | PrismaService`, defaulting to `this.prisma`.

- [ ] **Step 1: Write the failing test for `findOrCreateCustomer`**

In `src/rescue-request/rescue-request-shared.service.spec.ts` (find or create the `describe('findOrCreateCustomer'` block):
```ts
it('runs against the given transaction client when one is provided', async () => {
  const txUser = { upsert: jest.fn().mockResolvedValue({ id: 'cust-1' }) };
  const tx = { user: txUser } as never;

  const result = await service.findOrCreateCustomer('+2348012345678', tx);

  expect(txUser.upsert).toHaveBeenCalledWith({
    where: { phoneNumber: '+2348012345678' },
    update: {},
    create: { phoneNumber: '+2348012345678', role: 'CUSTOMER' },
  });
  expect(prisma.user.upsert).not.toHaveBeenCalled();
  expect(result).toEqual({ id: 'cust-1' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/rescue-request/rescue-request-shared.service.spec.ts`
Expected: FAIL — the method doesn't accept a second argument yet, so `txUser.upsert` is never called (the real `prisma.user.upsert` runs instead).

- [ ] **Step 3: Implement the signature change**

In `src/rescue-request/rescue-request-shared.service.ts`, replace:
```ts
async findOrCreateCustomer(phoneNumber: string) {
  return this.prisma.user.upsert({
    where: { phoneNumber },
    update: {},
    create: { phoneNumber, role: UserRole.CUSTOMER },
  });
}
```
with:
```ts
async findOrCreateCustomer(
  phoneNumber: string,
  client: Prisma.TransactionClient | PrismaService = this.prisma,
) {
  return client.user.upsert({
    where: { phoneNumber },
    update: {},
    create: { phoneNumber, role: UserRole.CUSTOMER },
  });
}
```
Add `Prisma` to this file's `@prisma/client` import if not already present (check the existing `import { UserRole } from '@prisma/client';` line and extend it to `import { Prisma, UserRole } from '@prisma/client';`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/rescue-request/rescue-request-shared.service.spec.ts`
Expected: PASS, and all pre-existing tests in this file still pass (the default-parameter change is backward compatible for every call site that doesn't pass a second argument).

- [ ] **Step 5: Write the failing test for the creation-race lock**

In `src/rescue-request/whatsapp-customer-flow.service.spec.ts`, find the test(s) covering the destination-collection step (search for `WAITING_FOR_MEDIA` or `rescueRequest.create`) and add:
```ts
it('aborts request creation when the customer was deleted before the transaction commits', async () => {
  sharedService.findOrCreateCustomer.mockResolvedValue({ id: 'cust-1' });
  prisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(prisma));
  prisma.user.updateMany.mockResolvedValue({ count: 0 });

  await expect(
    service.handleDestinationMessage(/* existing test's args for this step */),
  ).rejects.toThrow('This account is no longer active.');

  expect(prisma.rescueRequest.create).not.toHaveBeenCalled();
});
```
Adapt the call signature (`handleDestinationMessage(...)` or whatever the actual method under test is called — check the surrounding existing tests in this file for the exact method name and arguments used to reach the destination-collection step) to match what the existing tests in this `describe` block already use; do not invent new argument shapes.

- [ ] **Step 6: Run test to verify it fails**

Run: `npx jest src/rescue-request/whatsapp-customer-flow.service.spec.ts`
Expected: FAIL — no lock exists yet, so `rescueRequest.create` is still called.

- [ ] **Step 7: Implement the lock**

In `src/rescue-request/whatsapp-customer-flow.service.ts`, replace the two statements at lines 415-426:
```ts
const customer =
  await this.sharedService.findOrCreateCustomer(phoneNumber);
const rescueRequest = await this.prisma.rescueRequest.create({
  data: {
    customerId: customer.id,
    status: RescueRequestStatus.WAITING_FOR_MEDIA,
    latitude: session.latitude,
    longitude: session.longitude,
    vehicleType: session.vehicleType as VehicleType,
    destination,
  },
});
```
with:
```ts
const rescueRequest = await this.prisma.$transaction(async (tx) => {
  const customer = await this.sharedService.findOrCreateCustomer(phoneNumber, tx);

  const stillActive = await tx.user.updateMany({
    where: { id: customer.id, deletedAt: null },
    data: { updatedAt: new Date() },
  });
  if (stillActive.count === 0) {
    throw new BadRequestException('This account is no longer active.');
  }

  return tx.rescueRequest.create({
    data: {
      customerId: customer.id,
      status: RescueRequestStatus.WAITING_FOR_MEDIA,
      latitude: session.latitude,
      longitude: session.longitude,
      vehicleType: session.vehicleType as VehicleType,
      destination,
    },
  });
});
```
Add `BadRequestException` to this file's `@nestjs/common` import if not already present.

- [ ] **Step 8: Run test to verify it passes**

Run: `npx jest src/rescue-request/whatsapp-customer-flow.service.spec.ts`
Expected: PASS, including every pre-existing test in this file (the happy path is unchanged in behavior, just wrapped in a transaction).

- [ ] **Step 9: Full suite, lint, commit**

```bash
npx jest --silent
npx eslint "{src,apps,libs,test}/**/*.ts" --max-warnings 531
git add src/rescue-request/rescue-request-shared.service.ts src/rescue-request/rescue-request-shared.service.spec.ts src/rescue-request/whatsapp-customer-flow.service.ts src/rescue-request/whatsapp-customer-flow.service.spec.ts
git commit -m "Close the customer-deletion race in WhatsApp request creation"
```

---

### Task 5: `OperatorMembershipService` — the shared membership resolver

**Files:**
- Create: `src/operator/operator-membership.service.ts`
- Test: `src/operator/operator-membership.service.spec.ts`
- Modify: `src/operator/operator.module.ts`

**Interfaces:**
- Consumes: `User.deletedAt`, `Operator.deletedAt` (Task 1).
- Produces: `OperatorMembershipService.findActiveOperatorIdsForUser(userId): Promise<string[]>`, `.assertActiveMembership(userId, operatorId): Promise<void>` (throws `ForbiddenException`), `.lockActiveMembership(tx, actingUser: {userId: string; role: string}, operatorId): Promise<void>` (throws `ForbiddenException`) — consumed by Tasks 7, 8, 9. **Note the signature takes the acting user's role, not just their id** — `assertCanManageOperator`/`assertIsMemberOrAdmin` (the existing pre-checks this is paired with) both let an `ADMIN`/`SUPER_ADMIN` through with no `OperatorMember` row at all; `lockActiveMembership` must recognize the same bypass, or an admin who legitimately passed the pre-check would then fail this stricter re-check purely for not being a member of a business they were never meant to be a member of.

- [ ] **Step 1: Write the failing tests**

Create `src/operator/operator-membership.service.spec.ts`:
```ts
import { Test, TestingModule } from '@nestjs/testing';
import { OperatorMembershipService } from './operator-membership.service';
import { PrismaService } from '../prisma/prisma.service';

describe('OperatorMembershipService', () => {
  let service: OperatorMembershipService;
  let prisma: {
    operatorMember: { findMany: jest.Mock; findFirst: jest.Mock };
    user: { updateMany: jest.Mock };
    operator: { updateMany: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      operatorMember: { findMany: jest.fn(), findFirst: jest.fn() },
      user: { updateMany: jest.fn() },
      operator: { updateMany: jest.fn() },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OperatorMembershipService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(OperatorMembershipService);
  });

  describe('findActiveOperatorIdsForUser', () => {
    it('excludes a deleted operator via the relation filter', async () => {
      prisma.operatorMember.findMany.mockResolvedValue([{ operatorId: 'op-1' }]);

      const result = await service.findActiveOperatorIdsForUser('user-1');

      expect(prisma.operatorMember.findMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', operator: { deletedAt: null }, user: { deletedAt: null } },
        select: { operatorId: true },
      });
      expect(result).toEqual(['op-1']);
    });
  });

  describe('assertActiveMembership', () => {
    it('throws when no membership matches (operator or user deleted, or not a member)', async () => {
      prisma.operatorMember.findFirst.mockResolvedValue(null);

      await expect(
        service.assertActiveMembership('user-1', 'op-1'),
      ).rejects.toThrow('Not a member of this operator, the operator has been deleted, or this account has been deleted.');
    });

    it('resolves when an active membership matches', async () => {
      prisma.operatorMember.findFirst.mockResolvedValue({ id: 'mem-1' });

      await expect(
        service.assertActiveMembership('user-1', 'op-1'),
      ).resolves.toBeUndefined();
    });
  });

  describe('lockActiveMembership', () => {
    const tx = {
      operatorMember: { findFirst: jest.fn() },
      user: { updateMany: jest.fn() },
      operator: { updateMany: jest.fn() },
    } as never;
    const operatorStaff = { userId: 'user-1', role: 'OPERATOR' };
    const admin = { userId: 'admin-1', role: 'SUPER_ADMIN' };

    it('throws when the acting user has been deleted, before ever reading membership', async () => {
      const t = tx as {
        operatorMember: { findFirst: jest.Mock };
        user: { updateMany: jest.Mock };
      };
      t.user.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.lockActiveMembership(tx, operatorStaff, 'op-1'),
      ).rejects.toThrow('This account has been deleted.');

      expect(t.operatorMember.findFirst).not.toHaveBeenCalled();
    });

    it('throws when the acting admin has been deleted', async () => {
      const t = tx as { user: { updateMany: jest.Mock } };
      t.user.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.lockActiveMembership(tx, admin, 'op-1'),
      ).rejects.toThrow('This account has been deleted.');
    });

    it('locks the user, then throws when the operator has been deleted, before ever reading membership', async () => {
      const t = tx as {
        operatorMember: { findFirst: jest.Mock };
        user: { updateMany: jest.Mock };
        operator: { updateMany: jest.Mock };
      };
      t.user.updateMany.mockResolvedValue({ count: 1 });
      t.operator.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.lockActiveMembership(tx, operatorStaff, 'op-1'),
      ).rejects.toThrow('This operator has been deleted.');

      expect(t.operatorMember.findFirst).not.toHaveBeenCalled();
    });

    it('throws when both locks succeed but no membership row exists (non-admin)', async () => {
      // This is the regression that matters most for this method: an
      // earlier draft read membership FIRST, unlocked — a plain read
      // racy against a concurrent removeMember on the same operator.
      // Both row locks must be acquired before this read is trusted.
      const t = tx as {
        operatorMember: { findFirst: jest.Mock };
        user: { updateMany: jest.Mock };
        operator: { updateMany: jest.Mock };
      };
      t.user.updateMany.mockResolvedValue({ count: 1 });
      t.operator.updateMany.mockResolvedValue({ count: 1 });
      t.operatorMember.findFirst.mockResolvedValue(null);

      await expect(
        service.lockActiveMembership(tx, operatorStaff, 'op-1'),
      ).rejects.toThrow('Not a member of this operator.');
    });

    it('skips the membership-row check entirely for an ADMIN/SUPER_ADMIN, once both locks succeed', async () => {
      const t = tx as {
        operatorMember: { findFirst: jest.Mock };
        user: { updateMany: jest.Mock };
        operator: { updateMany: jest.Mock };
      };
      t.user.updateMany.mockResolvedValue({ count: 1 });
      t.operator.updateMany.mockResolvedValue({ count: 1 });

      await expect(
        service.lockActiveMembership(tx, admin, 'op-1'),
      ).resolves.toBeUndefined();
      expect(t.operatorMember.findFirst).not.toHaveBeenCalled();
    });

    it('resolves when membership, user, and operator are all active', async () => {
      const t = tx as {
        operatorMember: { findFirst: jest.Mock };
        user: { updateMany: jest.Mock };
        operator: { updateMany: jest.Mock };
      };
      t.operatorMember.findFirst.mockResolvedValue({ id: 'mem-1' });
      t.user.updateMany.mockResolvedValue({ count: 1 });
      t.operator.updateMany.mockResolvedValue({ count: 1 });

      await expect(
        service.lockActiveMembership(tx, operatorStaff, 'op-1'),
      ).resolves.toBeUndefined();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/operator/operator-membership.service.spec.ts`
Expected: FAIL — the file doesn't exist yet (module resolution error).

- [ ] **Step 3: Implement**

Create `src/operator/operator-membership.service.ts`:
```ts
import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class OperatorMembershipService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Operators this User may currently act for — excludes a deleted
   * Operator, AND excludes the case where the acting User themselves has
   * been deleted (their JWT can still be valid for up to 24h, so this
   * must not trust a live session alone).
   */
  async findActiveOperatorIdsForUser(userId: string): Promise<string[]> {
    const memberships = await this.prisma.operatorMember.findMany({
      where: { userId, operator: { deletedAt: null }, user: { deletedAt: null } },
      select: { operatorId: true },
    });
    return memberships.map((m) => m.operatorId);
  }

  /** Throws unless this User is a member of this specific, non-deleted Operator, and is not themselves deleted. */
  async assertActiveMembership(userId: string, operatorId: string): Promise<void> {
    const membership = await this.prisma.operatorMember.findFirst({
      where: { userId, operatorId, operator: { deletedAt: null }, user: { deletedAt: null } },
    });
    if (!membership) {
      throw new ForbiddenException(
        'Not a member of this operator, the operator has been deleted, or this account has been deleted.',
      );
    }
  }

  /**
   * For mutations only — `assertActiveMembership` above is a pre-check,
   * not a guard. Call this ADDITIONALLY, as the first statement inside
   * the same transaction as the mutation that follows (do not use it to
   * replace a role-based authorization check like
   * `OperatorService.assertCanManageOperator` — this re-verifies that
   * neither party has been deleted since that check ran, it does not
   * re-derive the authorization decision itself).
   *
   * `actingUser.role` matters: `assertCanManageOperator`/
   * `assertIsMemberOrAdmin` both let an ADMIN/SUPER_ADMIN through with no
   * `OperatorMember` row at all — an admin managing an operator is never
   * expected to BE a member of that operator's business. This method must
   * recognize the same bypass, or an admin who legitimately passed the
   * pre-check would fail here purely for not being a member of a business
   * they were never meant to join.
   *
   * **Lock order matters and is fixed: User, then Operator, then — only
   * once both locks are held — read the membership row.** An earlier
   * draft read the membership FIRST, before locking anything: that's a
   * plain, unlocked read, racy against a concurrent `removeMember` on the
   * same operator (it could delete that exact row between this read and
   * the writes that follow). Reading it after both locks are held is
   * safe because `addMember`/`removeMember` themselves also lock this
   * same Operator row before touching its memberships (Task 8) — so any
   * concurrent membership change is either already fully committed
   * before we acquire our lock (and this read sees it) or blocked behind
   * our lock entirely (and can't happen until we're done).
   */
  async lockActiveMembership(
    tx: Prisma.TransactionClient,
    actingUser: { userId: string; role: string },
    operatorId: string,
  ): Promise<void> {
    const userStillActive = await tx.user.updateMany({
      where: { id: actingUser.userId, deletedAt: null },
      data: { updatedAt: new Date() },
    });
    if (userStillActive.count === 0) {
      throw new ForbiddenException('This account has been deleted.');
    }

    const operatorStillActive = await tx.operator.updateMany({
      where: { id: operatorId, deletedAt: null },
      data: { updatedAt: new Date() },
    });
    if (operatorStillActive.count === 0) {
      throw new ForbiddenException('This operator has been deleted.');
    }

    const isPrivilegedAdmin =
      actingUser.role === UserRole.ADMIN || actingUser.role === UserRole.SUPER_ADMIN;
    if (!isPrivilegedAdmin) {
      const membership = await tx.operatorMember.findFirst({
        where: { userId: actingUser.userId, operatorId },
      });
      if (!membership) {
        throw new ForbiddenException('Not a member of this operator.');
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/operator/operator-membership.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Wire into the module**

In `src/operator/operator.module.ts`, add the import and register it:
```ts
import { OperatorMembershipService } from './operator-membership.service';
```
Add `OperatorMembershipService` to both the `providers` array and the `exports` array (alongside the existing `OperatorService`).

- [ ] **Step 6: Full suite, lint, commit**

```bash
npx jest --silent
npx eslint "{src,apps,libs,test}/**/*.ts" --max-warnings 531
git add src/operator/operator-membership.service.ts src/operator/operator-membership.service.spec.ts src/operator/operator.module.ts
git commit -m "Add OperatorMembershipService — the one place operator membership is resolved"
```

---

### Task 6: Migrate the read-only membership lookups to `OperatorMembershipService`

**Files:**
- Modify: `src/operator/operator.service.ts:592-600` (`findByUserId`)
- Modify: `src/rescue-request/rescue-request-admin.service.ts:509-523,525-556` (`operatorList`, `operatorDetail` — dead code, no live caller, migrate anyway for consistency), and the `OPERATOR` branches inside `listForUser` (~line 610-624) and `detailForUser` (~line 689-701)
- Modify: `src/rescue-request/dispatch.service.ts:1202-1255` (`listMyPendingOffers`)
- Test: `src/operator/operator.service.spec.ts`
- Test: `src/rescue-request/rescue-request-admin.service.spec.ts`
- Test: `src/rescue-request/dispatch.service.spec.ts`

**Interfaces:**
- Consumes: `OperatorMembershipService.findActiveOperatorIdsForUser` (Task 5).

These five call sites are all plain reads (list/detail views) — none is a mutation, so this task is a mechanical swap, not a transactional restructuring.

- [ ] **Step 1: `operator.service.ts` — inject and swap `findByUserId`**

Read the current file's constructor and add `OperatorMembershipService` (note: `findByUserId` itself doesn't need the new service — it queries `Operator` via a *different* shape, `operatorMember.findFirst({where:{userId}, include:{operator:{...full nested include...}}})`, returning the full operator object with nested members, not just an id list. `findActiveOperatorIdsForUser` returns ids only, so it can't directly replace this method's return shape. Instead, add the deletion filter directly to `findByUserId`'s own query — do NOT route it through `OperatorMembershipService` for this one, since the shapes don't match). Filter on **both** sides — the operator AND the acting user calling this (`GET /operators/me`) — the same "a deleted staff member's still-valid JWT must not resolve their old operator" concern `OperatorMembershipService` itself was built to close applies here too, and `operator: { deletedAt: null }` alone doesn't cover it:
```ts
async findByUserId(userId: string) {
  const membership = await this.prisma.operatorMember.findFirst({
    where: { userId, operator: { deletedAt: null }, user: { deletedAt: null } },
    include: {
      operator: { include: { members: { include: { user: true } } } },
    },
  });
  return membership?.operator || null;
}
```
This is a one-line `where` change (add `operator: { deletedAt: null }, user: { deletedAt: null }`) — no new dependency, no test-mock restructuring needed beyond adding both to the existing test's expected `where` argument if one already asserts on it. Check `operator.service.spec.ts` for an existing `findByUserId` test and update its `toHaveBeenCalledWith` assertion accordingly; if none exists, add one:
```ts
it('excludes a deleted operator or a deleted acting user', async () => {
  prisma.operatorMember.findFirst.mockResolvedValue(null);

  await service.findByUserId('user-1');

  expect(prisma.operatorMember.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({ where: { userId: 'user-1', operator: { deletedAt: null }, user: { deletedAt: null } } }),
  );
});
```

- [ ] **Step 2: Run, verify, commit this sub-step**

Run: `npx jest src/operator/operator.service.spec.ts`
Expected: PASS.

- [ ] **Step 3: `rescue-request-admin.service.ts` — inject `OperatorMembershipService` and swap all four lookups**

Add to the constructor:
```ts
private readonly operatorMembershipService: OperatorMembershipService,
```
And the import:
```ts
import { OperatorMembershipService } from '../operator/operator-membership.service';
```
Replace each of the four inline lookups. In `operatorList`:
```ts
async operatorList(userId: string, query: any) {
  const operatorIds = await this.operatorMembershipService.findActiveOperatorIdsForUser(userId);
  if (operatorIds.length === 0)
    return { data: [], meta: { page: 1, limit: 20, total: 0 } };

  const where: any = { assignedOperatorId: { in: operatorIds } };
  const { status, page = 1, limit = 20 } = query;
  if (status) where.status = status;

  return this.buildListResponse(where, Number(page), Number(limit));
}
```
In `operatorDetail`, replace the `memberships`/`operatorIds` block:
```ts
async operatorDetail(userId: string, id: string) {
  const operatorIds = await this.operatorMembershipService.findActiveOperatorIdsForUser(userId);
  // ...rest of the method unchanged (the `raw` findUnique and the check below it)
```
In `listForUser`'s `OPERATOR` branch, replace:
```ts
const memberships = await this.prisma.operatorMember.findMany({
  where: { userId: user.userId },
  select: { operatorId: true },
});
const operatorIds = memberships.map((m) => m.operatorId);
```
with:
```ts
const operatorIds = await this.operatorMembershipService.findActiveOperatorIdsForUser(user.userId);
```
In `detailForUser`'s `OPERATOR` branch, same replacement pattern using `userId` (the destructured variable already in scope there).

- [ ] **Step 4: Update this file's tests**

For each of the four call sites' existing test cases, replace any `prisma.operatorMember.findMany` mock setup with a mock on `operatorMembershipService.findActiveOperatorIdsForUser` instead (add `operatorMembershipService: { findActiveOperatorIdsForUser: jest.fn() }` to the test file's provider mocks, following this file's existing mock-provider pattern for its other injected services). Update each test's arrange step from `prisma.operatorMember.findMany.mockResolvedValue([{operatorId: 'op-1'}])` to `operatorMembershipService.findActiveOperatorIdsForUser.mockResolvedValue(['op-1'])`.

- [ ] **Step 5: Run, verify**

Run: `npx jest src/rescue-request/rescue-request-admin.service.spec.ts`
Expected: PASS.

- [ ] **Step 6: `dispatch.service.ts` — inject `OperatorMembershipService` and swap `listMyPendingOffers`**

`DispatchService` already injects `OperatorService` — add `OperatorMembershipService` alongside it in the constructor and import. Replace:
```ts
const memberships = await this.prisma.operatorMember.findMany({
  where: { userId },
  select: { operatorId: true },
});
if (memberships.length === 0) return { data: [] };

const offers = await this.prisma.dispatchOffer.findMany({
  where: {
    operatorId: { in: memberships.map((m) => m.operatorId) },
```
with:
```ts
const operatorIds = await this.operatorMembershipService.findActiveOperatorIdsForUser(userId);
if (operatorIds.length === 0) return { data: [] };

const offers = await this.prisma.dispatchOffer.findMany({
  where: {
    operatorId: { in: operatorIds },
```
(the rest of the method — `include`, mapping, `apiBaseUrl` — is unchanged).

- [ ] **Step 7: Update this test file and run**

Same mock-swap pattern as Step 4, applied to `dispatch.service.spec.ts`'s `listMyPendingOffers` tests.

Run: `npx jest src/rescue-request/dispatch.service.spec.ts`
Expected: PASS.

- [ ] **Step 8: Full suite, lint, commit**

```bash
npx jest --silent
npx eslint "{src,apps,libs,test}/**/*.ts" --max-warnings 531
git add src/operator/operator.service.ts src/operator/operator.service.spec.ts src/rescue-request/rescue-request-admin.service.ts src/rescue-request/rescue-request-admin.service.spec.ts src/rescue-request/dispatch.service.ts src/rescue-request/dispatch.service.spec.ts
git commit -m "Migrate read-only operator-membership lookups to OperatorMembershipService"
```

---

### Task 7: `setAvailability` locks against deletion via `lockActiveMembership`

**Files:**
- Modify: `src/operator/operator.service.ts` (`setAvailability`, around line 802)
- Modify: `src/operator/operator.controller.ts:177-193`
- Test: `src/operator/operator.service.spec.ts`

**Interfaces:**
- Consumes: `OperatorMembershipService.lockActiveMembership` (Task 5).
- Produces: `OperatorService.setAvailability(id, isAvailable, actingUser: {userId: string; role: string})` — signature gains a required third parameter (the whole `req.user`, not just its id — `lockActiveMembership` needs `role` to apply the admin bypass); the existing role/membership pre-check (`assertIsMemberOrAdmin`) in the controller is UNCHANGED and stays as-is, this task adds an ADDITIONAL atomicity guard inside the mutation itself.

- [ ] **Step 1: Inject `OperatorMembershipService` into `OperatorService`**

Add to the constructor:
```ts
private readonly operatorMembershipService: OperatorMembershipService,
```
And the import:
```ts
import { OperatorMembershipService } from './operator-membership.service';
```
Also add `Prisma` to this file's existing `@prisma/client` import (it currently imports only specific enums, not the `Prisma` namespace) — required for the `Prisma.TransactionClient` type used inside the transaction callback (TypeScript infers this automatically from `this.prisma.$transaction`, so no explicit type annotation is actually required in the callback signature — only import `Prisma` if you choose to annotate it explicitly for clarity).

- [ ] **Step 2: Write the failing test**

In `src/operator/operator.service.spec.ts`, find the existing `setAvailability` test(s) and add:
```ts
it('locks membership before writing, and passes through the new deleted-operator rejection', async () => {
  operatorMembershipService.lockActiveMembership.mockRejectedValue(
    new ForbiddenException('This operator has been deleted.'),
  );
  prisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(prisma));

  await expect(
    service.setAvailability('op-1', true, { userId: 'user-1', role: 'OPERATOR' }),
  ).rejects.toThrow('This operator has been deleted.');

  expect(prisma.operator.update).not.toHaveBeenCalled();
});

it('updates availability when the lock succeeds', async () => {
  operatorMembershipService.lockActiveMembership.mockResolvedValue(undefined);
  prisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(prisma));
  prisma.operator.update.mockResolvedValue({ id: 'op-1', isAvailable: true });

  const result = await service.setAvailability('op-1', true, { userId: 'user-1', role: 'OPERATOR' });

  expect(operatorMembershipService.lockActiveMembership).toHaveBeenCalledWith(
    prisma, { userId: 'user-1', role: 'OPERATOR' }, 'op-1',
  );
  expect(result).toEqual({ id: 'op-1', isAvailable: true });
});
```
Add `operatorMembershipService: { lockActiveMembership: jest.fn() }` to this spec file's provider mocks if not already present from Task 6's edits, and ensure `prisma.$transaction` is a `jest.fn()` in this file's `prisma` mock object (add it if missing).

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest src/operator/operator.service.spec.ts`
Expected: FAIL — `setAvailability` doesn't take a third argument or call the lock yet.

- [ ] **Step 4: Implement**

Replace `setAvailability`:
```ts
async setAvailability(
  id: string,
  isAvailable: boolean,
  actingUser: { userId: string; role: string },
) {
  return this.prisma.$transaction(async (tx) => {
    await this.operatorMembershipService.lockActiveMembership(tx, actingUser, id);
    return tx.operator.update({
      where: { id },
      data: { isAvailable },
    });
  });
}
```

- [ ] **Step 5: Update the controller call site**

In `src/operator/operator.controller.ts`, `setAvailability` (lines 177-193) — the existing `assertIsMemberOrAdmin` call STAYS, unchanged, immediately before this; only the call to the mutation itself changes to pass `req.user` (not just its id — `lockActiveMembership` needs the role too, to apply the admin bypass):
```ts
@UseGuards(AuthGuard)
@Patch(':id/availability')
async setAvailability(
  @Req() req: any,
  @Param('id') id: string,
  @Body('isAvailable') isAvailable: boolean,
) {
  await this.operatorService.assertIsMemberOrAdmin(req.user, id);
  const operator = await this.operatorService.setAvailability(
    id,
    Boolean(isAvailable),
    req.user,
  );
  return {
    message: `Operator availability set to ${isAvailable}`,
    data: operator,
  };
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx jest src/operator/operator.service.spec.ts`
Expected: PASS.

- [ ] **Step 7: Full suite, lint, commit**

```bash
npx jest --silent
npx eslint "{src,apps,libs,test}/**/*.ts" --max-warnings 531
git add src/operator/operator.service.ts src/operator/operator.service.spec.ts src/operator/operator.controller.ts
git commit -m "Lock setAvailability against concurrent operator deletion"
```

---

### Task 8: The `assertCanManageOperator`-gated mutations lock against deletion

**Files:**
- Modify: `src/operator/operator.service.ts` (`updateProfile`, `saveBankDetails`, `clearBankDetails`, `addMember`, `removeMember`)
- Modify: `src/operator/operator.controller.ts:103-155,207-232`
- Test: `src/operator/operator.service.spec.ts`

**Interfaces:**
- Consumes: `OperatorMembershipService.lockActiveMembership` (Task 5), same shared instance already injected in Task 7.

Same pattern as Task 7, applied to five methods. `saveBankDetails` makes an external Paystack API call — the transaction deliberately wraps the whole thing including that call (this is a rare, low-frequency admin action; the correctness guarantee from holding the lock across it matters more than the connection briefly held open, and there's no realistic contention on this specific operator row from any other write during a bank-details save).

- [ ] **Step 1: Write the failing tests**

Add to `src/operator/operator.service.spec.ts`, one pair (rejects-when-deleted / succeeds-when-active) per method, following the exact shape from Task 7's tests. Example for `clearBankDetails` (the simplest of the five — no external call, no input DTO):
```ts
describe('clearBankDetails', () => {
  const actingUser = { userId: 'user-1', role: 'OWNER-holding-user' }; // any non-ADMIN role — the exact value doesn't matter to this test, only that it's passed through unchanged

  it('locks membership before clearing', async () => {
    operatorMembershipService.lockActiveMembership.mockRejectedValue(
      new ForbiddenException('This operator has been deleted.'),
    );
    prisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(prisma));

    await expect(
      service.clearBankDetails('op-1', actingUser),
    ).rejects.toThrow('This operator has been deleted.');

    expect(prisma.operator.update).not.toHaveBeenCalled();
  });

  it('clears bank fields when the lock succeeds', async () => {
    operatorMembershipService.lockActiveMembership.mockResolvedValue(undefined);
    prisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(prisma));
    prisma.operator.findUnique.mockResolvedValue({ id: 'op-1' });
    prisma.operator.update.mockResolvedValue({ id: 'op-1', bankName: null });

    const result = await service.clearBankDetails('op-1', actingUser);

    expect(operatorMembershipService.lockActiveMembership).toHaveBeenCalledWith(prisma, actingUser, 'op-1');
    expect(result).toEqual({ id: 'op-1', bankName: null });
  });
});
```
Write the analogous pair for `updateProfile`, `saveBankDetails` (mock `paystackService` unchanged from however it's already mocked in this file), `addMember`, and `removeMember` — each asserting `lockActiveMembership` is called with `(prisma, actingUser, <operatorId>)` before the respective mutation, and that the mutation is skipped when the lock rejects. Include one test (on any one of the five — `clearBankDetails` is fine) asserting the ADMIN-bypass path too: pass `{ userId: 'admin-1', role: 'SUPER_ADMIN' }`, let `lockActiveMembership` resolve, and confirm the mutation still proceeds — this doesn't need new logic in these five methods themselves (the bypass lives entirely in `lockActiveMembership`), but it's worth one assertion here confirming the plumbing actually reaches an admin caller through end to end.

`addMember` additionally needs its own target-user-lock tests (add to its `describe` block):
```ts
it('locks the target user before creating the membership', async () => {
  operatorMembershipService.lockActiveMembership.mockResolvedValue(undefined);
  prisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(prisma));
  prisma.user.updateMany.mockResolvedValue({ count: 0 });

  await expect(
    service.addMember('op-1', { userId: 'new-user-1', role: 'STAFF' }, actingUser),
  ).rejects.toThrow('Cannot add this member: account not found or has been deleted.');

  expect(prisma.operatorMember.create).not.toHaveBeenCalled();
});

it('creates the membership once both locks succeed', async () => {
  operatorMembershipService.lockActiveMembership.mockResolvedValue(undefined);
  prisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(prisma));
  prisma.user.updateMany.mockResolvedValue({ count: 1 });
  prisma.operatorMember.findUnique.mockResolvedValue(null);
  prisma.operatorMember.create.mockResolvedValue({ id: 'mem-1' });

  const result = await service.addMember('op-1', { userId: 'new-user-1', role: 'STAFF' }, actingUser);

  expect(prisma.user.updateMany).toHaveBeenCalledWith({
    where: { id: 'new-user-1', deletedAt: null },
    data: { updatedAt: expect.any(Date) },
  });
  expect(result).toEqual({ id: 'mem-1' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/operator/operator.service.spec.ts`
Expected: FAIL for all five new test pairs.

- [ ] **Step 3: Implement — `clearBankDetails`**

```ts
async clearBankDetails(id: string, actingUser: { userId: string; role: string }) {
  return this.prisma.$transaction(async (tx) => {
    await this.operatorMembershipService.lockActiveMembership(tx, actingUser, id);
    const operator = await tx.operator.findUnique({ where: { id } });
    if (!operator) throw new NotFoundException('Operator not found');

    return tx.operator.update({
      where: { id },
      data: {
        bankName: null,
        accountName: null,
        accountNumberLast4: null,
        paystackRecipientCode: null,
      },
    });
  });
}
```

- [ ] **Step 4: Implement — `addMember` and `removeMember`**

```ts
async addMember(
  operatorId: string,
  data: { userId: string; role: OperatorMemberRole },
  actingUser: { userId: string; role: string },
) {
  return this.prisma.$transaction(async (tx) => {
    await this.operatorMembershipService.lockActiveMembership(tx, actingUser, operatorId);

    // Lock the TARGET user too — `lockActiveMembership` only locked the
    // acting user and the operator. Without this, `deleteUser` on
    // `data.userId` could run its own "no active OWNER memberships"
    // check and commit in the gap between here and the `create` below,
    // and this transaction would then insert a fresh membership for an
    // identity that's already anonymized. Same lock-then-read shape as
    // everywhere else: the row must be locked before any conclusion is
    // drawn from it.
    const targetStillActive = await tx.user.updateMany({
      where: { id: data.userId, deletedAt: null },
      data: { updatedAt: new Date() },
    });
    if (targetStillActive.count === 0) {
      throw new BadRequestException('Cannot add this member: account not found or has been deleted.');
    }

    const existing = await tx.operatorMember.findUnique({
      where: { userId_operatorId: { userId: data.userId, operatorId } },
    });
    if (existing) throw new Error('User is already a member');

    return tx.operatorMember.create({
      data: { userId: data.userId, operatorId, role: data.role },
      include: {
        user: { select: { id: true, name: true, email: true, phoneNumber: true } },
      },
    });
  });
}

async removeMember(
  operatorId: string,
  memberId: string,
  actingUser: { userId: string; role: string },
) {
  return this.prisma.$transaction(async (tx) => {
    await this.operatorMembershipService.lockActiveMembership(tx, actingUser, operatorId);

    const member = await tx.operatorMember.findUnique({ where: { id: memberId } });
    if (!member || member.operatorId !== operatorId)
      throw new Error('Member not found');
    if (member.role === OperatorMemberRole.OWNER)
      throw new Error('Cannot remove the owner');
    return tx.operatorMember.delete({ where: { id: memberId } });
  });
}
```

- [ ] **Step 5: Implement — `updateProfile` and `saveBankDetails`**

Read the current full bodies of `updateProfile` (lines 704-790) and `saveBankDetails` (lines 654-686) first — `sed -n '654,790p' src/operator/operator.service.ts` — then wrap each exactly as above: add `actingUser: { userId: string; role: string }` as the final parameter, open `this.prisma.$transaction(async (tx) => { await this.operatorMembershipService.lockActiveMembership(tx, actingUser, id); <existing body, with every `this.prisma.X` inside it changed to `tx.X`> })`. For `saveBankDetails` specifically, the Paystack API call (`this.paystackService....`) stays as a plain `await` inside the transaction callback, unchanged — only the Prisma calls before and after it switch from `this.prisma` to `tx`.

- [ ] **Step 6: Update the controller call sites**

In `src/operator/operator.controller.ts`, for each of the five methods, the existing `assertCanManageOperator` call STAYS unchanged; only the mutation call gains `req.user` (the whole object, not just its id — `lockActiveMembership` needs `role` for the admin bypass) as its final argument:
```ts
// updateProfile
await this.operatorService.assertCanManageOperator(req.user, id);
const operator = await this.operatorService.updateProfile(id, dto, req.user);
```
```ts
// saveBankDetails
await this.operatorService.assertCanManageOperator(req.user, id);
// ...existing bankCode/bankName/accountNumber validation, unchanged...
const operator = await this.operatorService.saveBankDetails(id, dto, req.user);
```
```ts
// clearBankDetails
await this.operatorService.assertCanManageOperator(req.user, id);
const operator = await this.operatorService.clearBankDetails(id, req.user);
```
```ts
// addMember
await this.operatorService.assertCanManageOperator(req.user, id);
const member = await this.operatorService.addMember(
  id,
  { userId: body.userId, role: body.role ?? OperatorMemberRole.STAFF },
  req.user,
);
```
```ts
// removeMember
await this.operatorService.assertCanManageOperator(req.user, id);
await this.operatorService.removeMember(id, memberId, req.user);
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx jest src/operator/operator.service.spec.ts`
Expected: PASS, including every pre-existing test for these five methods (their `this.prisma.X` mock assertions need updating to `prisma.X` accessed via the transaction mock — since `prisma.$transaction.mockImplementation((cb) => cb(prisma))` makes `tx === prisma` in tests, existing assertions on `prisma.operator.update` etc. keep working unchanged once that transaction mock is added).

- [ ] **Step 8: Full suite, lint, commit**

```bash
npx jest --silent
npx eslint "{src,apps,libs,test}/**/*.ts" --max-warnings 531
git add src/operator/operator.service.ts src/operator/operator.service.spec.ts src/operator/operator.controller.ts
git commit -m "Lock updateProfile/bank-details/member mutations against concurrent operator deletion"
```

---

### Task 9: `respondToOffer` locks its offer-claim against operator deletion

**Files:**
- Modify: `src/rescue-request/dispatch.service.ts` (`respondToOffer`, `processQuoteOrDecline` — around lines 1257-1278 and 168-251)
- Test: `src/rescue-request/dispatch.service.spec.ts`

**Interfaces:**
- Consumes: `OperatorMembershipService.lockActiveMembership` (Task 5), already injected in Task 6.

**Corrected scope:** `processQuoteOrDecline` is deliberately the public,
channel-agnostic operation used by both dashboard and WhatsApp. Do not make it
transaction-client-only and do not protect only `respondToOffer`; that would
leave the WhatsApp operator channel able to claim an offer for a deleted
Operator. Extract only the conditional write into private
`claimOfferInTx(tx, offer, quotedPriceKobo)`. Keep
`processQuoteOrDecline(offer, quotedPriceKobo)` public: it opens a short
transaction, locks `offer.operatorId` directly with
`tx.operator.updateMany({ where: { id, deletedAt: null }, ... })`, then calls
`claimOfferInTx`. `respondToOffer` performs its dashboard-specific membership
authorization and uses `lockActiveMembership(...)` before calling the same
helper. The post-claim `beginQuoteCollectionIfFirst` and
`maybeResolveBatchEarly` calls remain after commit for both channels.

- [ ] **Step 1: Write the failing test**

In `src/rescue-request/dispatch.service.spec.ts`, find the `respondToOffer`/`processQuoteOrDecline` tests and add:
```ts
it('rejects the response when the operator has been deleted, before claiming the offer', async () => {
  prisma.operatorMember.findMany.mockResolvedValue([{ operatorId: 'op-1' }]);
  prisma.dispatchOffer.findUnique.mockResolvedValue({
    id: 'offer-1', operatorId: 'op-1', status: 'PENDING', rescueRequestId: 'req-1', batchId: 'batch-1', expiresAt: new Date(Date.now() + 60000),
  });
  prisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(prisma));
  operatorMembershipService.lockActiveMembership.mockRejectedValue(
    new ForbiddenException('This operator has been deleted.'),
  );

  await expect(
    service.respondToOffer('user-1', 'offer-1', 500000),
  ).rejects.toThrow('This operator has been deleted.');

  expect(operatorMembershipService.lockActiveMembership).toHaveBeenCalledWith(
    prisma, { userId: 'user-1', role: 'OPERATOR' }, 'op-1',
  );
  expect(prisma.dispatchOffer.updateMany).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/rescue-request/dispatch.service.spec.ts`
Expected: FAIL — no lock exists in this path yet.

- [ ] **Step 3: Implement**

Add `UserRole` to this file's `@prisma/client` import (it currently imports `Prisma, RescueRequestStatus, VehicleType` — extend that list).

Read the full current bodies of `respondToOffer` and `processQuoteOrDecline`
first. Preserve `processQuoteOrDecline`'s public signature for the WhatsApp
caller. Implement one private `claimOfferInTx` and two locking wrappers:

- WhatsApp/channel-agnostic `processQuoteOrDecline`: lock the offer's Operator
  row, then call `claimOfferInTx`.
- Dashboard `respondToOffer`: call `lockActiveMembership`, then call
  `claimOfferInTx` in the same transaction.

The following dashboard sketch illustrates only that wrapper; it does not
replace the public WhatsApp wrapper described above:

```ts
async respondToOffer(userId: string, offerId: string, priceKobo?: number) {
  const memberships = await this.prisma.operatorMember.findMany({
    where: { userId },
    select: { operatorId: true },
  });
  const operatorIds = memberships.map((m) => m.operatorId);

  const offer = await this.prisma.dispatchOffer.findUnique({
    where: { id: offerId },
  });

  if (!offer || !operatorIds.includes(offer.operatorId)) {
    throw new NotFoundException('Offer not found');
  }
  if (offer.status !== 'PENDING') {
    throw new BadRequestException('This offer is no longer available.');
  }

  const claimResult = await this.prisma.$transaction(async (tx) => {
    // This endpoint's controller route is @Roles(UserRole.OPERATOR) —
    // no ADMIN/SUPER_ADMIN ever reaches respondToOffer, so the admin
    // bypass in lockActiveMembership never applies here; the role is
    // still passed through for signature consistency with every other
    // lockActiveMembership call site.
    await this.operatorMembershipService.lockActiveMembership(
      tx,
      { userId, role: UserRole.OPERATOR },
      offer.operatorId,
    );
    return this.claimOfferInTx(tx, offer, priceKobo);
  });

  if (claimResult.claimed && !claimResult.isDecline) {
    await this.beginQuoteCollectionIfFirst(offer.rescueRequestId);
  }
  if (claimResult.claimed) {
    await this.maybeResolveBatchEarly(offer.rescueRequestId, offer.batchId);
  }

  return { data: { quoted: claimResult.quoted, message: claimResult.message } };
}

/** The claim itself — everything that must be atomic with the membership lock. */
private async claimOfferInTx(
  tx: Prisma.TransactionClient,
  offer: { id: string; rescueRequestId: string; expiresAt: Date; batchId: string },
  quotedPriceKobo: number | undefined,
): Promise<{ claimed: boolean; isDecline: boolean; quoted: boolean; message: string }> {
  const isDecline = quotedPriceKobo === undefined;

  if (!isDecline && (await this.isBiddingClosed(offer.rescueRequestId))) {
    await tx.dispatchOffer.updateMany({
      where: { id: offer.id, status: 'PENDING' },
      data: { status: 'NOT_SELECTED', quotedPrice: quotedPriceKobo, respondedAt: new Date() },
    });
    return { claimed: false, isDecline, quoted: false, message: 'Bidding has closed for this request.' };
  }

  const claimed = await tx.dispatchOffer.updateMany({
    where: { id: offer.id, status: 'PENDING', expiresAt: { gt: new Date() } },
    data: {
      status: isDecline ? 'DECLINED' : 'QUOTED',
      quotedPrice: quotedPriceKobo,
      respondedAt: new Date(),
    },
  });
  if (claimed.count === 0) {
    return { claimed: false, isDecline, quoted: false, message: 'Sorry, that offer has expired.' };
  }

  if (isDecline) {
    return { claimed: true, isDecline, quoted: false, message: 'Offer declined.' };
  }

  return { claimed: true, isDecline, quoted: true, message: 'Quote submitted.' };
}
```

**Before finalizing this step:** copy the exact current messages into
`claimOfferInTx`; do not change user-facing copy. Add tests for both entry
points: dashboard deletion failure through `lockActiveMembership`, and
WhatsApp/public-core deletion failure through the direct Operator lock. In
both cases assert `dispatchOffer.updateMany` is not called.

Add `OperatorMembershipService` to this file's constructor if Task 6 didn't already add it (it should have).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/rescue-request/dispatch.service.spec.ts`
Expected: PASS, including every pre-existing `respondToOffer`/`processQuoteOrDecline` test — update their mocks to account for the new `prisma.$transaction` wrapper the same way Task 8 did (`prisma.$transaction.mockImplementation((cb) => cb(prisma))` makes existing `prisma.dispatchOffer.updateMany` assertions keep working unchanged).

- [ ] **Step 5: Full suite, lint, commit**

```bash
npx jest --silent
npx eslint "{src,apps,libs,test}/**/*.ts" --max-warnings 531
git add src/rescue-request/dispatch.service.ts src/rescue-request/dispatch.service.spec.ts
git commit -m "Lock the dispatch-offer claim against concurrent operator deletion"
```

---

### Task 9b: Lock operator assignment against concurrent deletion

**Files:**
- Modify: `src/rescue-request/rescue-request-admin.service.ts` (`assignOperator`, around lines 100-280 — the write is at line 257-277)
- Modify: `src/rescue-request/whatsapp-customer-flow.service.ts` (`handleQuoteSelected`, around lines 900-970 — the write is at line 954-962)
- Test: `src/rescue-request/rescue-request-admin.service.spec.ts`
- Test: `src/rescue-request/whatsapp-customer-flow.service.spec.ts`

**Interfaces:**
- Consumes: `Operator.deletedAt` (Task 1).

**Replacement for the earlier step-by-step draft below:** the transaction
boundary is the assignment unit, not merely the final
`assignedOperatorId` write. Do not call Paystack before assignment exists,
and do not hold an Operator row lock across Paystack HTTP.

For `RescueRequestAdminService.assignOperator`, after the existing cheap
validation/config reads, run one short transaction that:

1. locks the request customer User, then the selected Operator, both with
   `{ id, deletedAt: null }` (the fixed global parent-lock order);
2. conditionally claims the RescueRequest so a concurrent assignment cannot
   also proceed;
3. creates the `SELECTED_PENDING_PAYMENT` offer;
4. calls `PaymentLedgerService.create(..., tx)` to create the PENDING deposit
   row against the same transaction client (its customer lock is now a
   same-transaction re-lock, not a reversed Operator→User acquisition);
5. persists `assignedOperatorId`, `WAITING_FOR_DEPOSIT`, pricing, and the
   deposit deadline; then commits.

Only after commit may it claim the Payment for submission and call Paystack.
Persist `checkoutUrl`/`depositPaymentUrl` afterward. A rejected or ambiguous
provider response is represented on the already-durable Payment row; it must
not delete the selected offer or erase the assignment, because those now form
one committed business decision and recovery needs that state.

For `WhatsAppCustomerFlowService.handleQuoteSelected`, use the same atomic
shape. The transaction must contain the customer User lock, Operator lock,
`DISPATCHING` claim,
assignment/pricing/deadline update, selected/non-selected/timed-out offer
updates, and `PaymentLedgerService.create(..., tx)`. If either the request
claim or Operator lock fails, the whole transaction rolls back and no
dead-end `WAITING_FOR_DEPOSIT` request exists. Commit before notifications,
session changes, `claimForSubmission`, or Paystack. The existing standalone
claim and assignment statements are removed, not wrapped separately.

Tests must assert ordering and rollback boundaries, including: no Paystack
call before the transaction resolves; the transaction contains offer,
assignment, and Payment creation; lock/claim failure leaves request and offer
state unchanged; and provider failure after commit does not undo assignment.

- [ ] **Step 1: Add failing admin-assignment transaction tests** covering the
  Operator lock, conditional request claim, selected offer, PENDING Payment,
  assignment/pricing/deadline, and no Paystack call before commit.
- [ ] **Step 2: Implement the admin short transaction**, passing `tx` to
  `PaymentLedgerService.create`; move claim/submission/Paystack and URL writes
  after commit.
- [ ] **Step 3: Add failing WhatsApp-selection transaction tests** covering
  rollback on request-claim or Operator-lock failure and all offer-state
  changes plus Payment creation in the same transaction.
- [ ] **Step 4: Implement the WhatsApp short transaction**, then keep session
  changes, notifications, submission claim, and Paystack after commit.
- [ ] **Step 5: Run focused tests:**
  `npx jest src/rescue-request/rescue-request-admin.service.spec.ts src/rescue-request/whatsapp-customer-flow.service.spec.ts`.
- [ ] **Step 6: Run full unit suite, type-check, and lint** before committing.


---

### Task 9c: Lock dispute opening/reopening against account deletion

**Files:**
- Modify: `src/rescue-request/dispute.service.ts` (`raiseDispute`)
- Test: `src/rescue-request/dispute.service.spec.ts`
- Test: `test/integration/account-deletion.int-spec.ts`

`deleteUser` and `deleteOperator` both reject an unresolved dispute, so the
write that opens or reopens one must participate in their parent-row lock
protocol. The current `raiseDispute` performs an unlocked read followed by a
plain update and can therefore open a dispute immediately after either
deletion guard read passed.

Restructure `raiseDispute` so its database decision is one short transaction:

1. read the request's `customerId`, `assignedOperatorId`, and dispute state;
2. lock the customer User first with `{ id: customerId, deletedAt: null }`;
3. if assigned, lock the Operator second with
   `{ id: assignedOperatorId, deletedAt: null }`;
4. after both locks, re-read or conditionally update the request and set/reopen
   `disputed`, `disputeRaisedAt`, `disputeResolvedAt`, and `IN_DISPUTE`;
5. commit, returning enough data to preserve the existing "already open",
   first-open, and reopen messages.

The lock order is fixed as User then Operator everywhere to avoid deadlocks.
All WhatsApp/session/staff/operator notifications remain after commit and
best-effort exactly as today. A deleted customer or assigned Operator aborts
before the dispute write; no notification is sent for a dispute that did not
commit.

Add unit tests for both lock failures, User-before-Operator ordering, reopen
inside the transaction, and notifications occurring only after commit. Add
real-Postgres races for `deleteUser ↔ raiseDispute` and
`deleteOperator ↔ raiseDispute`: whichever obtains the shared parent lock
first determines whether deletion sees the dispute or dispute opening sees a
deleted party.

---

### Task 10: `AccountDeletionModule` and `AccountDeletionService.deleteUser`

**Files:**
- Create: `src/account-deletion/account-deletion.module.ts`
- Create: `src/account-deletion/account-deletion.service.ts`
- Create: `src/account-deletion/dto/` (none needed yet — both endpoints take only a path param; created in Task 12 if a response DTO becomes useful)
- Test: `src/account-deletion/account-deletion.service.spec.ts`
- Test: `test/integration/account-deletion.int-spec.ts` (the audit-rollback test needs a real database)

**Interfaces:**
- Consumes: `S3Service.deleteObject` (Task 2), `User.deletedAt`/`PendingMediaDeletion` (Task 1).
- Produces: `AccountDeletionService.deleteUser(id: string, actorId: string): Promise<void>` — throws `NotFoundException`/`BadRequestException` on guard failure, resolves on success. Consumed by Task 12 (`AccountDeletionController`).
- The guard also blocks deleting the sole `OWNER` of a still-active `Operator` (via `User.operatorMemberships`) — mirrors `removeMember()`'s existing "Cannot remove the owner" rule (Task 8) so `deleteUser` can't silently orphan a business the same way that method already refuses to.
- **Follows the lock → read → write shape from this plan's Architecture note.** The row-lock `updateMany` carries only `id`, `deletedAt`, and `role` — plain columns on `User` itself. The active-request, non-terminal-payment, and sole-OWNER checks are separate `findMany` reads issued only after that lock succeeds, not baked into the lock's own `WHERE`. There is no separate `explainUserDeleteFailure` method — each guard read throws its own precise message directly, which is simpler than deriving one after the fact from a single complex query.

- [ ] **Step 1: Write the failing unit tests**

Create `src/account-deletion/account-deletion.service.spec.ts`:
```ts
import { Test, TestingModule } from '@nestjs/testing';
import { AccountDeletionService } from './account-deletion.service';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../integrations/s3/s3.service';

describe('AccountDeletionService.deleteUser', () => {
  let service: AccountDeletionService;
  let tx: {
    user: { updateMany: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
    rescueRequest: { findMany: jest.Mock; updateMany: jest.Mock };
    operatorMember: { findMany: jest.Mock };
    requestMedia: { findMany: jest.Mock; deleteMany: jest.Mock };
    pendingMediaDeletion: { createMany: jest.Mock };
    auditLog: { create: jest.Mock };
  };
  let prisma: { $transaction: jest.Mock; pendingMediaDeletion: { delete: jest.Mock } };
  let s3Service: { deleteObject: jest.Mock };

  beforeEach(async () => {
    tx = {
      user: { updateMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
      rescueRequest: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() },
      operatorMember: { findMany: jest.fn().mockResolvedValue([]) },
      requestMedia: { findMany: jest.fn().mockResolvedValue([]), deleteMany: jest.fn() },
      pendingMediaDeletion: { createMany: jest.fn() },
      auditLog: { create: jest.fn() },
    };
    prisma = {
      $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb(tx)),
      pendingMediaDeletion: { delete: jest.fn() },
    };
    s3Service = { deleteObject: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountDeletionService,
        { provide: PrismaService, useValue: prisma },
        { provide: S3Service, useValue: s3Service },
      ],
    }).compile();
    service = module.get(AccountDeletionService);
  });

  it('locks with a plain WHERE — id, deletedAt, and role only, no relational conditions', async () => {
    // This is the regression that matters most for this method: an
    // earlier draft baked `rescueRequests`/`operatorMemberships`
    // conditions directly into this same updateMany's WHERE. Postgres's
    // read-committed re-check only reliably re-evaluates conditions on
    // the row actually being locked when it waits out a concurrent
    // writer — it does not safely re-evaluate relational sub-conditions
    // against fresh data for other tables. Those checks must be a
    // separate read, issued only after this lock succeeds.
    tx.user.updateMany.mockResolvedValue({ count: 1 });

    await service.deleteUser('user-1', 'admin-1');

    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'user-1', deletedAt: null, role: { in: ['CUSTOMER', 'OPERATOR'] } },
      data: { updatedAt: expect.any(Date) },
    });
  });

  it('rejects when the row does not exist', async () => {
    tx.user.updateMany.mockResolvedValue({ count: 0 });
    tx.user.findUnique.mockResolvedValue(null);

    await expect(service.deleteUser('user-1', 'admin-1')).rejects.toThrow('User not found');
    expect(tx.rescueRequest.findMany).not.toHaveBeenCalled();
  });

  it('rejects an already-deleted account', async () => {
    tx.user.updateMany.mockResolvedValue({ count: 0 });
    tx.user.findUnique.mockResolvedValue({ role: 'CUSTOMER', deletedAt: new Date() });

    await expect(service.deleteUser('user-1', 'admin-1')).rejects.toThrow(
      'This account has already been deleted',
    );
  });

  it('rejects a non-customer, non-operator role outright', async () => {
    tx.user.updateMany.mockResolvedValue({ count: 0 });
    tx.user.findUnique.mockResolvedValue({ role: 'ADMIN', deletedAt: null });

    await expect(service.deleteUser('user-1', 'admin-1')).rejects.toThrow(
      'Only customer and operator accounts can be deleted through this endpoint',
    );
  });

  it('once the lock succeeds, blocks on active/disputed/payment-pending requests read fresh afterward', async () => {
    tx.user.updateMany.mockResolvedValue({ count: 1 });
    tx.rescueRequest.findMany.mockResolvedValue([{ id: 'req-1' }, { id: 'req-2' }]);

    await expect(service.deleteUser('user-1', 'admin-1')).rejects.toThrow(
      'Cannot delete: 2 request(s) still active, with an unresolved dispute, or with a payment still processing',
    );
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('once the lock succeeds, blocks deletion of the sole OWNER of a still-active operator, read fresh afterward', async () => {
    tx.user.updateMany.mockResolvedValue({ count: 1 });
    tx.operatorMember.findMany.mockResolvedValue([{ operatorId: 'op-1' }]);

    await expect(service.deleteUser('user-1', 'admin-1')).rejects.toThrow(
      'Cannot delete: this user owns 1 active operator business(es) — transfer ownership or delete the business first',
    );
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('anonymizes, scrubs requests, deletes media, and writes the audit entry once both guard reads pass', async () => {
    tx.user.updateMany.mockResolvedValue({ count: 1 });
    tx.requestMedia.findMany.mockResolvedValue([{ id: 'media-1', s3Key: 'key-1' }]);

    const result = await service.deleteUser('user-1', 'admin-1');

    expect(tx.rescueRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          customerId: 'user-1',
          OR: expect.arrayContaining([
            expect.objectContaining({
              payments: expect.objectContaining({
                some: expect.objectContaining({
                  // PAYOUT deliberately absent — a stuck operator payout
                  // must never block an unrelated customer's own deletion.
                  type: { in: ['DEPOSIT', 'BALANCE', 'REFUND'] },
                }),
              }),
            }),
          ]),
        }),
        select: { id: true },
      }),
    );
    expect(tx.operatorMember.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', role: 'OWNER', operator: { deletedAt: null } },
      select: { operatorId: true },
    });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: expect.objectContaining({
        name: 'Deleted User', email: null, phoneNumber: null, passwordHash: null,
        paystackCustomerCode: null, paystackCustomerEmail: null, deletedAt: expect.any(Date),
      }),
    });
    expect(tx.requestMedia.findMany).toHaveBeenCalledWith({
      where: {
        rescueRequest: { customerId: 'user-1' },
        uploadedByRole: 'CUSTOMER',
      },
      select: { id: true, s3Key: true },
    });
    expect(tx.pendingMediaDeletion.createMany).toHaveBeenCalledWith({
      data: [{ s3Key: 'key-1' }],
      skipDuplicates: true,
    });
    expect(tx.requestMedia.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['media-1'] } } });
    expect(tx.rescueRequest.updateMany).toHaveBeenCalledWith({
      where: { customerId: 'user-1' },
      data: { latitude: null, longitude: null, destination: null, customerDisputeStatement: null, operatorDisputeStatement: null },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: { category: 'account_deleted', message: 'User user-1 deleted', actorId: 'admin-1', details: { targetType: 'User', targetId: 'user-1' } },
    });
    expect(result).toBeUndefined();
  });

  it('only queries uploadedByRole CUSTOMER media — never touches the operator\'s own evidence on a shared request', async () => {
    // This is the regression that matters most for this query: before
    // RequestMedia had context/uploadedByRole, this filter was implicit
    // (all media was customer-uploaded). The mock below simulates the
    // query itself already being scoped correctly — if the real
    // implementation dropped the `uploadedByRole` clause, this test's
    // own assertion above (on the exact `where` shape) would catch it,
    // but this test additionally proves the *count* of what's queued for
    // deletion reflects only the customer's own rows, not the operator's,
    // by asserting the mock's call args carry the filter and nothing else
    // leaks through — see the previous test's `findMany` assertion for
    // the authoritative shape check; this test exists so a reviewer
    // reading just the test list sees the regression named explicitly.
    tx.user.updateMany.mockResolvedValue({ count: 1 });
    tx.requestMedia.findMany.mockResolvedValue([
      { id: 'media-customer-1', s3Key: 'key-customer-1' },
    ]);

    await service.deleteUser('user-1', 'admin-1');

    const [callArgs] = tx.requestMedia.findMany.mock.calls[0] as [
      { where: { uploadedByRole: string } },
    ];
    expect(callArgs.where.uploadedByRole).toBe('CUSTOMER');
  });

  it('deletes S3 objects after the transaction commits, and clears the outbox row on success', async () => {
    tx.user.updateMany.mockResolvedValue({ count: 1 });
    tx.requestMedia.findMany.mockResolvedValue([{ id: 'media-1', s3Key: 'key-1' }]);
    s3Service.deleteObject.mockResolvedValue(undefined);

    await service.deleteUser('user-1', 'admin-1');

    expect(s3Service.deleteObject).toHaveBeenCalledWith('key-1');
    expect(prisma.pendingMediaDeletion.delete).toHaveBeenCalledWith({ where: { s3Key: 'key-1' } });
  });

  it('leaves the outbox row in place when an S3 delete fails, and does not throw', async () => {
    tx.user.updateMany.mockResolvedValue({ count: 1 });
    tx.requestMedia.findMany.mockResolvedValue([{ id: 'media-1', s3Key: 'key-1' }]);
    s3Service.deleteObject.mockRejectedValue(new Error('S3 down'));

    await expect(service.deleteUser('user-1', 'admin-1')).resolves.toBeUndefined();

    expect(prisma.pendingMediaDeletion.delete).not.toHaveBeenCalled();
  });

  it('skips the S3 loop entirely when there is no media', async () => {
    tx.user.updateMany.mockResolvedValue({ count: 1 });
    tx.requestMedia.findMany.mockResolvedValue([]);

    await service.deleteUser('user-1', 'admin-1');

    expect(tx.pendingMediaDeletion.createMany).not.toHaveBeenCalled();
    expect(s3Service.deleteObject).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/account-deletion/account-deletion.service.spec.ts`
Expected: FAIL — the module/file doesn't exist yet.

- [ ] **Step 3: Implement**

Create `src/account-deletion/account-deletion.service.ts`:
```ts
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { PaymentStatus, PaymentType, OperatorMemberRole, RescueRequestStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../integrations/s3/s3.service';

// Scoped to customer-side payment types only. An operator's PAYOUT can sit
// PENDING/SUBMITTED/BLOCKED on the same (otherwise terminal) request without
// that having anything to do with the customer's own money — that's
// deleteOperator's guard to enforce, on the Operator's own `payments`
// relation, not this one's. Including PAYOUT here would let a stuck payout
// for an unrelated operator block a customer's own, unrelated deletion.
const ACTIVE_OR_PENDING_REQUEST_FILTER = {
  OR: [
    { status: { notIn: [RescueRequestStatus.COMPLETED, RescueRequestStatus.CANCELLED] } },
    { disputed: true, disputeResolvedAt: null },
    {
      payments: {
        some: {
          type: { in: [PaymentType.DEPOSIT, PaymentType.BALANCE, PaymentType.REFUND] },
          status: { in: [PaymentStatus.PENDING, PaymentStatus.SUBMITTED, PaymentStatus.BLOCKED] },
        },
      },
    },
  ],
};

@Injectable()
export class AccountDeletionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly s3Service: S3Service,
  ) {}

  async deleteUser(id: string, actorId: string): Promise<void> {
    const s3KeysToDelete = await this.prisma.$transaction(async (tx) => {
      // Step 1: lock the row. Only plain columns on User itself in this
      // WHERE — see the Architecture note at the top of this plan for
      // why relational conditions don't belong here.
      const locked = await tx.user.updateMany({
        where: { id, deletedAt: null, role: { in: [UserRole.CUSTOMER, UserRole.OPERATOR] } },
        data: { updatedAt: new Date() },
      });
      if (locked.count === 0) {
        const user = await tx.user.findUnique({ where: { id }, select: { role: true, deletedAt: true } });
        if (!user) throw new NotFoundException('User not found');
        if (user.deletedAt) throw new BadRequestException('This account has already been deleted');
        throw new BadRequestException('Only customer and operator accounts can be deleted through this endpoint');
      }

      // Step 2: the lock is held — any concurrent writer that could
      // change these answers (PaymentLedgerService.create, the WhatsApp
      // creation lock, addMember) locks this same User row before its
      // own write, so it's either already committed or blocked behind
      // us. These reads are safe now in a way they would not have been
      // as part of Step 1's WHERE.
      const blockingRequests = await tx.rescueRequest.findMany({
        where: { customerId: id, ...ACTIVE_OR_PENDING_REQUEST_FILTER },
        select: { id: true },
      });
      if (blockingRequests.length > 0) {
        throw new BadRequestException(
          `Cannot delete: ${blockingRequests.length} request(s) still active, with an unresolved dispute, or with a payment still processing`,
        );
      }

      // Mirrors removeMember()'s existing "Cannot remove the owner" rule
      // (Task 8) — anonymizing the sole OWNER of a still-active business
      // orphans it. Only blocks while the OWNED operator is itself still
      // active — once that operator is deleted (or ownership has been
      // transferred away), this finds nothing.
      const ownedOperators = await tx.operatorMember.findMany({
        where: { userId: id, role: OperatorMemberRole.OWNER, operator: { deletedAt: null } },
        select: { operatorId: true },
      });
      if (ownedOperators.length > 0) {
        throw new BadRequestException(
          `Cannot delete: this user owns ${ownedOperators.length} active operator business(es) — transfer ownership or delete the business first`,
        );
      }

      // Step 3: the irreversible write, still inside the same
      // transaction as the lock — the row lock never released between
      // steps 1-3, so nothing could have changed underneath the checks
      // above by the time we get here.
      await tx.user.update({
        where: { id },
        data: {
          name: 'Deleted User',
          email: null,
          phoneNumber: null,
          passwordHash: null,
          paystackCustomerCode: null,
          paystackCustomerEmail: null,
          deletedAt: new Date(),
        },
      });

      // uploadedByRole: CUSTOMER — RequestMedia can now also hold
      // COMPLETION/DISPUTE rows the OPERATOR uploaded on a shared
      // request; those aren't this customer's identity to scrub.
      const media = await tx.requestMedia.findMany({
        where: {
          rescueRequest: { customerId: id },
          uploadedByRole: UserRole.CUSTOMER,
        },
        select: { id: true, s3Key: true },
      });
      if (media.length > 0) {
        await tx.pendingMediaDeletion.createMany({
          data: media.map((m) => ({ s3Key: m.s3Key })),
          skipDuplicates: true,
        });
      }
      await tx.requestMedia.deleteMany({ where: { id: { in: media.map((m) => m.id) } } });
      await tx.rescueRequest.updateMany({
        where: { customerId: id },
        data: {
          latitude: null,
          longitude: null,
          destination: null,
          customerDisputeStatement: null,
          operatorDisputeStatement: null,
        },
      });

      await tx.auditLog.create({
        data: {
          category: 'account_deleted',
          message: `User ${id} deleted`,
          actorId,
          details: { targetType: 'User', targetId: id },
        },
      });

      return media.map((m) => m.s3Key);
    });

    for (const key of s3KeysToDelete) {
      try {
        await this.s3Service.deleteObject(key);
        await this.prisma.pendingMediaDeletion.delete({ where: { s3Key: key } });
      } catch (err) {
        console.error(`Failed to delete media object ${key} after deleting user ${id}:`, err);
        Sentry.captureException(err, { extra: { s3Key: key, userId: id } });
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/account-deletion/account-deletion.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Create the module**

Create `src/account-deletion/account-deletion.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { AccountDeletionService } from './account-deletion.service';
import { PrismaModule } from '../prisma/prisma.module';
import { S3Module } from '../integrations/s3/s3.module';

@Module({
  imports: [PrismaModule, S3Module],
  providers: [AccountDeletionService],
  exports: [AccountDeletionService],
})
export class AccountDeletionModule {}
```

- [ ] **Step 6: Write the integration test for the audit-rollback guarantee**

Create `test/integration/account-deletion.int-spec.ts` (follow the exact setup pattern of `test/integration/audit-log.int-spec.ts` — real `PrismaService`, `truncateAll` in `beforeEach`):
```ts
import { AccountDeletionService } from '../../src/account-deletion/account-deletion.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { S3Service } from '../../src/integrations/s3/s3.service';
import { truncateAll } from './factories';

describe('AccountDeletionService.deleteUser (integration)', () => {
  let prisma: PrismaService;
  let service: AccountDeletionService;

  beforeAll(() => { prisma = new PrismaService(); });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(async () => {
    await truncateAll(prisma);
    service = new AccountDeletionService(prisma, { deleteObject: jest.fn() } as never);
  });

  it('rolls back the anonymization if the audit write fails', async () => {
    const user = await prisma.user.create({
      data: { phoneNumber: '+2348011111111', role: 'CUSTOMER', name: 'Real Name' },
    });

    // `jest.spyOn(prisma.auditLog, 'create')` does NOT work here: Prisma's
    // interactive `$transaction(async (tx) => ...)` hands the callback a
    // `tx` client whose model delegates are distinct objects from the
    // top-level `prisma` client's — overriding `prisma.auditLog.create`
    // has no effect on what `tx.auditLog.create` resolves to inside the
    // transaction. A `$extends()` query hook, by contrast, IS honored by
    // clients derived from the extended one, including their interactive-
    // transaction `tx` — this is the reliable way to force a real
    // mid-transaction failure. (Requires a Prisma version with client
    // extensions, ~4.16+ — check `@prisma/client`'s version in
    // package.json; fall back to the older `$use()` middleware API if
    // this project predates that.)
    const failingPrisma = prisma.$extends({
      query: {
        auditLog: {
          create() {
            throw new Error('Simulated audit-log failure');
          },
        },
      },
    });
    const failingService = new AccountDeletionService(
      failingPrisma as unknown as PrismaService,
      { deleteObject: jest.fn() } as never,
    );

    await expect(failingService.deleteUser(user.id, 'admin-1')).rejects.toThrow(
      'Simulated audit-log failure',
    );

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.deletedAt).toBeNull();
    expect(after.name).toBe('Real Name');
  });
});
```

- [ ] **Step 7: Run the integration test**

Before running, extend this same integration file with real PostgreSQL
concurrency tests. Mocked Prisma call-shape tests are not proof of blocking or
post-wait predicate visibility. Use two independent `PrismaService` clients
and explicit promise barriers inside interactive transactions so the test
controls which side acquires the shared parent row lock first; never use
timing-only sleeps.

Cover both commit orders for each pair:

- `deleteUser ↔ RescueRequest creation`: creation-first makes deletion's
  post-lock child read reject; deletion-first makes the creation-side User
  lock reject and no request row is inserted.
- `deleteUser ↔ customer Payment creation`: payment-first makes deletion's
  fresh payment guard reject; deletion-first makes
  `PaymentLedgerService.create(..., tx)` reject and no Payment is inserted.
- `deleteOperator ↔ assignment`: assignment-first makes deletion's fresh
  assigned-request read reject; deletion-first makes the assignment-side
  Operator lock reject and `assignedOperatorId` remains unset.
- `deleteOperator ↔ PAYOUT creation`: payout-first makes deletion's unsettled
  entitlement guard reject; deletion-first makes
  `PaymentLedgerService.create(PAYOUT)` reject and no payout row is inserted.

Each test must assert final rows, not merely which promise rejected. Give the
blocked branch a bounded timeout so a missing lock fails the test rather than
hanging the suite. The audit-rollback test remains alongside these races; it
is not a substitute for them.

Run: `npx jest test/integration/account-deletion.int-spec.ts` (requires a running Postgres matching this repo's integration-test setup — check `test/integration/` for the existing DB connection convention if this fails to connect).
Expected: PASS.

- [ ] **Step 8: Full suite, lint, commit**

```bash
npx jest --silent
npx eslint "{src,apps,libs,test}/**/*.ts" --max-warnings 531
git add src/account-deletion/ test/integration/account-deletion.int-spec.ts
git commit -m "Add AccountDeletionService.deleteUser"
```

---

### Task 11: `AccountDeletionService.deleteOperator`

**Files:**
- Modify: `src/account-deletion/account-deletion.service.ts`
- Test: `src/account-deletion/account-deletion.service.spec.ts`
- Test: `test/integration/account-deletion.int-spec.ts` (operator assignment and payout races)

**Interfaces:**
- Produces: `AccountDeletionService.deleteOperator(id: string, actorId: string): Promise<void>` — consumed by Task 12. Deletion is blocked by an unsettled payout entitlement, not merely an in-flight payout attempt.
- Same lock → read → write shape as `deleteUser` (this plan's Architecture
  note) — the row-lock `updateMany` carries only `id`/`deletedAt` on Operator,
  and active/disputed requests plus unsettled payout entitlements are read
  only after that lock succeeds. Attempt status alone is not the invariant.
- Also scrubs this operator's own uploaded `RequestMedia` (`uploadedByRole:
  OPERATOR`) through the same `PendingMediaDeletion` outbox as `deleteUser`
  — reuses `S3Service.deleteObject` (Task 2), already injected into
  `AccountDeletionService` from Task 10; no new dependency for this task.

- [ ] **Step 1: Write the failing tests**

Add to `src/account-deletion/account-deletion.service.spec.ts`, a parallel
`describe('deleteOperator'` block mirroring `deleteUser`'s tests. It locks
with a plain `{ id, deletedAt: null }` WHERE, rejects missing/already-deleted
rows, active/disputed requests, and any completed assigned request that has
no SUCCEEDED PAYOUT sibling. Explicitly test FAILED and REVERSED attempts:
both remain unsettled and must block deletion because the payment model allows
a fresh retry row. Also test that an older FAILED/REVERSED attempt does not
block once a SUCCEEDED sibling exists. Success anonymizes the operator and
scrubs both dispute statements.

Also mirror `deleteUser`'s media tests, mocking the same `tx.requestMedia`/
`tx.pendingMediaDeletion`/`s3Service` shape: `deleteOperator` deletes
`RequestMedia` rows and their S3 objects; the query is scoped to
`rescueRequest: { assignedOperatorId: id }` AND `uploadedByRole: 'OPERATOR'`
— assert the exact `where` shape, and add the same "only queries
uploadedByRole OPERATOR — never touches the customer's own evidence"
regression test `deleteUser` has for its own `CUSTOMER` filter. Also
mirror the S3-commit, S3-failure, and empty-media-skips-the-loop tests.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/account-deletion/account-deletion.service.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add to `account-deletion.service.ts` alongside `deleteUser`. Do not model the
guard as `Payment.status IN (PENDING, SUBMITTED, BLOCKED)`: those are attempt
states, while the business invariant is whether the completed job's payout
obligation has a successful settlement. After the Operator lock and active/
disputed-request guard, query completed assigned requests with no SUCCEEDED
PAYOUT:
```ts
async deleteOperator(id: string, actorId: string): Promise<void> {
  const s3KeysToDelete = await this.prisma.$transaction(async (tx) => {
    // Step 1: lock the row. Plain columns only.
    const locked = await tx.operator.updateMany({
      where: { id, deletedAt: null },
      data: { updatedAt: new Date() },
    });
    if (locked.count === 0) {
      const operator = await tx.operator.findUnique({ where: { id }, select: { deletedAt: true } });
      if (!operator) throw new NotFoundException('Operator not found');
      throw new BadRequestException('This operator has already been deleted');
    }

    // Step 2: lock held — read child-table conditions fresh. Any
    // concurrent writer that could change these answers
    // (PaymentLedgerService.create for a PAYOUT, whichever code sets
    // RescueRequest.assignedOperatorId) locks this same Operator row
    // first, so it's either already committed or blocked behind us.
    const blockingRequests = await tx.rescueRequest.findMany({
      where: {
        assignedOperatorId: id,
        OR: [
          { status: { notIn: [RescueRequestStatus.COMPLETED, RescueRequestStatus.CANCELLED] } },
          { disputed: true, disputeResolvedAt: null },
        ],
      },
      select: { id: true },
    });
    if (blockingRequests.length > 0) {
      throw new BadRequestException(
        `Cannot delete: ${blockingRequests.length} request(s) still active or disputed`,
      );
    }

    const unsettledPayouts = await tx.rescueRequest.findMany({
      where: {
        assignedOperatorId: id,
        status: RescueRequestStatus.COMPLETED,
        payments: {
          none: {
            type: PaymentType.PAYOUT,
            status: PaymentStatus.SUCCEEDED,
          },
        },
      },
      select: { id: true },
    });
    if (unsettledPayouts.length > 0) {
      throw new BadRequestException(
        `Cannot delete: ${unsettledPayouts.length} completed request(s) still have an unsettled payout`,
      );
    }

    // Step 3: the irreversible write.
    await tx.operator.update({
      where: { id },
      data: {
        businessName: 'Deleted Operator',
        contactName: 'Deleted Operator',
        phoneNumber: null,
        email: null,
        address: '',
        bankName: null,
        accountName: null,
        accountNumberLast4: null,
        paystackRecipientCode: null,
        status: OperatorStatus.SUSPENDED,
        isAvailable: false,
        deletedAt: new Date(),
      },
    });

    await tx.rescueRequest.updateMany({
      where: { assignedOperatorId: id },
      data: { operatorDisputeStatement: null, customerDisputeStatement: null },
    });

    // This operator's own uploaded evidence — completion photos, dispute
    // evidence — not the customer's. Same PendingMediaDeletion outbox
    // pattern as deleteUser: written in the same transaction as the
    // RequestMedia delete, cleared only once S3 confirms.
    const media = await tx.requestMedia.findMany({
      where: {
        rescueRequest: { assignedOperatorId: id },
        uploadedByRole: UserRole.OPERATOR,
      },
      select: { id: true, s3Key: true },
    });
    if (media.length > 0) {
      await tx.pendingMediaDeletion.createMany({
        data: media.map((m) => ({ s3Key: m.s3Key })),
        skipDuplicates: true,
      });
    }
    await tx.requestMedia.deleteMany({
      where: { id: { in: media.map((m) => m.id) } },
    });

    await tx.auditLog.create({
      data: {
        category: 'account_deleted',
        message: `Operator ${id} deleted`,
        actorId,
        details: { targetType: 'Operator', targetId: id },
      },
    });

    return media.map((m) => m.s3Key);
  });

  // Outside the transaction — S3 isn't transactional with Postgres. Same
  // best-effort-then-retry shape as deleteUser.
  for (const key of s3KeysToDelete) {
    try {
      await this.s3Service.deleteObject(key);
      await this.prisma.pendingMediaDeletion.delete({ where: { s3Key: key } });
    } catch (err) {
      console.error(`Failed to delete media object ${key} after deleting operator ${id}:`, err);
      Sentry.captureException(err, { extra: { s3Key: key, operatorId: id } });
      // Deliberately not removed — stays for RetryMediaDeletionCheck (Task 13).
    }
  }
}
```
Add `OperatorStatus` to this file's `@prisma/client` import. `UserRole`,
`S3Service`, and `Sentry` are already imported/injected from Task 10.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/account-deletion/account-deletion.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Full suite, lint, commit**

```bash
npx jest --silent
npx eslint "{src,apps,libs,test}/**/*.ts" --max-warnings 531
git add src/account-deletion/account-deletion.service.ts src/account-deletion/account-deletion.service.spec.ts
git commit -m "Add AccountDeletionService.deleteOperator"
```

---

### Task 12: `AccountDeletionController` — the two DELETE endpoints

**Files:**
- Create: `src/account-deletion/account-deletion.controller.ts`
- Modify: `src/account-deletion/account-deletion.module.ts`
- Test: `src/account-deletion/account-deletion.controller.spec.ts`

**Interfaces:**
- Consumes: `AccountDeletionService.deleteUser`/`deleteOperator` (Tasks 10, 11).
- Produces: `DELETE /users/:id`, `DELETE /operators/:id`, both `SUPER_ADMIN`-only.

- [ ] **Step 1: Write the failing tests**

Create `src/account-deletion/account-deletion.controller.spec.ts` (mirror the constructor/module-setup shape of `src/audit-log/audit-log.controller.spec.ts` — `AuthGuard`/`JwtService`/`RolesGuard` mocking, since this repo's controllers are unit-tested by directly instantiating and calling methods, not via full HTTP):
```ts
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { AccountDeletionController } from './account-deletion.controller';
import { AccountDeletionService } from './account-deletion.service';

const req = { user: { userId: 'admin-1' } } as never;

describe('AccountDeletionController', () => {
  let controller: AccountDeletionController;
  let service: { deleteUser: jest.Mock; deleteOperator: jest.Mock };

  beforeEach(async () => {
    service = { deleteUser: jest.fn(), deleteOperator: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AccountDeletionController],
      providers: [
        { provide: AccountDeletionService, useValue: service },
        { provide: JwtService, useValue: {} },
      ],
    }).compile();
    controller = module.get(AccountDeletionController);
  });

  it('deletes a user with the acting admin as actor', async () => {
    await controller.deleteUser(req, 'user-1');
    expect(service.deleteUser).toHaveBeenCalledWith('user-1', 'admin-1');
  });

  it('deletes an operator with the acting admin as actor', async () => {
    await controller.deleteOperator(req, 'op-1');
    expect(service.deleteOperator).toHaveBeenCalledWith('op-1', 'admin-1');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/account-deletion/account-deletion.controller.spec.ts`
Expected: FAIL — file doesn't exist.

- [ ] **Step 3: Implement**

Create `src/account-deletion/account-deletion.controller.ts`:
```ts
import { Controller, Delete, Param, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AccountDeletionService } from './account-deletion.service';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedRequest } from '../auth/authenticated-request.interface';

@Controller()
@UseGuards(AuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class AccountDeletionController {
  constructor(private readonly accountDeletionService: AccountDeletionService) {}

  @Delete('users/:id')
  async deleteUser(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    await this.accountDeletionService.deleteUser(id, req.user.userId);
    return { message: 'Account deleted' };
  }

  @Delete('operators/:id')
  async deleteOperator(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    await this.accountDeletionService.deleteOperator(id, req.user.userId);
    return { message: 'Operator deleted' };
  }
}
```
`@Controller()` with no argument is required — a class is only registered as a controller by Nest's module scanner if it carries `@Controller()` metadata; being listed in a module's `controllers` array alone does nothing without it. An empty-string prefix (the default for a bare `@Controller()`) mounts the routes at the literal `/users/:id` and `/operators/:id` paths the spec requires, not nested under a feature prefix. Double-check this doesn't collide with any EXISTING `DELETE /users/:id` or `DELETE /operators/:id` route elsewhere in the app — grep for `@Delete(':id')` across `src/` before finalizing; if a collision exists, the two routes need distinguishing (e.g. confirm with the user before choosing an alternative path — do not silently rename the spec's chosen route shape).

Update `src/account-deletion/account-deletion.module.ts` to add `AuthGuard`'s `JwtModule` registration (following the exact pattern already used in `audit-log.module.ts` and `platform-config.module.ts` for a module whose controller needs `AuthGuard`):
```ts
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AccountDeletionService } from './account-deletion.service';
import { AccountDeletionController } from './account-deletion.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { S3Module } from '../integrations/s3/s3.module';
import { AuthGuard } from '../auth/auth.guard';

@Module({
  imports: [
    PrismaModule,
    S3Module,
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'your-secret-key',
      signOptions: { expiresIn: '24h' },
    }),
  ],
  controllers: [AccountDeletionController],
  providers: [AccountDeletionService, AuthGuard],
  exports: [AccountDeletionService],
})
export class AccountDeletionModule {}
```
Register `AccountDeletionModule` in `src/app.module.ts`'s `imports` array (find the existing list of feature modules and add it alongside them).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/account-deletion/account-deletion.controller.spec.ts`
Expected: PASS.

- [ ] **Step 5: Full suite, lint, commit**

```bash
npx jest --silent
npx eslint "{src,apps,libs,test}/**/*.ts" --max-warnings 531
git add src/account-deletion/ src/app.module.ts
git commit -m "Add AccountDeletionController — DELETE /users/:id and /operators/:id"
```

---

### Task 13: The purge-and-retry ticker

**Files:**
- Create: `src/account-deletion/purge-expired-financial-data.check.ts`
- Create: `src/account-deletion/retry-media-deletion.check.ts`
- Create: `src/account-deletion/account-deletion-ticker.service.ts`
- Modify: `src/account-deletion/account-deletion.module.ts`
- Test: `src/account-deletion/purge-expired-financial-data.check.spec.ts`
- Test: `src/account-deletion/retry-media-deletion.check.spec.ts`
- Test: `src/account-deletion/account-deletion-ticker.service.spec.ts`

**Interfaces:**
- Consumes: `S3Service.deleteObject` (Task 2), `AuditLogService.record` (already exists).

- [ ] **Step 1: Write the failing tests for `PurgeExpiredFinancialDataCheck`**

Create `src/account-deletion/purge-expired-financial-data.check.spec.ts`:
```ts
import { Test, TestingModule } from '@nestjs/testing';
import { PurgeExpiredFinancialDataCheck } from './purge-expired-financial-data.check';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { createAuditLogServiceMock } from '../audit-log/testing/audit-log.mock';

describe('PurgeExpiredFinancialDataCheck', () => {
  let check: PurgeExpiredFinancialDataCheck;
  let prisma: { payment: { deleteMany: jest.Mock } };
  let auditLogService: ReturnType<typeof createAuditLogServiceMock>;

  beforeEach(async () => {
    prisma = { payment: { deleteMany: jest.fn() } };
    auditLogService = createAuditLogServiceMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PurgeExpiredFinancialDataCheck,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditLogService, useValue: auditLogService },
      ],
    }).compile();
    check = module.get(PurgeExpiredFinancialDataCheck);
  });

  it('is a no-op and writes no audit entry when nothing qualifies', async () => {
    prisma.payment.deleteMany.mockResolvedValue({ count: 0 });

    const result = await check.run(new Date('2031-01-01'));

    expect(result).toBe(0);
    expect(auditLogService.record).not.toHaveBeenCalled();
  });

  it('scopes the OR clause: PAYOUT gated on operator.deletedAt, everything else on customer.deletedAt', async () => {
    prisma.payment.deleteMany.mockResolvedValue({ count: 3 });
    const now = new Date('2031-01-01T00:00:00Z');

    await check.run(now);

    const cutoff = new Date(now.getTime() - 5 * 365 * 24 * 60 * 60 * 1000);
    expect(prisma.payment.deleteMany).toHaveBeenCalledWith({
      where: {
        createdAt: { lt: cutoff },
        OR: [
          {
            type: { in: ['DEPOSIT', 'BALANCE', 'REFUND'] },
            rescueRequest: { customer: { deletedAt: { not: null } } },
          },
          { type: 'PAYOUT', operator: { deletedAt: { not: null } } },
        ],
      },
    });
  });

  it('writes an audit entry with the purged count when rows were deleted', async () => {
    prisma.payment.deleteMany.mockResolvedValue({ count: 3 });

    await check.run(new Date('2031-01-01'));

    expect(auditLogService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'financial_data_purged',
        message: 'Purged 3 Payment rows past retention window',
      }),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/account-deletion/purge-expired-financial-data.check.spec.ts`
Expected: FAIL — file doesn't exist.

- [ ] **Step 3: Implement**

Create `src/account-deletion/purge-expired-financial-data.check.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { PaymentType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';

@Injectable()
export class PurgeExpiredFinancialDataCheck {
  readonly name = 'purge-expired-financial-data';
  private readonly RETENTION_MS = 5 * 365 * 24 * 60 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async run(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - this.RETENTION_MS);
    const result = await this.prisma.payment.deleteMany({
      where: {
        createdAt: { lt: cutoff },
        OR: [
          {
            type: { in: [PaymentType.DEPOSIT, PaymentType.BALANCE, PaymentType.REFUND] },
            rescueRequest: { customer: { deletedAt: { not: null } } },
          },
          { type: PaymentType.PAYOUT, operator: { deletedAt: { not: null } } },
        ],
      },
    });
    if (result.count > 0) {
      await this.auditLogService.record({
        category: 'financial_data_purged',
        message: `Purged ${result.count} Payment rows past retention window`,
        details: { cutoff: cutoff.toISOString() },
      });
    }
    return result.count;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/account-deletion/purge-expired-financial-data.check.spec.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing tests for `RetryMediaDeletionCheck`**

Create `src/account-deletion/retry-media-deletion.check.spec.ts`:
```ts
import { Test, TestingModule } from '@nestjs/testing';
import { RetryMediaDeletionCheck } from './retry-media-deletion.check';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../integrations/s3/s3.service';

describe('RetryMediaDeletionCheck', () => {
  let check: RetryMediaDeletionCheck;
  let prisma: { pendingMediaDeletion: { findMany: jest.Mock; delete: jest.Mock } };
  let s3Service: { deleteObject: jest.Mock };

  beforeEach(async () => {
    prisma = { pendingMediaDeletion: { findMany: jest.fn(), delete: jest.fn() } };
    s3Service = { deleteObject: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RetryMediaDeletionCheck,
        { provide: PrismaService, useValue: prisma },
        { provide: S3Service, useValue: s3Service },
      ],
    }).compile();
    check = module.get(RetryMediaDeletionCheck);
  });

  it('clears a row once its S3 object deletes successfully', async () => {
    prisma.pendingMediaDeletion.findMany.mockResolvedValue([{ id: 'p-1', s3Key: 'key-1' }]);
    s3Service.deleteObject.mockResolvedValue(undefined);

    const cleared = await check.run();

    expect(s3Service.deleteObject).toHaveBeenCalledWith('key-1');
    expect(prisma.pendingMediaDeletion.delete).toHaveBeenCalledWith({ where: { id: 'p-1' } });
    expect(cleared).toBe(1);
  });

  it('leaves a row in place when its S3 delete still fails', async () => {
    prisma.pendingMediaDeletion.findMany.mockResolvedValue([{ id: 'p-1', s3Key: 'key-1' }]);
    s3Service.deleteObject.mockRejectedValue(new Error('S3 down'));

    const cleared = await check.run();

    expect(prisma.pendingMediaDeletion.delete).not.toHaveBeenCalled();
    expect(cleared).toBe(0);
  });
});
```

- [ ] **Step 6: Run tests to verify they fail, then implement**

Run: `npx jest src/account-deletion/retry-media-deletion.check.spec.ts` → FAIL.

Create `src/account-deletion/retry-media-deletion.check.ts`:
```ts
import { Injectable } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../integrations/s3/s3.service';

@Injectable()
export class RetryMediaDeletionCheck {
  readonly name = 'retry-media-deletion';

  constructor(
    private readonly prisma: PrismaService,
    private readonly s3Service: S3Service,
  ) {}

  /**
   * `_now` is unused — this check has no notion of a retention clock —
   * but the parameter must exist so this class's `run` has the same call
   * signature as `PurgeExpiredFinancialDataCheck.run(now: Date)`. Without
   * it, `AccountDeletionTickerService.tick()`'s loop calling `check.run(now)`
   * against a union of both check types fails to compile: TypeScript's
   * excess-argument checking rejects passing an argument to a function
   * declared with zero parameters, even though extra arguments are
   * harmless at runtime.
   */
  async run(_now?: Date): Promise<number> {
    const pending = await this.prisma.pendingMediaDeletion.findMany({ take: 100 });
    let cleared = 0;
    for (const row of pending) {
      try {
        await this.s3Service.deleteObject(row.s3Key);
        await this.prisma.pendingMediaDeletion.delete({ where: { id: row.id } });
        cleared++;
      } catch (err) {
        console.error(`Retry: failed to delete media object ${row.s3Key}:`, err);
        Sentry.captureException(err, { extra: { s3Key: row.s3Key } });
      }
    }
    return cleared;
  }
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx jest src/account-deletion/retry-media-deletion.check.spec.ts`
Expected: PASS.

- [ ] **Step 8: Write the failing test for the ticker**

Create `src/account-deletion/account-deletion-ticker.service.spec.ts`:
```ts
import { AccountDeletionTickerService } from './account-deletion-ticker.service';

describe('AccountDeletionTickerService', () => {
  it('runs both checks on tick, and one failing does not stop the other', async () => {
    const purgeCheck = { name: 'purge', run: jest.fn().mockRejectedValue(new Error('boom')) };
    const mediaRetryCheck = { name: 'media-retry', run: jest.fn().mockResolvedValue(0) };
    const service = new AccountDeletionTickerService(purgeCheck as never, mediaRetryCheck as never);

    await (service as unknown as { tick: (now?: Date) => Promise<void> }).tick(new Date());

    expect(purgeCheck.run).toHaveBeenCalled();
    expect(mediaRetryCheck.run).toHaveBeenCalled();
  });
});
```

- [ ] **Step 9: Run test to verify it fails, then implement**

Run: `npx jest src/account-deletion/account-deletion-ticker.service.spec.ts` → FAIL.

Create `src/account-deletion/account-deletion-ticker.service.ts`:
```ts
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { PurgeExpiredFinancialDataCheck } from './purge-expired-financial-data.check';
import { RetryMediaDeletionCheck } from './retry-media-deletion.check';

@Injectable()
export class AccountDeletionTickerService implements OnModuleInit, OnModuleDestroy {
  private readonly INTERVAL_MS = 60 * 60 * 1000;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly purgeCheck: PurgeExpiredFinancialDataCheck,
    private readonly mediaRetryCheck: RetryMediaDeletionCheck,
  ) {}

  onModuleInit() {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(now: Date = new Date()): Promise<void> {
    for (const check of [this.purgeCheck, this.mediaRetryCheck]) {
      try {
        await check.run(now);
      } catch (error) {
        console.error(`Account-deletion check "${check.name}" failed:`, error);
        Sentry.captureException(error, { extra: { check: check.name } });
      }
    }
  }
}
```
`RetryMediaDeletionCheck.run(_now?: Date)` (Step 6 above) accepts and ignores the same `Date` argument `PurgeExpiredFinancialDataCheck.run(now)` requires — this is what makes `check.run(now)` type-check for both members of the `[this.purgeCheck, this.mediaRetryCheck]` array; without matching signatures, TypeScript's excess-argument checking would reject the call on whichever check declares fewer parameters.

- [ ] **Step 10: Run test to verify it passes**

Run: `npx jest src/account-deletion/account-deletion-ticker.service.spec.ts`
Expected: PASS.

- [ ] **Step 11: Wire into the module**

Update `src/account-deletion/account-deletion.module.ts` — add the three new classes to `providers` (import `AuditLogModule` alongside the existing imports, since `PurgeExpiredFinancialDataCheck` needs `AuditLogService`):
```ts
import { AuditLogModule } from '../audit-log/audit-log.module';
import { PurgeExpiredFinancialDataCheck } from './purge-expired-financial-data.check';
import { RetryMediaDeletionCheck } from './retry-media-deletion.check';
import { AccountDeletionTickerService } from './account-deletion-ticker.service';
```
Add `AuditLogModule` to `imports`, and `PurgeExpiredFinancialDataCheck, RetryMediaDeletionCheck, AccountDeletionTickerService` to `providers`.

- [ ] **Step 12: Full suite, lint, commit**

```bash
npx jest --silent
npx eslint "{src,apps,libs,test}/**/*.ts" --max-warnings 531
git add src/account-deletion/
git commit -m "Add the purge-and-media-retry ticker"
```

---

### Task 14: lrr-web — `useAccountDeletionApi` hook

**Files:**
- Create: `app/hooks/useAccountDeletionApi.ts`
- Modify: `app/hooks/index.ts` (export the new hook, matching this repo's existing barrel-file convention — check how `usePayoutApi` is exported there first)

**Interfaces:**
- Produces: `useAccountDeletionApi()` returning `{ loading, error, deleteUser(id), deleteOperator(id) }`.

- [ ] **Step 1: Confirm the export convention**

Run: `grep -n "usePayoutApi\|useAuditLogApi" app/hooks/index.ts` to see the exact export line shape used for existing hooks, and match it.

- [ ] **Step 2: Implement**

Create `app/hooks/useAccountDeletionApi.ts`, following `usePayoutApi.ts`'s exact shape (loading/error state, `apiFetch`, `err instanceof Error ? err.message : fallback`):
```ts
import { useCallback, useState } from "react";
import { apiFetch } from "./api";

export function useAccountDeletionApi() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const deleteUser = useCallback(async (id: string): Promise<{ message: string }> => {
    setLoading(true);
    setError(null);
    try {
      return await apiFetch(`/users/${id}`, { method: "DELETE" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to delete account";
      setError(msg);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const deleteOperator = useCallback(async (id: string): Promise<{ message: string }> => {
    setLoading(true);
    setError(null);
    try {
      return await apiFetch(`/operators/${id}`, { method: "DELETE" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to delete operator";
      setError(msg);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  return { loading, error, deleteUser, deleteOperator };
}
```

- [ ] **Step 3: Add the barrel export**

In `app/hooks/index.ts`, add the export line matching the existing convention found in Step 1.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add app/hooks/useAccountDeletionApi.ts app/hooks/index.ts
git commit -m "Add useAccountDeletionApi hook"
```

---

### Task 15: lrr-web — delete action on `OperatorsTab`

**Files:**
- Modify: `app/components/tabs/OperatorsTab.tsx`

**Interfaces:**
- Consumes: `useAccountDeletionApi` (Task 14).

- [ ] **Step 1: Read the current Actions cell**

Run: `sed -n '860,916p' app/components/tabs/OperatorsTab.tsx` to see the exact current button block (the status-transition buttons — `Approve`/`Suspend`/`Reinstate` — already gated on `myRole !== "PRODUCT"`) before adding to it.

- [ ] **Step 2: Add the delete button, confirm, and "Deleted" badge**

Import the hook at the top of the file:
```tsx
import { useAccountDeletionApi } from "../../hooks";
```
Inside the component, alongside the existing `actionLoading` state:
```tsx
const { deleteOperator } = useAccountDeletionApi();
```
Add a handler, following `OperatorsTab.tsx`'s own established `handleDelete` shape (the bank-details-clear one) exactly:
```tsx
async function handleDeleteOperator(operatorId: string) {
  if (!confirm("Delete this operator's account? This anonymizes their business details and cannot be undone.")) return;
  setActionLoading(operatorId + "delete");
  setActionError(null);
  try {
    await deleteOperator(operatorId);
    await load(); // reuse whatever this component's existing list-reload function is named — check for it near the other action handlers, e.g. the one called after Approve/Suspend
  } catch (err) {
    setActionError(err instanceof Error ? err.message : "Failed to delete operator");
  } finally {
    setActionLoading(null);
  }
}
```
(If this file's existing handlers use a different reload-function name or a different error-state variable than `actionError`/`setActionError`, match whatever is ALREADY there — check the `Approve`/`Suspend` handlers' exact reload and error-state calls first and reuse them verbatim, do not introduce a second, parallel error-display mechanism.)

In the Actions cell's JSX, add the button, `SUPER_ADMIN`-only (this page's `RequireRole` already allows ADMIN/SUPER_ADMIN/PRODUCT, so an additional inline role check is needed here, matching how `ManageUsersTab.tsx:141` gates "Add staff" to `myRole === "SUPER_ADMIN"`):
```tsx
{myRole === "SUPER_ADMIN" && (
  <button
    onClick={() => handleDeleteOperator(op.id)}
    disabled={actionLoading === op.id + "delete"}
    style={{ padding: "0.3rem 0.7rem", background: "#dc2626", color: "#fff", border: "none", borderRadius: 4, cursor: actionLoading === op.id + "delete" ? "not-allowed" : "pointer", fontSize: "0.8rem", fontWeight: 600 }}
  >
    {actionLoading === op.id + "delete" ? "Deleting…" : "Delete"}
  </button>
)}
```
Add a "Deleted" badge next to the existing `STATUS_STYLES`-driven status badge (around line 815-819), shown when `op.deletedAt` is set (requires the backend's operator-list response to include `deletedAt` — confirm `useOperatorApi.ts`'s `Operator` type already includes it or add `deletedAt: string | null` to that type if missing):
```tsx
{op.deletedAt && (
  <span style={{ display: "inline-block", padding: "0.3rem 0.7rem", background: "#f8d7da", color: "#721c24", borderRadius: 4, fontSize: "0.82rem", fontWeight: 600, marginLeft: 6 }}>
    Deleted
  </span>
)}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors. If `Operator.deletedAt` doesn't exist on the type from `useOperatorApi.ts`, add `deletedAt: string | null;` to that interface first.

- [ ] **Step 4: Manual verification**

Per this project's standing rule, start the dev server and exercise this in a browser as a SUPER_ADMIN: confirm the button appears only for SUPER_ADMIN, confirm() fires, a successful delete refreshes the list and shows the badge, and a rejected delete (e.g. an operator with an active request) surfaces the exact backend message inline.

- [ ] **Step 5: Commit**

```bash
git add app/components/tabs/OperatorsTab.tsx app/hooks/useOperatorApi.ts
git commit -m "Add delete-operator action to OperatorsTab"
```

---

### Task 16: lrr-web — Actions column and delete on `ManageUsersTab`

**Files:**
- Modify: `app/components/tabs/ManageUsersTab.tsx`
- Modify: `app/hooks/useAuthApi.ts` (add `deletedAt` to `UserListItem` if missing)

**Interfaces:**
- Consumes: `useAccountDeletionApi` (Task 14).

This page has no Actions column today — this task adds one, net new, rather than extending an existing one.

- [ ] **Step 1: Read the current table**

Run: `sed -n '219,262p' app/components/tabs/ManageUsersTab.tsx` to see the exact current header/row structure (`Name, Email, Phone, Role, Joined`, no actions) before adding a column.

- [ ] **Step 2: Add the Actions column**

Add `"Actions"` to the header array. Import the hook and add state/handler, following the exact same `confirm() → try/catch → err.message` shape as Task 15 (and this file's own existing `createMsg` pattern for surfacing the result — reuse a per-row loading/message idiom consistent with what's already there for "Add staff", e.g. a `deletingId`/`deleteMsg` pair):
```tsx
import { useAccountDeletionApi } from "../../hooks";
```
```tsx
const { deleteUser } = useAccountDeletionApi();
const [deletingId, setDeletingId] = useState<string | null>(null);
const [deleteMsg, setDeleteMsg] = useState<string | null>(null);

async function handleDeleteUser(id: string) {
  if (!confirm("Delete this account? This anonymizes their personal details and cannot be undone.")) return;
  setDeletingId(id);
  setDeleteMsg(null);
  try {
    await deleteUser(id);
    const refreshed = await listUsers(); // match whatever this component's existing list-load call is actually named — check the initial useEffect's fetch call
    setUsers(refreshed); // match the existing state setter's actual name
  } catch (err) {
    setDeleteMsg(err instanceof Error ? err.message : "Failed to delete account");
  } finally {
    setDeletingId(null);
  }
}
```
Add a new `<td>` per row, `SUPER_ADMIN`-only (matching the existing `myRole === "SUPER_ADMIN"` check already used for "Add staff" in this same file):
```tsx
<td style={{ padding: "0.9rem 1rem" }}>
  {myRole === "SUPER_ADMIN" && !u.deletedAt && (
    <button
      onClick={() => handleDeleteUser(u.id)}
      disabled={deletingId === u.id}
      style={{ padding: "0.3rem 0.7rem", background: "#dc2626", color: "#fff", border: "none", borderRadius: 4, cursor: deletingId === u.id ? "not-allowed" : "pointer", fontSize: "0.8rem", fontWeight: 600 }}
    >
      {deletingId === u.id ? "Deleting…" : "Delete"}
    </button>
  )}
  {u.deletedAt && (
    <span style={{ display: "inline-block", padding: "0.3rem 0.7rem", background: "#f8d7da", color: "#721c24", borderRadius: 4, fontSize: "0.82rem", fontWeight: 600 }}>
      Deleted
    </span>
  )}
</td>
```
Render `deleteMsg` somewhere visible on the page (reuse this file's existing `createMsg`-rendering `<span>` pattern, or place an equivalent one near the table).

- [ ] **Step 3: Add `deletedAt` to the `UserListItem` type if missing**

Run: `grep -n "deletedAt" app/hooks/useAuthApi.ts`. If absent, add `deletedAt: string | null;` to the `UserListItem` interface (lines 26-34 per earlier research).

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 5: Manual verification**

Same as Task 15's Step 4, on the `/users` page instead.

- [ ] **Step 6: Commit**

```bash
git add app/components/tabs/ManageUsersTab.tsx app/hooks/useAuthApi.ts
git commit -m "Add Actions column with delete-account to ManageUsersTab"
```

---

## Self-Review

**Spec coverage:**
- Section 1 (data model) → Task 1.
- Section 2 (delete flow, both role-restriction and dispute-scrub corrections) → Tasks 10, 11.
- Section 2a (creation race, S3 durability, operator-membership gap) → Tasks 4, 10 (S3 outbox is inline in `deleteUser`), 5-9.
- Section 2b (payment-creation race) → Task 3.
- Section 2c (identity-scoped dispute scrub, `lockActiveMembership`) → Tasks 10, 11 (scrub), 5 (service), 7-9 (call sites).
- The review rounds' fixes (both dispute statements in both directions; `lockActiveMembership` locking the User row too; the payment-type scoping; the sole-OWNER guard; the `PaymentLedgerService.create()` branch fix) → folded directly into Tasks 3, 5, 10, 11 above — the spec file already reflects the first two, this plan's code matches it verbatim, and the rest are plan-level correctness fixes the spec didn't need to anticipate at that level of implementation detail.
- **A fourth review round found a deeper issue not covered by the spec at all: Postgres's read-committed re-check does not safely re-evaluate relational sub-conditions (baked into a locking `updateMany`'s own `WHERE`) against fresh data.** This reshaped Tasks 5, 8, 10, and 11 into a fixed lock → read → write shape (see the Architecture note and Global Constraints at the top of this plan) and added Task 9b, which didn't exist in any earlier draft — the two places that actually write `RescueRequest.assignedOperatorId` needed their own lock, since Task 9's `respondToOffer` never touches that column at all.
- **A fifth review corrected the transaction boundaries against the actual
  source.** Task 9 now protects both dashboard and WhatsApp quote channels
  through one shared transactional claim helper. Task 9b atomically commits
  request claim + Operator lock + assignment + offer states + PENDING deposit
  Payment before Paystack, rather than calling Paystack before assignment or
  leaving an early `WAITING_FOR_DEPOSIT` claim behind. Task 9c adds the
  missing User→Operator lock protocol for dispute opening/reopening. Task 11
  now guards unsettled payout entitlement (no SUCCEEDED sibling), so FAILED
  and REVERSED attempts remain deletion blockers. Task 10's integration suite
  now includes real two-client races for request/payment creation and
  assignment/payout creation, and Task 1 updates `truncateAll()` for the
  FK-independent `PendingMediaDeletion` table.
- Section 3 (read-path effects) → no new task; these are already-true consequences of Task 1's migration and Tasks 10/11's field-nulling, verified by Task 10/11's own tests (e.g. the post-delete login-lookup behavior falls out of `email: null` with no separate code needed — not worth a dedicated task, but worth one assertion; **gap found and left explicit rather than silently dropped:** no task above adds the `AuthService.login` post-delete test the spec's Testing section calls for. Add it to Task 10 as an extra step before finalizing, or as a follow-up — flagging here per the self-review instruction rather than silently omitting it.)
- Section 4 (purge + retry ticker) → Task 13.
- Section 5 (admin UI) → Tasks 14-16.

**Gap fix:** Task 10 is missing the spec's "post-delete login lookup fails" integration assertion. Adding it now: in Task 10's Step 6 integration test file, add one more test:
```ts
it('makes the account unfindable by AuthService.login afterward', async () => {
  const user = await prisma.user.create({
    data: { email: 'test@example.com', phoneNumber: '+2348011111111', role: 'CUSTOMER', passwordHash: 'x' },
  });

  await service.deleteUser(user.id, 'admin-1');

  const found = await prisma.user.findUnique({ where: { email: 'test@example.com' } });
  expect(found).toBeNull();
});
```

**Placeholder scan:** no TBD/TODO markers. The implementation tasks require
re-reading current source where exact message strings or existing side-effect
ordering must be preserved; the corrected tasks state the required transaction
boundaries explicitly rather than leaving them to implementer judgment.

**Type consistency:** `AccountDeletionService.deleteUser(id, actorId)` / `.deleteOperator(id, actorId)` signatures match between Tasks 10/11 (definition) and Task 12 (controller call sites). `OperatorMembershipService.lockActiveMembership(tx, actingUser: {userId, role}, operatorId)` parameter order and shape matches across Tasks 5 (definition), 7, 8, 9 (call sites) — note the signature carries the acting user's *role*, not a bare id string, consistently everywhere it's called. `PurgeExpiredFinancialDataCheck`/`RetryMediaDeletionCheck`'s `name`/`run()` shape matches what `AccountDeletionTickerService` (Task 13) expects. Neither `deleteUser` nor `deleteOperator` has a separate `explainXDeleteFailure` method any more — Tasks 10 and 11 both throw directly from each guard read inline, and Task 12's controller/Task 10-11's own tests were updated to match.
