# Per-Operator Deposit Percentage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator override the platform-wide deposit percentage for their own business, freeze that percentage onto each quote the moment it's shown to a customer, and handle the 0% and 100% boundaries this unlocks — none of which the existing deposit/balance flow has ever had to do.

**Architecture:** One nullable `Decimal` column on `Operator` (the override) and one on `DispatchOffer` (the snapshot taken when a quote is shown to a customer). A new dedicated endpoint, matching the existing `bank-details` precedent (transactional, lock-then-mutate), lets staff or the operator themselves set the override. The two places that compute a deposit amount diverge on purpose — the customer-facing quote-selection path reads the frozen snapshot; the staff-driven manual-assignment path, which has no prior shortlist to freeze against, resolves live. Both get an explicit 0%-deposit branch. A new `finalizeJobSettlement` method, extracted from the existing `confirmBalance`, handles the symmetric 100%-deposit (₦0 balance) case for both of its callers at once. A second extraction, `activateAssignedJob` — pulled out of `confirmDeposit` — handles the start-of-job activation (offer→`ACCEPTED`, both parties' session transitions, the operator's job-is-live message) that both 0%-deposit branches need in place of a payment confirmation they will never receive.

**Tech Stack:** NestJS + Prisma (lrr-service), Next.js (lrr-web), Twilio WhatsApp, Jest (unit + real-Postgres integration tests).

**Spec:** `docs/superpowers/specs/2026-10-09-per-operator-deposit-percentage-design.md`

## Global Constraints

- `Operator.depositPercentOverride` and `DispatchOffer.depositPercentSnapshot` are both nullable `Decimal`, no default value, additive — every existing row keeps today's behavior (`null` everywhere, meaning "use the platform default").
- No floor or ceiling beyond 0–100 inclusive, on either the override or the platform-wide default. This is an explicit product decision — do not add a business-judgment minimum/maximum.
- The deposit is money the platform collects from the customer, never money paid to the operator early. Operators are paid out on completion only, before and after this change, regardless of deposit %. Nothing in this plan changes payout timing.
- `WhatsAppCustomerFlowService.handleQuoteSelected` must read `selectedOffer.depositPercentSnapshot` — never re-resolve the operator's current setting. `RescueRequestAdminService.assignOperator` has no prior shortlist to freeze against and resolves live instead — this asymmetry is intentional, not a bug to "fix" into consistency.
- Every read of `depositPercentOverride` or `depositPercentSnapshot` used in arithmetic must be wrapped in `Number(...)` — both are Prisma `Decimal` columns, and `config.depositPercent` (the only other operand they're ever compared or combined with) is already a plain `number` by the time it reaches these call sites (`PlatformConfigService.getConfig()` converts via `.toNumber()`). Follow the codebase's existing convention for other Decimal fields (`Number(rescueRequest.latitude)`, used this way throughout `dispatch.service.ts`) — do not add backend-side API response conversion; `findAll`/`findById` already return raw Decimal fields today (same as `latitude`/`longitude`) and the frontend already handles this by typing those fields `number | string` and wrapping reads in `Number(...)` on its own side.
- Any boundary branch (0%-deposit, 100%-deposit/₦0-balance) must key off the **computed** amount (`depositAmount === 0` / `balanceAmount === 0`), never the raw stored percentage — `Math.round` can produce a zero or full-total amount from a percentage that isn't literally 0 or 100, on a small enough job total.
- `PATCH /operators/:id/deposit-percent` uses the same permission check as `saveBankDetails` (`assertCanManageOperator` — admins, or OWNER/MANAGER members of that operator), not a narrower one, AND the same transactional locking as every other operator mutation of this kind (`$transaction` + `OperatorMembershipService.lockActiveMembership(tx, actingUser, id)`, where `actingUser` carries `role` so the admin bypass inside `lockActiveMembership` works).
- This app has **no global `ValidationPipe` wired up** (see `saveBankDetails`'s own comment on this same gap) — DTO class-validator decorators (`@IsNumber`, `@Min`, `@IsOptional`, etc.) do not run by themselves and are documentation only. Anything that must actually be enforced needs a manual check inside the service, the same way `saveBankDetails` checks `accountNumber`'s format by hand. Do not treat a DTO decorator as real validation anywhere in this plan.
- A job's `OPERATOR_ASSIGNED` activation — the offer flip to `ACCEPTED`, both parties' WhatsApp session-state transitions, and the operator's job-is-live message — is centralized in `PaymentEventsService.activateAssignedJob` (Task 4). Every path that confirms an operator without a real payment behind it (the two 0%-deposit branches) calls it rather than hand-rolling a partial copy of what `confirmDeposit` already does.

## Review Focus

- **Setting the override to exactly `0` must persist `0`, not be silently skipped.** The spec itself traced one real bug caused by treating `0` as falsy (`!balanceAmount`); the new endpoint's own validation/update logic, and its audit-log write, must check `!== undefined`/`!= null`, never plain truthiness, or an operator explicitly choosing 0% would fail to save, or would have its audit trail record a false `before: null`, and nobody would notice.
- **Rounding can produce a boundary amount from a non-boundary percentage.** A small job total at a small-but-nonzero percent can round `depositAmount` down to 0 via `Math.round`; a percent near 100 can round it up to the full total, zeroing `balanceAmount`. Both boundary branches must trigger off the computed amount, not the stored percentage — a test setting e.g. 1% on a ₦40 total (rounds to 0) must take the same branch as a test setting literally 0%.
- **`deliverQuoteShortlist` can run more than once for the same request** (multiple dispatch rounds, radius expansion) and re-queries every `QUOTED` offer each time, including ones from earlier rounds. The snapshot write must happen on every call, overwriting any prior value — the last write before the customer actually sees the message is the one that has to match what `handleQuoteSelected` later charges, not the first.
- **An operator with no override at all must still get a real, non-null snapshot.** `deliverQuoteShortlist`'s `?? config.depositPercent` fallback must actually populate `depositPercentSnapshot` with a concrete number for every quoted offer, not leave it `null` on the assumption that `handleQuoteSelected`'s own defensive fallback will cover it later — that fallback exists for an impossible-in-normal-flow gap, not as the expected path.
- **The quote-selection timeout reconciler must not break on the new field.** `QuoteSelectionTimeoutCheck` (and the request-cancellation paths it shares code with) cancel a `DISPATCHING` request whose quotes went unanswered — confirm the new `depositPercentSnapshot` column on an abandoned, never-selected offer needs no cleanup and doesn't interfere with that existing cancellation path.

---

### Task 1: Schema migration — `depositPercentOverride` and `depositPercentSnapshot`

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_per_operator_deposit_percentage/migration.sql`

**Interfaces:**
- Produces: `Operator.depositPercentOverride: Decimal | null` (Prisma), `DispatchOffer.depositPercentSnapshot: Decimal | null` (Prisma) — consumed by every later task.

- [ ] **Step 1: Add the two fields to the schema**

In `prisma/schema.prisma`, add to `model Operator` (near the other plain scalar fields):
```prisma
depositPercentOverride Decimal?
```
Add to `model DispatchOffer` (near `quotedPrice`):
```prisma
depositPercentSnapshot Decimal?
```
Neither takes a `@default` — nullable fields default to `null` without one, and an explicit default here would misleadingly suggest a fallback value exists at the schema level when the real fallback (`config.depositPercent`) is resolved in application code.

- [ ] **Step 2: Generate the migration**

Run: `yarn prisma migrate dev --name per_operator_deposit_percentage --create-only`

Confirm the generated SQL matches exactly:
```sql
-- AlterTable
ALTER TABLE "Operator" ADD COLUMN     "depositPercentOverride" DECIMAL(65,30);

-- AlterTable
ALTER TABLE "DispatchOffer" ADD COLUMN     "depositPercentSnapshot" DECIMAL(65,30);
```
If Prisma generates a different precision/scale (e.g. matching `PlatformConfig.depositPercent`'s own column type), that's fine — match whatever `PlatformConfig.depositPercent`'s actual column definition is rather than forcing `(65,30)` if it differs; check `prisma/migrations/`'s history for that field's original migration to confirm the precision this codebase actually uses for a percentage `Decimal`.

- [ ] **Step 3: Apply the migration**

Run: `yarn prisma migrate dev`
Run: `yarn prisma generate`

- [ ] **Step 4: Verify**

Run: `yarn tsc --noEmit`
Expected: clean — the new fields aren't referenced by any code yet.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "Add depositPercentOverride and depositPercentSnapshot columns"
```

---

### Task 2: `PATCH /operators/:id/deposit-percent` endpoint

**Files:**
- Create: `src/operator/dto/set-deposit-percent.dto.ts`
- Modify: `src/operator/operator.service.ts` (new method)
- Modify: `src/operator/operator.controller.ts` (new endpoint)
- Test: `src/operator/operator.service.spec.ts`
- Test: `src/operator/operator.controller.spec.ts`

**Interfaces:**
- Consumes: `Operator.depositPercentOverride` (Task 1), `AuditLogService.record` (already injected in `OperatorService` — check first; if not, add it), `OperatorService.assertCanManageOperator` (already exists, used by `saveBankDetails`, called from the controller), `OperatorMembershipService.lockActiveMembership(tx, actingUser, operatorId)` (already exists, used by `saveBankDetails`/`clearBankDetails`/`updateProfile` — all three wrap their mutation in `this.prisma.$transaction` and call this as the first statement inside it).
- Produces: `OperatorService.setDepositPercent(id: string, depositPercentOverride: number | null | undefined, actingUser: { userId: string; role: string }): Promise<Operator>` — consumed by the controller in this task. Note the type: `undefined` is a real, distinct input (an omitted request-body field) that must be rejected, not silently treated the same as `null` (an explicit clear).

- [ ] **Step 1: Check whether `AuditLogService` is already injected in `OperatorService`**

Run: `grep -n "AuditLogService" src/operator/operator.service.ts`

If it's not already a constructor dependency, you'll add it in Step 3 — note which case you're in before writing the test, since the test's `TestingModule` providers list depends on it.

- [ ] **Step 2: Write the failing tests**

In `src/operator/operator.service.spec.ts`, add (this file already declares `prisma.$transaction: jest.fn((cb) => cb(prisma))` — meaning the `tx` a test observes IS the same `prisma` mock object, so assertions below target `prisma.operator.*` directly — and an `operatorMembershipService.lockActiveMembership` mock that resolves by default; match the file's existing `const actingUser = { userId: 'user-1', role: 'OPERATOR' };` naming style for your own fixture):
```ts
describe('setDepositPercent', () => {
  const actor = { userId: 'admin-1', role: 'ADMIN' };

  it('persists the override and returns the updated operator', async () => {
    prisma.operator.findUnique.mockResolvedValue({ depositPercentOverride: null });
    prisma.operator.update.mockResolvedValue({ id: 'op-1', depositPercentOverride: 25 });

    const result = await service.setDepositPercent('op-1', 25, actor);

    expect(operatorMembershipService.lockActiveMembership).toHaveBeenCalledWith(
      prisma,
      actor,
      'op-1',
    );
    expect(prisma.operator.update).toHaveBeenCalledWith({
      where: { id: 'op-1' },
      data: { depositPercentOverride: 25 },
    });
    expect(result).toEqual({ id: 'op-1', depositPercentOverride: 25 });
  });

  it('persists exactly 0 — not skipped as falsy', async () => {
    prisma.operator.findUnique.mockResolvedValue({ depositPercentOverride: 25 });
    prisma.operator.update.mockResolvedValue({ id: 'op-1', depositPercentOverride: 0 });

    await service.setDepositPercent('op-1', 0, actor);

    expect(prisma.operator.update).toHaveBeenCalledWith({
      where: { id: 'op-1' },
      data: { depositPercentOverride: 0 },
    });
  });

  it('clears the override back to the platform default when given null', async () => {
    prisma.operator.findUnique.mockResolvedValue({ depositPercentOverride: 25 });
    prisma.operator.update.mockResolvedValue({ id: 'op-1', depositPercentOverride: null });

    await service.setDepositPercent('op-1', null, actor);

    expect(prisma.operator.update).toHaveBeenCalledWith({
      where: { id: 'op-1' },
      data: { depositPercentOverride: null },
    });
  });

  it('rejects a missing value (undefined) — e.g. an empty request body — instead of silently no-opping', async () => {
    await expect(
      service.setDepositPercent('op-1', undefined, actor),
    ).rejects.toThrow('depositPercentOverride is required');
    expect(prisma.operator.update).not.toHaveBeenCalled();
  });

  it('rejects a value below 0', async () => {
    await expect(service.setDepositPercent('op-1', -1, actor)).rejects.toThrow(
      'depositPercentOverride must be between 0 and 100',
    );
    expect(prisma.operator.update).not.toHaveBeenCalled();
  });

  it('rejects a value above 100', async () => {
    await expect(service.setDepositPercent('op-1', 101, actor)).rejects.toThrow(
      'depositPercentOverride must be between 0 and 100',
    );
    expect(prisma.operator.update).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric value (e.g. a string body field) instead of reaching Prisma', async () => {
    await expect(
      service.setDepositPercent('op-1', 'abc' as any, actor),
    ).rejects.toThrow('depositPercentOverride must be between 0 and 100');
    expect(prisma.operator.update).not.toHaveBeenCalled();
  });

  it('writes an audit log entry recording a real 0, not a falsy-coerced null, when the prior value was 0', async () => {
    prisma.operator.findUnique.mockResolvedValue({ depositPercentOverride: 0 });
    prisma.operator.update.mockResolvedValue({ id: 'op-1', depositPercentOverride: 25 });

    await service.setDepositPercent('op-1', 25, actor);

    expect(auditLogService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'deposit_percent_changed',
        actorId: 'admin-1',
        details: expect.objectContaining({
          operatorId: 'op-1',
          before: 0,
          after: 25,
        }),
      }),
    );
  });

  it('writes an audit log entry with before: null when there was no prior override', async () => {
    prisma.operator.findUnique.mockResolvedValue({ depositPercentOverride: null });
    prisma.operator.update.mockResolvedValue({ id: 'op-1', depositPercentOverride: 25 });

    await service.setDepositPercent('op-1', 25, actor);

    expect(auditLogService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ before: null, after: 25 }),
      }),
    );
  });
});
```
If `AuditLogService` wasn't already injected (Step 1), add a mock for it to this file's `beforeEach`/`TestingModule` setup, matching whatever mock-shape convention this file already uses for its other service dependencies (e.g. `PaystackService`, `OtpService` — check how those are provided and copy the pattern, don't invent a different shape).

- [ ] **Step 3: Run tests to verify they fail**

Run: `yarn jest src/operator/operator.service.spec.ts -t "setDepositPercent"`
Expected: FAIL — `setDepositPercent` doesn't exist yet.

- [ ] **Step 4: Implement**

If `AuditLogService` isn't already a constructor dependency of `OperatorService`, add it:
```ts
import { AuditLogService } from '../audit-log/audit-log.service';
```
```ts
constructor(
  private readonly prisma: PrismaService,
  private readonly paystackService: PaystackService,
  private readonly otpService: OtpService,
  private readonly operatorMembershipService: OperatorMembershipService,
  private readonly auditLogService: AuditLogService,
) {}
```

Add the method (anywhere in the class — near `saveBankDetails` makes sense, same category of financially-sensitive field, same transactional-locking shape):
```ts
/**
 * `undefined` means the field was missing from the request body — that's
 * rejected outright, not treated as "no change": without this check a
 * `{}` body would reach Prisma as `data: { depositPercentOverride:
 * undefined }`, which Prisma silently treats as "don't touch this
 * field," returning 200 having changed nothing and logging a
 * meaningless audit entry. `null` is the one legitimate way to clear the
 * override back to the platform default — distinct from, and allowed
 * where `undefined` is not.
 *
 * DTO decorators on SetDepositPercentDto are documentation only — this
 * app has no global ValidationPipe, so they never run; the real
 * enforcement is here, the same way saveBankDetails checks
 * accountNumber's format by hand instead of trusting its DTO.
 */
async setDepositPercent(
  id: string,
  depositPercentOverride: number | null | undefined,
  actingUser: { userId: string; role: string },
): Promise<Operator> {
  if (depositPercentOverride === undefined) {
    throw new BadRequestException(
      'depositPercentOverride is required in the request body (pass null to clear it)',
    );
  }
  // typeof/isFinite first: with no global ValidationPipe, `depositPercentOverride`
  // is whatever the JSON body actually contained — a string, an object, NaN
  // via Infinity arithmetic, anything — not just a number out of range. A
  // bare `< 0 || > 100` comparison against a non-number coerces to false on
  // both sides and would let it through to Prisma unvalidated.
  if (
    depositPercentOverride !== null &&
    (typeof depositPercentOverride !== 'number' ||
      !Number.isFinite(depositPercentOverride) ||
      depositPercentOverride < 0 ||
      depositPercentOverride > 100)
  ) {
    throw new BadRequestException(
      'depositPercentOverride must be between 0 and 100',
    );
  }

  const { operator, before } = await this.prisma.$transaction(async (tx) => {
    await this.operatorMembershipService.lockActiveMembership(
      tx,
      actingUser,
      id,
    );
    const before = await tx.operator.findUnique({
      where: { id },
      select: { depositPercentOverride: true },
    });
    if (!before) throw new NotFoundException('Operator not found');

    const operator = await tx.operator.update({
      where: { id },
      data: { depositPercentOverride },
    });
    return { operator, before };
  });

  // AuditLogService has no transaction-aware overload, so this write
  // happens just after the transaction commits, not atomically with it —
  // an acceptable gap for a best-effort audit trail (same tradeoff this
  // app already accepts elsewhere; see the AuditLogService module itself
  // for precedent).
  await this.auditLogService.record({
    category: 'deposit_percent_changed',
    message: `Deposit percent changed for operator ${id}`,
    details: {
      targetType: 'Operator',
      targetId: id,
      operatorId: id,
      before:
        before.depositPercentOverride != null
          ? Number(before.depositPercentOverride)
          : null,
      after: depositPercentOverride,
    },
    actorId: actingUser.userId,
  });

  return operator;
}
```
Add `Operator` to this file's existing `@prisma/client` import if not already present, and `BadRequestException`/`NotFoundException` from `@nestjs/common` if not already present — check both first (this file almost certainly already imports `NotFoundException`, since `saveBankDetails` itself throws it).

- [ ] **Step 5: Run tests to verify they pass**

Run: `yarn jest src/operator/operator.service.spec.ts`
Expected: PASS, including every pre-existing test in this file.

- [ ] **Step 6: Write the controller test**

In `src/operator/operator.controller.spec.ts`, add (matching this file's existing `TestingModule`/guard-override pattern — check the top of the file for the exact shape used for `setIsTest`'s tests and copy it):
```ts
describe('setDepositPercent', () => {
  it('forwards to OperatorService.setDepositPercent with the body and the whole acting user (role included)', async () => {
    operatorService.setDepositPercent = jest.fn().mockResolvedValue({
      id: 'op-1',
      depositPercentOverride: 25,
    });
    const req = { user: { userId: 'admin-1', role: 'ADMIN' } } as any;

    const result = await controller.setDepositPercent(req, 'op-1', { depositPercentOverride: 25 });

    expect(operatorService.setDepositPercent).toHaveBeenCalledWith(
      'op-1',
      25,
      { userId: 'admin-1', role: 'ADMIN' },
    );
    expect(result).toEqual({
      message: 'Deposit percentage updated',
      data: { id: 'op-1', depositPercentOverride: 25 },
    });
  });
});
```
Add `setDepositPercent: jest.Mock` to this file's `operatorService` mock type/object, matching the existing pattern for `setIsTest`.

- [ ] **Step 7: Run the controller test to verify it fails**

Run: `yarn jest src/operator/operator.controller.spec.ts -t "setDepositPercent"`
Expected: FAIL — `controller.setDepositPercent` doesn't exist yet.

- [ ] **Step 8: Implement the controller endpoint**

Create `src/operator/dto/set-deposit-percent.dto.ts`:
```ts
import { IsNumber, IsOptional, Max, Min } from 'class-validator';

/**
 * Decorators here are documentation only (no global ValidationPipe is
 * wired up in this app — see OperatorService.setDepositPercent for where
 * the real enforcement lives, including rejecting a missing field,
 * which @IsOptional() would NOT do even if a pipe existed).
 */
export class SetDepositPercentDto {
  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(100)
  depositPercentOverride: number | null;
}
```
In `src/operator/operator.controller.ts`, add the import and endpoint, placed near `saveBankDetails` (same permission shape, same category of field):
```ts
import { SetDepositPercentDto } from './dto/set-deposit-percent.dto';
```
```ts
/**
 * Set or clear an operator's own deposit percentage override. Same
 * permission check as bank details — admins, or OWNER/MANAGER members of
 * this specific operator. null clears the override back to the platform
 * default. Passes req.user whole (not just userId) because
 * setDepositPercent's own transactional lock needs the role for its
 * admin bypass — same shape every other mutating endpoint on this
 * controller already uses.
 */
@UseGuards(AuthGuard)
@Patch(':id/deposit-percent')
async setDepositPercent(
  @Req() req: AuthenticatedOperatorRequest,
  @Param('id') id: string,
  @Body() dto: SetDepositPercentDto,
) {
  await this.operatorService.assertCanManageOperator(req.user, id);
  const operator = await this.operatorService.setDepositPercent(
    id,
    dto.depositPercentOverride,
    req.user,
  );
  return { message: 'Deposit percentage updated', data: operator };
}
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `yarn jest src/operator/operator.controller.spec.ts`
Expected: PASS, including every pre-existing test.

- [ ] **Step 10: Full suite, lint, commit**

```bash
yarn jest --silent
yarn eslint "{src,apps,libs,test}/**/*.ts" --max-warnings 527
git add src/operator/dto/set-deposit-percent.dto.ts src/operator/operator.service.ts src/operator/operator.service.spec.ts src/operator/operator.controller.ts src/operator/operator.controller.spec.ts
git commit -m "Add PATCH /operators/:id/deposit-percent"
```

---

### Task 3: `deliverQuoteShortlist` — snapshot the percentage and show it

**Files:**
- Modify: `src/rescue-request/dispatch.service.ts:1213-1270` (`deliverQuoteShortlist`)
- Test: `src/rescue-request/dispatch.service.spec.ts`

**Interfaces:**
- Consumes: `Operator.depositPercentOverride`, `DispatchOffer.depositPercentSnapshot` (Task 1).
- Produces: every `QUOTED` `DispatchOffer` for a request gets `depositPercentSnapshot` populated as a side effect of `deliverQuoteShortlist` running — consumed by Task 5.

- [ ] **Step 1: Write the failing tests**

In `src/rescue-request/dispatch.service.spec.ts`, find the existing `describe('deliverQuoteShortlist', ...)` block (search for it — this method already has coverage) and add, matching that block's existing mock setup exactly:
```ts
it('writes the effective deposit percentage onto every quoted offer before sending', async () => {
  prisma.rescueRequest.findUnique.mockResolvedValue({
    id: 'req-1',
    status: 'DISPATCHING',
    latitude: 6.5,
    longitude: 3.4,
    customer: { phoneNumber: '+2348000000000' },
  });
  prisma.dispatchOffer.findMany.mockResolvedValue([
    {
      id: 'offer-1',
      operatorId: 'op-1',
      quotedPrice: 25000,
      operator: {
        id: 'op-1',
        businessName: 'Swift Towing',
        latitude: 6.5,
        longitude: 3.4,
        depositPercentOverride: 20,
      },
    },
    {
      id: 'offer-2',
      operatorId: 'op-2',
      quotedPrice: 26000,
      operator: {
        id: 'op-2',
        businessName: 'Raheem Towing',
        latitude: 6.5,
        longitude: 3.4,
        depositPercentOverride: null,
      },
    },
  ]);
  platformConfigService.getConfig.mockResolvedValue({
    serviceFeePercent: 10,
    depositPercent: 10,
  });

  await service.deliverQuoteShortlist('req-1', 'cust-1');

  expect(prisma.dispatchOffer.update).toHaveBeenCalledWith({
    where: { id: 'offer-1' },
    data: { depositPercentSnapshot: 20 },
  });
  expect(prisma.dispatchOffer.update).toHaveBeenCalledWith({
    where: { id: 'offer-2' },
    data: { depositPercentSnapshot: 10 },
  });
});

it('includes the deposit percentage in each shortlist line', async () => {
  prisma.rescueRequest.findUnique.mockResolvedValue({
    id: 'req-1',
    status: 'DISPATCHING',
    latitude: 6.5,
    longitude: 3.4,
    customer: { phoneNumber: '+2348000000000' },
  });
  prisma.dispatchOffer.findMany.mockResolvedValue([
    {
      id: 'offer-1',
      operatorId: 'op-1',
      quotedPrice: 25000,
      operator: {
        id: 'op-1',
        businessName: 'Swift Towing',
        latitude: 6.5,
        longitude: 3.4,
        depositPercentOverride: 20,
      },
    },
  ]);
  platformConfigService.getConfig.mockResolvedValue({
    serviceFeePercent: 10,
    depositPercent: 10,
  });

  await service.deliverQuoteShortlist('req-1', 'cust-1');

  expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
    '+2348000000000',
    expect.stringContaining('Deposit 20%'),
  );
});

it('writes a fresh snapshot every call, not just the first — overwriting any prior value', async () => {
  prisma.rescueRequest.findUnique.mockResolvedValue({
    id: 'req-1',
    status: 'DISPATCHING',
    latitude: 6.5,
    longitude: 3.4,
    customer: { phoneNumber: '+2348000000000' },
  });
  prisma.dispatchOffer.findMany.mockResolvedValue([
    {
      id: 'offer-1',
      operatorId: 'op-1',
      quotedPrice: 25000,
      operator: {
        id: 'op-1',
        businessName: 'Swift Towing',
        latitude: 6.5,
        longitude: 3.4,
        depositPercentOverride: 30, // changed since an earlier round's delivery
      },
    },
  ]);
  platformConfigService.getConfig.mockResolvedValue({
    serviceFeePercent: 10,
    depositPercent: 10,
  });

  await service.deliverQuoteShortlist('req-1', 'cust-1');

  expect(prisma.dispatchOffer.update).toHaveBeenCalledWith({
    where: { id: 'offer-1' },
    data: { depositPercentSnapshot: 30 },
  });
});
```
Check this spec file's existing `deliverQuoteShortlist` tests for the exact `prisma.dispatchOffer.findMany` mock shape already used (operator fields included, `calculateDistance` stubbing via `operatorService['calculateDistance']`, etc.) and match it precisely — add `depositPercentOverride` to whatever operator object shape is already there rather than inventing a new one.

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn jest src/rescue-request/dispatch.service.spec.ts -t "deposit percentage"`
Expected: FAIL — `depositPercentSnapshot` is never written or displayed yet.

- [ ] **Step 3: Implement**

In `src/rescue-request/dispatch.service.ts`, inside `deliverQuoteShortlist`, after `quotedOffers` is fetched and before the `forRanking` map (or merged into it — either is fine as long as the write happens before `ranked`/`lines` are built), add the snapshot write:
```ts
const config = await this.platformConfigService.getConfig();

// Freeze the percentage now, before anything is shown — handleQuoteSelected
// reads this snapshot later, never the operator's current setting, so what
// the customer sees here is what they end up charged regardless of what
// changes afterward. Overwritten on every call (multiple dispatch rounds
// can call this more than once for the same request) — the last write
// before the customer actually reads the message is the one that counts.
//
// Kept in a side map keyed by offerId rather than added as a field on the
// ranked objects: RankedQuote (domain/quote-ranking.ts) extends a closed
// QuoteForRanking interface plus `score` — it is not generic, so a
// `depositPercent` field riding along on the object quotedOffers.map(...)
// produces would NOT be visible on rankQuotes' return type, and reading
// it back off `ranked` would fail tsc. rankQuotes also has exactly one
// other caller (handleQuoteSelected's own forRanking, in
// whatsapp-customer-flow.service.ts), which has no use for the
// percentage on the ranked object at all — so the shared type stays
// untouched here rather than widened for one caller.
const depositPercentByOfferId = new Map<string, number>();
await Promise.all(
  quotedOffers.map((offer) => {
    const depositPercent = Number(
      offer.operator.depositPercentOverride ?? config.depositPercent,
    );
    depositPercentByOfferId.set(offer.id, depositPercent);
    return this.prisma.dispatchOffer.update({
      where: { id: offer.id },
      data: { depositPercentSnapshot: depositPercent },
    });
  }),
);
```
Note: the existing code already calls `const config = await this.platformConfigService.getConfig();` later, right before building `lines` — move that single existing line up to before this new block (don't call `getConfig()` twice), and delete the now-duplicate later declaration.

`forRanking` and `rankQuotes` itself are **unchanged** — don't add a field to either. Only `lines`' template changes, looking the percentage up by `offerId` instead of reading it off the ranked object:
```ts
const lines = ranked.map((q, i) => {
  const numberEmoji = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'][i] ?? `${i + 1}.`;
  const displayTotal =
    q.quotedPrice +
    Math.round((q.quotedPrice * config.serviceFeePercent) / 100);
  const priceNaira = (displayTotal / 100).toLocaleString();
  const depositPercent = depositPercentByOfferId.get(q.offerId)!;
  return `${numberEmoji} ₦${priceNaira} · ETA ${q.etaMinutes} min · Deposit ${depositPercent}% · ${q.businessName}`;
});
```
`rankQuotes`'s own ranking logic is untouched — it still ranks by `quotedPrice` only, and nothing about this feature changes sort order.

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn jest src/rescue-request/dispatch.service.spec.ts`
Expected: PASS, including every pre-existing test in this file — the existing shortlist-line assertions (if any assert the exact line string without `Deposit X%`) will need updating to include it; update those assertions to match the new line format rather than loosening them.

- [ ] **Step 5: Full suite, lint, commit**

```bash
yarn jest --silent
yarn eslint "{src,apps,libs,test}/**/*.ts" --max-warnings 527
git add src/rescue-request/dispatch.service.ts src/rescue-request/dispatch.service.spec.ts
git commit -m "Snapshot and display deposit percentage on the quote shortlist"
```

---

### Task 4: `activateAssignedJob` — shared start-of-job activation

**Files:**
- Modify: `src/rescue-request/payment-events.service.ts` (`confirmDeposit`)
- Test: `src/rescue-request/payment-events.service.spec.ts`

**Interfaces:**
- Produces: `PaymentEventsService.activateAssignedJob(rescueRequestId: string): Promise<void>` — consumed by Task 5 (`handleQuoteSelected`'s 0%-deposit branch) and Task 6 (`assignOperator`'s 0%-deposit branch).

Today, `confirmDeposit` is the only place a `DispatchOffer` moves from `SELECTED_PENDING_PAYMENT` to `ACCEPTED` and both parties' WhatsApp sessions move into their on-job states (customer → `REQUEST_CONFIRMED`, operator → `OPERATOR_ON_JOB` with the job's location details) — and it only runs after a real Paystack deposit payment is confirmed. A 0%-deposit job will never have a deposit payment to confirm, so without this extraction, Tasks 5 and 6 would each need their own partial, hand-written copy of this activation — exactly the kind of drift a shared paid-deposit path and a shared 0%-deposit path must not have between them.

**Known future interaction, not handled here:** `docs/superpowers/plans/2026-09-19-non-whatsapp-operator-manual-dispatch.md` describes an operator type that skips the WhatsApp session/message this method sends, in favor of a staff "Call operator" handoff. That plan's 18 tasks were never implemented — grep confirms no `whatsappEnabled` field (or equivalent) exists anywhere in `prisma/schema.prisma` or the rest of this codebase today, and every operator in the real system is currently a WhatsApp operator. `activateAssignedJob` below is written for that real, current state — it does not branch on a field that doesn't exist. If/when that other plan ships, it is the one that should come back and teach this method to skip the operator-side session/message for a non-WhatsApp operator; adding that branch speculatively now, against no real schema field, would be untestable dead code.

- [ ] **Step 1: Write the regression anchor proving the extraction is behavior-preserving**

In `src/rescue-request/payment-events.service.spec.ts`, inside the existing `describe('confirmDeposit', ...)` block (around the three tests that reach the operator-assignment section — "sends the operator the freeform...", "sends the operator a real ARRIVED button...", "assigns the operator and confirms..."), add:
```ts
it('moves the customer session to REQUEST_CONFIRMED as part of the normal paid-deposit activation', async () => {
  prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
    id: 'req-1',
    customerId: 'cust-1',
    assignedOperatorId: 'op-1',
    status: 'WAITING_FOR_DEPOSIT',
    customer: { phoneNumber: '+2341' },
    assignedOperator: { businessName: 'Swift', phoneNumber: '+2342' },
  });

  await service.confirmDeposit(paymentFor('req-1'));

  // This is a new assertion, not a pre-existing one — confirmDeposit's
  // existing tests in this block never checked the session transition
  // directly, only the messages it sends. It exists as a named anchor
  // for the activateAssignedJob extraction below: if this still passes
  // once confirmDeposit delegates to it, the extraction preserved the
  // real behavior.
  expect(sessionStore.update).toHaveBeenCalledWith('cust-1', {
    state: 'REQUEST_CONFIRMED',
  });
});
```

- [ ] **Step 2: Write the failing tests for `activateAssignedJob` as its own method**

In the same spec file, add a new `describe` block:
```ts
describe('activateAssignedJob', () => {
  it('flips a SELECTED_PENDING_PAYMENT offer to ACCEPTED', async () => {
    prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
      id: 'req-1',
      customerId: 'cust-1',
      assignedOperatorId: 'op-1',
      latitude: 6.5,
      longitude: 3.4,
      customer: { phoneNumber: '+2341' },
      assignedOperator: { businessName: 'Swift', phoneNumber: '+2342' },
    });

    await service.activateAssignedJob('req-1');

    expect(prisma.dispatchOffer.updateMany).toHaveBeenCalledWith({
      where: {
        rescueRequestId: 'req-1',
        operatorId: 'op-1',
        status: 'SELECTED_PENDING_PAYMENT',
      },
      data: { status: 'ACCEPTED' },
    });
  });

  it('moves the customer session to REQUEST_CONFIRMED and the operator session to OPERATOR_ON_JOB', async () => {
    prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
      id: 'req-1',
      customerId: 'cust-1',
      assignedOperatorId: 'op-1',
      latitude: 6.5,
      longitude: 3.4,
      customer: { phoneNumber: '+2341' },
      assignedOperator: { businessName: 'Swift', phoneNumber: '+2342' },
    });

    await service.activateAssignedJob('req-1');

    expect(sessionStore.update).toHaveBeenCalledWith('cust-1', {
      state: 'REQUEST_CONFIRMED',
    });
    expect(sessionStore.update).toHaveBeenCalledWith('op-user-1', {
      state: 'OPERATOR_ON_JOB',
      rescueRequestId: 'req-1',
    });
  });

  it('sends the operator their job-is-live details, honoring the ARRIVED template SID the same way confirmDeposit does', async () => {
    prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
      id: 'req-1',
      customerId: 'cust-1',
      assignedOperatorId: 'op-1',
      latitude: 6.5,
      longitude: 3.4,
      customer: { phoneNumber: '+2341' },
      assignedOperator: { businessName: 'Swift', phoneNumber: '+2342' },
    });

    await service.activateAssignedJob('req-1');

    expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
      expect.stringContaining('2342'),
      expect.stringContaining('send *ARRIVED*'),
    );
  });

  it('does nothing when the request has no assigned operator', async () => {
    prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
      id: 'req-1',
      customerId: 'cust-1',
      assignedOperatorId: null,
      assignedOperator: null,
      customer: { phoneNumber: '+2341' },
    });

    await service.activateAssignedJob('req-1');

    expect(sessionStore.update).not.toHaveBeenCalled();
    expect(prisma.dispatchOffer.updateMany).not.toHaveBeenCalled();
  });
});
```
This spec file's shared `beforeEach` already sets `sharedService.findOrCreateCustomer` to resolve `{ id: 'op-user-1' }` and `TWILIO_ARRIVED_PROMPT_TEMPLATE_SID` to be deleted/restored around the `confirmDeposit` block — the new `activateAssignedJob` tests above rely on the same env var being unset (the default state outside that block's own `beforeEach`/`afterEach`), so they get the freeform-message branch; no extra setup needed.

- [ ] **Step 3: Run tests to verify they fail**

Run: `yarn jest src/rescue-request/payment-events.service.spec.ts -t "activateAssignedJob"`
Expected: FAIL — the method doesn't exist yet.

- [ ] **Step 4: Implement**

In `src/rescue-request/payment-events.service.ts`, extract everything from the offer-flip through the operator's job-is-live message (today's `confirmDeposit` tail, roughly lines 156–223) into a new method, and have `confirmDeposit` call it:
```ts
async confirmDeposit(payment: Payment): Promise<void> {
  // ...unchanged through the `if (!operator) { ... return; }` early-return
  // block — nothing above that point changes...

  await this.prisma.rescueRequest.update({
    where: { id: rescueRequest.id },
    data: { status: RescueRequestStatus.OPERATOR_ASSIGNED },
  });

  await this.activateAssignedJob(rescueRequest.id);

  // Customer: confirmed with operator details. The session transition
  // itself now lives in activateAssignedJob — this is only the
  // message, which is worded around an actual payment having landed
  // (the 0%-deposit callers of activateAssignedJob have their own,
  // differently-worded customer message instead).
  if (customerPhone) {
    await this.twilioService.sendWhatsAppMessage(
      customerPhone,
      operator
        ? `✅ *Payment confirmed — operator is on the way!*\n\nBusiness: ${operator.businessName}\nPhone: ${operator.phoneNumber}\n\nVehicle: ${rescueRequest.vehicleType ? formatVehicleType(rescueRequest.vehicleType) : 'Unknown'}\n\nYou'll be notified when they arrive.`
        : `✅ Deposit confirmed! Finding the nearest tow operator...`,
    );
  }
}

/**
 * Everything that happens once a job is confirmed and the operator is
 * actively working it: flips a pending offer to ACCEPTED, moves both
 * parties into their on-job session states, and sends the operator
 * their job-is-live details (customer phone, vehicle, location — the
 * same ARRIVED-button message a paid deposit triggers). Called from
 * confirmDeposit for the normal paid-deposit path, and directly from the
 * 0%-deposit branches in handleQuoteSelected and assignOperator, which
 * skip payment entirely but still need the same activation — this
 * stands in for "payment confirmed" when there was never a payment to
 * confirm. Fetches its own data rather than trusting a caller-provided
 * object, since the three callers have differently-shaped data at their
 * own call sites (same rationale as finalizeJobSettlement, Task 7).
 *
 * Deliberately does NOT send anything to the customer or touch
 * RescueRequest.status — those differ by caller (confirmDeposit's
 * customer message references the payment; the 0%-deposit callers have
 * no payment to reference, and have already set status inside their own
 * transaction) and stay with each caller.
 */
async activateAssignedJob(rescueRequestId: string): Promise<void> {
  const rescueRequest = await this.prisma.rescueRequest.findUniqueOrThrow({
    where: { id: rescueRequestId },
    include: { customer: true, assignedOperator: true },
  });
  const operator = rescueRequest.assignedOperator;
  if (!operator) return;

  if (rescueRequest.assignedOperatorId) {
    await this.prisma.dispatchOffer.updateMany({
      where: {
        rescueRequestId: rescueRequest.id,
        operatorId: rescueRequest.assignedOperatorId,
        status: 'SELECTED_PENDING_PAYMENT',
      },
      data: { status: 'ACCEPTED' },
    });
  }

  await this.sessionStore.update(rescueRequest.customerId, {
    state: WhatsAppFlowState.REQUEST_CONFIRMED,
  });

  const opUser = await this.sharedService.findOrCreateCustomer(
    operator.phoneNumber!,
  );
  await this.sessionStore.update(opUser.id, {
    state: WhatsAppFlowState.OPERATOR_ON_JOB,
    rescueRequestId: rescueRequest.id,
  });
  const lat = Number(rescueRequest.latitude);
  const lon = Number(rescueRequest.longitude);
  const locationSection = await this.sharedService.formatLocationSection(
    lat,
    lon,
  );
  const customerPhone = rescueRequest.customer?.phoneNumber ?? 'N/A';
  const operatorPhone = toWhatsAppAddress(operator.phoneNumber!);
  const vehicleLine = rescueRequest.vehicleType
    ? formatVehicleType(rescueRequest.vehicleType)
    : 'Unknown';
  // This is a quick-reply (ARRIVED) template sent inside an active
  // session with the operator — no Meta approval needed. Whoever
  // created `arrived_prompt` in the Twilio console declared exactly
  // these 4 variables, in this order.
  const arrivedTemplateSid = process.env.TWILIO_ARRIVED_PROMPT_TEMPLATE_SID;
  if (arrivedTemplateSid) {
    await this.twilioService.sendWhatsAppTemplateMessage(
      operatorPhone,
      arrivedTemplateSid,
      {
        '1': formatJobRef(rescueRequest.id),
        '2': customerPhone,
        '3': vehicleLine,
        '4': locationSection,
      },
    );
  } else {
    await this.twilioService.sendWhatsAppMessage(
      operatorPhone,
      `🚗 *Job is live!* — ${formatJobRef(rescueRequest.id)}\n\nCustomer: ${customerPhone}\nVehicle: ${vehicleLine}\nLocation: ${locationSection}\n\nHead over now and send *ARRIVED* when you reach them.`,
    );
  }
}
```
The freeform operator message's wording changed from "💰 *Payment confirmed — job is live!*" to "🚗 *Job is live!*" — the old wording is factually wrong for the two 0%-deposit callers (there was no payment), and no existing test pins the exact phrase (the existing assertion only checks for the substring `'send *ARRIVED*'`, which is unchanged).

- [ ] **Step 5: Run tests to verify they pass**

Run: `yarn jest src/rescue-request/payment-events.service.spec.ts`
Expected: PASS, including every pre-existing test in the `confirmDeposit` block — especially the three tests that reach the operator-assignment section, which must remain green now that `confirmDeposit` delegates to `activateAssignedJob` for a second, separate call to `prisma.rescueRequest.findUniqueOrThrow` (the mock returns the same object both times via `mockResolvedValue`, so this is safe).

- [ ] **Step 6: Full suite, lint, commit**

```bash
yarn jest --silent
yarn eslint "{src,apps,libs,test}/**/*.ts" --max-warnings 527
git add src/rescue-request/payment-events.service.ts src/rescue-request/payment-events.service.spec.ts
git commit -m "Extract activateAssignedJob from confirmDeposit for 0%-deposit reuse"
```

---

### Task 5: `handleQuoteSelected` — read the snapshot, handle 0% deposit

**Files:**
- Modify: `src/rescue-request/whatsapp-customer-flow.service.ts:900-1130` (`handleQuoteSelected`)
- Test: `src/rescue-request/whatsapp-customer-flow.service.spec.ts`

**Interfaces:**
- Consumes: `DispatchOffer.depositPercentSnapshot` (Task 1, written by Task 3), `PaymentEventsService.activateAssignedJob(rescueRequestId: string): Promise<void>` (Task 4 — already injected here as `this.paymentEventsService`, via `forwardRef`, since `markJobCompleted` is already called the same way from this file).
- Produces: nothing new consumed by later tasks — this is a terminal calculation site.

- [ ] **Step 1: Read the current full method**

Run: `sed -n '900,1130p' src/rescue-request/whatsapp-customer-flow.service.ts` to confirm exact current line numbers before editing (other tasks in between may have shifted them from this plan's research snapshot).

- [ ] **Step 2: Write the failing tests**

In `src/rescue-request/whatsapp-customer-flow.service.spec.ts`, find the existing `describe` block covering `handleQuoteSelected` (the quote-selection flow) and add, matching its established mock shape exactly — this file's `paymentEventsService` mock already exists (it's how `markJobCompleted` is tested elsewhere in this file); add `activateAssignedJob: jest.fn()` to that same mock object if it isn't already there:
```ts
it('charges the snapshotted percentage, not the operator\'s current setting', async () => {
  // Reuse this block's existing happy-path setup, but with the selected
  // offer carrying a depositPercentSnapshot that differs from what the
  // operator's live depositPercentOverride would resolve to now — proves
  // the snapshot wins.
  const dto = {
    /* ...existing quotedOffers fixture shape, with... */
  };
  // selectedOffer.depositPercentSnapshot: 20
  // operator's current depositPercentOverride (not read at all): 50

  await service['handleQuoteSelected']('+2348000000000', 'user-1', 1);

  expect(prisma.rescueRequest.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        depositAmount: expect.any(Number), // computed from 20%, not 50%
      }),
    }),
  );
});

it('skips the Paystack deposit step and activates the job directly when the snapshot resolves to 0%', async () => {
  // Same setup, but selectedOffer.depositPercentSnapshot: 0.
  await service['handleQuoteSelected']('+2348000000000', 'user-1', 1);

  expect(prisma.rescueRequest.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        status: 'OPERATOR_ASSIGNED',
        depositAmount: 0,
      }),
    }),
  );
  expect(paymentEventsService.activateAssignedJob).toHaveBeenCalledWith('req-1');
  expect(paymentLedger.create).not.toHaveBeenCalled();
  expect(paystackService.initializePayment).not.toHaveBeenCalled();
  // The customer's session must NOT be left at OPERATOR_FOUND_WAITING_PAYMENT
  // — there is no payment link coming, so a later message from the
  // customer must not be met with "please pay using the link we sent you".
  expect(sessionStore.update).not.toHaveBeenCalledWith(
    'user-1',
    expect.objectContaining({ state: 'OPERATOR_FOUND_WAITING_PAYMENT' }),
  );
});

it('rounds a very small total at a nonzero percentage down to the 0%-deposit branch', async () => {
  // A total small enough that Math.round((total * percent) / 100) === 0
  // even though the snapshot itself is not literally 0 — e.g. a ₦40 total
  // (4000 kobo) at 1%: Math.round(4000 * 1 / 100) = 40, NOT 0 — pick a
  // genuinely rounding-to-zero combination instead, e.g. total = 40 kobo
  // at depositPercentSnapshot: 1 → Math.round(40 * 1 / 100) = 0.
  // Confirm this still takes the 0%-deposit branch (status straight to
  // OPERATOR_ASSIGNED, no Payment row, activateAssignedJob called),
  // proving the branch keys off the computed depositAmount, not the
  // stored percentage.
});
```
This file's existing `handleQuoteSelected` tests already establish the full mock shape needed (`prisma.rescueRequest`, `prisma.dispatchOffer`, `prisma.user`, `prisma.operator`, `paymentLedger`, `paystackService`, `twilioService`, `sessionStore`, `paymentEventsService`) — find that block and copy its setup exactly rather than inventing a different one. The third test's exact numbers need to be worked out against whatever `serviceFeePercent`/quote price the existing fixture already uses — pick a `quotedPrice` and `depositPercentSnapshot` combination where `Math.round((total * depositPercent) / 100)` genuinely equals 0 with the fixture's real `serviceFeePercent`, not a guessed one.

- [ ] **Step 3: Run tests to verify they fail**

Run: `yarn jest src/rescue-request/whatsapp-customer-flow.service.spec.ts -t "deposit"`
Expected: FAIL — the method doesn't read the snapshot yet, and has no 0%-deposit branch.

- [ ] **Step 4: Implement**

In `handleQuoteSelected`, change the deposit calculation:
```ts
const depositPercent = Number(
  selectedOffer.depositPercentSnapshot ?? config.depositPercent,
);
const depositAmount = Math.round((total * depositPercent) / 100);
const balanceAmount = total - depositAmount;
```
(The `?? config.depositPercent` fallback is defensive — `deliverQuoteShortlist`, Task 3, always populates the snapshot in the normal flow. This is not a second live-resolution path; it only matters for a snapshot that should never actually be missing.)

The existing `$transaction` needs the `claimed` update and the `dispatchOffer.update` to branch on `depositAmount === 0`:
```ts
const claimed = await tx.rescueRequest.updateMany({
  where: {
    id: rescueRequestId,
    status: RescueRequestStatus.DISPATCHING,
  },
  data: {
    status:
      depositAmount === 0
        ? RescueRequestStatus.OPERATOR_ASSIGNED
        : RescueRequestStatus.WAITING_FOR_DEPOSIT,
    serviceFeeAmount,
    depositAmount,
    balanceAmount,
    assignedOperatorId: selected.operatorId,
    ...(depositAmount === 0
      ? {}
      : {
          depositWindowExpiresAt: new Date(Date.now() + DEPOSIT_WINDOW_MS),
          depositRemindersSent: 0,
        }),
  },
});
if (claimed.count === 0) {
  throw new BadRequestException('This request has already moved on.');
}

await tx.dispatchOffer.update({
  where: { id: selectedOffer.id },
  data: {
    status:
      depositAmount === 0
        ? 'ACCEPTED'
        : 'SELECTED_PENDING_PAYMENT',
    respondedAt: new Date(),
  },
});
await tx.dispatchOffer.updateMany({
  where: {
    rescueRequestId,
    status: 'QUOTED',
    id: { not: selectedOffer.id },
  },
  data: { status: 'NOT_SELECTED', respondedAt: new Date() },
});
await tx.dispatchOffer.updateMany({
  where: { rescueRequestId, status: 'PENDING' },
  data: { status: 'TIMED_OUT', respondedAt: new Date() },
});

if (depositAmount === 0) {
  return null; // signal: nothing to pay, no Payment row created
}

return this.paymentLedger.create({
  rescueRequestId,
  type: 'DEPOSIT',
  amount: depositAmount,
  tx,
});
```
After the transaction resolves (`payment` is `null` for the 0%-deposit branch, a real `Payment` otherwise), the "notify losing operators" step stays unconditional — it has nothing to do with deposit amount. The session-state update and everything after it must branch, because the existing code unconditionally moved the customer into `OPERATOR_FOUND_WAITING_PAYMENT` — correct when a payment link is about to be sent, wrong when one never will be:
```ts
// Notify the operators who weren't picked — independent of deposit amount.
await Promise.all(
  quotedOffers
    .filter((o) => o.id !== selectedOffer.id)
    .map((o) =>
      this.twilioService.sendWhatsAppMessage(
        toWhatsAppAddress(o.operator.phoneNumber!),
        `Sorry, the customer chose another quote — thanks for bidding!`,
      ),
    ),
);

const operator = selectedOffer.operator;

if (depositAmount === 0) {
  // No deposit to collect — the transaction above already set
  // OPERATOR_ASSIGNED directly. Run the same activation a paid deposit
  // would trigger (offer → ACCEPTED, both sessions moved to their
  // on-job states, operator gets their job-is-live message) instead of
  // leaving the customer's session at OPERATOR_FOUND_WAITING_PAYMENT —
  // that state makes later messages get "please pay using the link we
  // sent you", which would be a lie here.
  await this.paymentEventsService.activateAssignedJob(rescueRequestId);
  await this.twilioService.sendWhatsAppMessage(
    phoneNumber,
    `✅ *Operator confirmed!*\n\nBusiness: ${operator.businessName}\n\nNo deposit required — you'll pay the full ₦${(total / 100).toLocaleString()} once the job is complete.`,
  );
  return this.xmlOk();
}

await this.sessionStore.update(userId, {
  state: WhatsAppFlowState.OPERATOR_FOUND_WAITING_PAYMENT,
});

// The protocol, as in initiateDeposit: commit, claim, call, classify.
if (
  !(await this.paymentLedger.claimForSubmission(payment!.id, new Date()))
) {
  return this.reply(
    `We're setting up your payment — you'll get a link shortly.`,
  );
}
// ...rest of the existing Paystack block, unchanged...
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `yarn jest src/rescue-request/whatsapp-customer-flow.service.spec.ts`
Expected: PASS, including every pre-existing test — the non-zero-deposit path must be completely behavior-preserving (the `OPERATOR_FOUND_WAITING_PAYMENT` transition still happens for it, just moved a few lines down, still unconditionally reached before the Paystack block).

- [ ] **Step 6: Full suite, lint, commit**

```bash
yarn jest --silent
yarn eslint "{src,apps,libs,test}/**/*.ts" --max-warnings 527
git add src/rescue-request/whatsapp-customer-flow.service.ts src/rescue-request/whatsapp-customer-flow.service.spec.ts
git commit -m "Read the frozen deposit snapshot at quote selection, handle 0% deposit"
```

---

### Task 6: `assignOperator` — live-resolve the override, handle 0% deposit

**Files:**
- Modify: `src/rescue-request/rescue-request-admin.service.ts:128-330` (`assignOperator`)
- Test: `src/rescue-request/rescue-request-admin.service.spec.ts`

**Interfaces:**
- Consumes: `Operator.depositPercentOverride` (Task 1), `PaymentEventsService.activateAssignedJob(rescueRequestId: string): Promise<void>` (Task 4 — already injected here as `this.paymentEventsService`, no `forwardRef` needed, unlike the customer-flow service).
- Produces: nothing new consumed by later tasks.

- [ ] **Step 1: Read the current full method**

Run: `sed -n '128,330p' src/rescue-request/rescue-request-admin.service.ts` to confirm exact current line numbers before editing.

- [ ] **Step 2: Write the failing tests**

In `src/rescue-request/rescue-request-admin.service.spec.ts`, find the existing `describe('assignOperator', ...)` block and add, matching its established mock shape — this file's `paymentEventsService` mock already exists (`markJobCompleted` is tested the same way elsewhere in this file); add `activateAssignedJob: jest.fn()` to it if not already present:
```ts
it('charges the operator\'s current override percentage, not the platform default', async () => {
  prisma.operator.findUnique.mockResolvedValue({
    id: 'op-1',
    status: 'ACTIVE',
    businessName: 'Swift Towing',
    phoneNumber: '+2348011111111',
    depositPercentOverride: 30,
  });
  // ...rest of this block's existing happy-path mocks...

  await service.assignOperator('req-1', { operatorId: 'op-1', priceKobo: 500000 });

  // depositAmount should reflect 30%, not whatever the platform default is
  expect(prisma.rescueRequest.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({ depositAmount: expect.any(Number) }),
    }),
  );
});

it('creates the offer as ACCEPTED (not SELECTED_PENDING_PAYMENT) and activates the job when the override resolves to 0%', async () => {
  prisma.operator.findUnique.mockResolvedValue({
    id: 'op-1',
    status: 'ACTIVE',
    businessName: 'Swift Towing',
    phoneNumber: '+2348011111111',
    depositPercentOverride: 0,
  });
  // ...rest of this block's existing happy-path mocks...

  await service.assignOperator('req-1', { operatorId: 'op-1', priceKobo: 500000 });

  expect(prisma.rescueRequest.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        status: 'OPERATOR_ASSIGNED',
        depositAmount: 0,
      }),
    }),
  );
  expect(prisma.dispatchOffer.create).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({ status: 'ACCEPTED' }),
    }),
  );
  expect(paymentEventsService.activateAssignedJob).toHaveBeenCalledWith('req-1');
  expect(paymentLedger.create).not.toHaveBeenCalled();
  expect(paystackService.initializePayment).not.toHaveBeenCalled();
});
```
Copy this block's existing established mock shape for the happy path (request lookup, `paymentLedger`, `paystackService`, `twilioService`) rather than inventing a different one — these two tests only change `operator.findUnique`'s `depositPercentOverride` field.

- [ ] **Step 3: Run tests to verify they fail**

Run: `yarn jest src/rescue-request/rescue-request-admin.service.spec.ts -t "deposit"`
Expected: FAIL — the method always reads `config.depositPercent` today, with no 0%-deposit branch.

- [ ] **Step 4: Implement**

In `assignOperator`, change:
```ts
const depositPercent = Number(
  operator.depositPercentOverride ?? config.depositPercent,
);
const depositAmount = Math.round((total * depositPercent) / 100);
const balanceAmount = total - depositAmount;
```
Inside the existing `$transaction`, branch both the `claimed` update's status and the new offer's initial status — unlike `handleQuoteSelected`, this offer doesn't pre-exist, so the 0%-branch can create it as `ACCEPTED` directly rather than creating-then-flipping:
```ts
const claimed = await tx.rescueRequest.updateMany({
  where: {
    id,
    status: request.status,
    assignedOperatorId: request.assignedOperatorId,
  },
  data: {
    assignedOperatorId: dto.operatorId,
    status:
      depositAmount === 0
        ? RescueRequestStatus.OPERATOR_ASSIGNED
        : RescueRequestStatus.WAITING_FOR_DEPOSIT,
    serviceFeeAmount,
    depositAmount,
    balanceAmount,
    ...(depositAmount === 0
      ? {}
      : { depositWindowExpiresAt, depositRemindersSent: 0 }),
  },
});
if (claimed.count === 0) {
  throw new BadRequestException(
    'This request has already been assigned or moved on.',
  );
}

await tx.dispatchOffer.create({
  data: {
    rescueRequestId: id,
    operatorId: dto.operatorId,
    status: depositAmount === 0 ? 'ACCEPTED' : 'SELECTED_PENDING_PAYMENT',
    quotedPrice: dto.priceKobo,
    respondedAt: new Date(),
    expiresAt: new Date(Date.now() + MANUAL_ASSIGN_WINDOW_MS),
    batchId,
    dispatchRound: request.dispatchRound,
  },
});

if (depositAmount === 0) {
  return null; // signal: nothing to pay
}

return this.paymentLedger.create({
  rescueRequestId: id,
  type: 'DEPOSIT',
  amount: depositAmount,
  tx,
});
```
After the transaction (`payment` is `null` for the 0%-deposit branch), branch before the existing `claimForSubmission`/Paystack block:
```ts
if (depositAmount === 0) {
  // The offer was already created as ACCEPTED above, so
  // activateAssignedJob's own offer-flip is a no-op here — it's still
  // the thing that moves both sessions into their on-job states and
  // sends the operator their job-is-live message, same as a paid
  // deposit would.
  await this.paymentEventsService.activateAssignedJob(id);

  const updated = await this.prisma.rescueRequest.findUniqueOrThrow({
    where: { id },
    include: {
      customer: true,
      assignedOperator: true,
      payments: { select: { id: true, type: true, status: true } },
    },
  });

  const customerPhone = toWhatsAppAddress(request.customer.phoneNumber!);
  void this.twilioService.sendWhatsAppMessage(
    customerPhone,
    `🚗 *Operator assigned!*\n\nBusiness: ${operator.businessName}\n\nNo deposit required — you'll pay the full ₦${(total / 100).toLocaleString()} once the job is complete.`,
  );

  return { data: this.mapToDetailDto(updated, true) };
}

if (
  !(await this.paymentLedger.claimForSubmission(payment.id, new Date()))
) {
  throw new BadRequestException(
    `A deposit is already being set up for this request`,
  );
}
// ...rest of the existing Paystack block, unchanged...
```
Match this method's own existing message wording/style for the 0%-branch customer message (check what's actually there before finalizing it) — the snippet above mirrors the existing non-zero-deposit customer message's "🚗 *Operator assigned!*" framing, just without the deposit/payment-link lines.

- [ ] **Step 5: Run tests to verify they pass**

Run: `yarn jest src/rescue-request/rescue-request-admin.service.spec.ts`
Expected: PASS, including every pre-existing test.

- [ ] **Step 6: Full suite, lint, commit**

```bash
yarn jest --silent
yarn eslint "{src,apps,libs,test}/**/*.ts" --max-warnings 527
git add src/rescue-request/rescue-request-admin.service.ts src/rescue-request/rescue-request-admin.service.spec.ts
git commit -m "Resolve the operator's live deposit override in assignOperator, handle 0%"
```

---

### Task 7: `finalizeJobSettlement` — the symmetric 100%-deposit (₦0 balance) case

**Files:**
- Modify: `src/rescue-request/payment-events.service.ts` (`confirmBalance`, `sendBalancePaymentLink`)
- Test: `src/rescue-request/payment-events.service.spec.ts`

**Interfaces:**
- Produces: `PaymentEventsService.finalizeJobSettlement(rescueRequestId: string): Promise<void>` — not consumed by any other task in this plan, but is the single place both `markJobCompleted` (via `sendBalancePaymentLink`) and `DisputeService.resolveDispute` (also via `sendBalancePaymentLink`) get correct 100%-deposit behavior, with zero changes needed in either of those two callers.

- [ ] **Step 1: Write the regression test proving the extraction is behavior-preserving**

In `src/rescue-request/payment-events.service.spec.ts`, inside the existing `describe('confirmBalance — payout trigger', ...)` block (uses the existing `BALANCE_REQUEST_FIXTURE`), add:
```ts
it('is equivalent to finalizeJobSettlement for the ordinary non-zero-balance case', async () => {
  await service.confirmBalance(paymentFor('req-1'));

  // Every existing assertion in this describe block already proves
  // confirmBalance's observable behavior (status update, payout trigger,
  // customer/operator notifications, rating-prompt sessions, relay
  // release) — this test exists as a named anchor for the extraction
  // described in this task, not new behavior. If every other test in
  // this block still passes after confirmBalance becomes a one-line
  // wrapper around finalizeJobSettlement, this one needs no body beyond
  // confirming the call doesn't throw.
  expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
    where: { id: 'req-1' },
    data: { status: 'COMPLETED' },
  });
});
```

- [ ] **Step 2: Write the failing tests for the 100%-deposit branch**

In `src/rescue-request/payment-events.service.spec.ts`, add a new `describe` block:
```ts
describe('sendBalancePaymentLink — balanceAmount === 0 (100% deposit)', () => {
  const ZERO_BALANCE_TARGET = {
    id: 'req-1',
    customerId: 'cust-1',
    balanceAmount: 0,
    customer: { phoneNumber: '+2348012345678', email: null },
  };

  it('finalizes the job settlement instead of attempting a Paystack call', async () => {
    const paystackService = { initializePayment: jest.fn() };
    (service as any).paystackService = paystackService;
    prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
      id: 'req-1',
      customerId: 'cust-1',
      balanceAmount: 0,
      depositAmount: 500000,
      serviceFeeAmount: 25000,
      assignedOperatorId: 'op-1',
      customer: { phoneNumber: '+2348012345678' },
      assignedOperator: {
        id: 'op-1',
        businessName: 'Swift Towing',
        phoneNumber: '+2349012345678',
      },
    });

    await service.sendBalancePaymentLink(ZERO_BALANCE_TARGET);

    expect(paystackService.initializePayment).not.toHaveBeenCalled();
    expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
      where: { id: 'req-1' },
      data: { status: 'COMPLETED' },
    });
  });

  it('still triggers the payout — same formula as a real settled balance', async () => {
    prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
      id: 'req-1',
      customerId: 'cust-1',
      balanceAmount: 0,
      depositAmount: 500000,
      serviceFeeAmount: 25000,
      assignedOperatorId: 'op-1',
      customer: { phoneNumber: '+2348012345678' },
      assignedOperator: {
        id: 'op-1',
        businessName: 'Swift Towing',
        phoneNumber: '+2349012345678',
      },
    });

    await service.sendBalancePaymentLink(ZERO_BALANCE_TARGET);

    expect(payoutServiceMock.createAndProcessPayout).toHaveBeenCalledWith(
      'req-1',
      'op-1',
      475000, // depositAmount(500000) + balanceAmount(0) - serviceFeeAmount(25000)
    );
  });

  it('does not fire the "missing balanceAmount" Sentry error for a legitimate zero', async () => {
    prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
      id: 'req-1',
      customerId: 'cust-1',
      balanceAmount: 0,
      depositAmount: 500000,
      serviceFeeAmount: 25000,
      assignedOperatorId: 'op-1',
      customer: { phoneNumber: '+2348012345678' },
      assignedOperator: {
        id: 'op-1',
        businessName: 'Swift Towing',
        phoneNumber: '+2349012345678',
      },
    });

    await service.sendBalancePaymentLink(ZERO_BALANCE_TARGET);

    expect(Sentry.captureMessage).not.toHaveBeenCalledWith(
      expect.stringContaining('missing balanceAmount'),
      expect.anything(),
    );
  });

  it('still treats a genuinely missing (null) balanceAmount as the existing error case', async () => {
    await service.sendBalancePaymentLink({
      ...ZERO_BALANCE_TARGET,
      balanceAmount: null,
    });

    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('missing balanceAmount'),
      'error',
    );
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `yarn jest src/rescue-request/payment-events.service.spec.ts -t "balanceAmount === 0"`
Expected: FAIL — `sendBalancePaymentLink` currently treats `balanceAmount: 0` identically to `null`.

- [ ] **Step 4: Implement**

In `src/rescue-request/payment-events.service.ts`, extract `confirmBalance`'s body into a new method, then make `confirmBalance` a thin wrapper:
```ts
async confirmBalance(payment: Payment): Promise<void> {
  return this.finalizeJobSettlement(payment.rescueRequestId);
}

/**
 * Everything that happens once a job's balance is actually settled —
 * status, chat relay, customer/operator notifications and rating
 * prompts, payout. Called from confirmBalance (a real BALANCE Payment
 * settled via the Paystack webhook) and from sendBalancePaymentLink
 * below (a 100%-deposit job, where balanceAmount is legitimately 0 and
 * no Payment row is ever created) — fetches its own data rather than
 * trusting a caller-provided object, since the two callers have access
 * to structurally different things (see BalancePaymentTarget's own
 * comment for why that type deliberately excludes assignedOperator).
 */
async finalizeJobSettlement(rescueRequestId: string): Promise<void> {
  const rescueRequest = await this.prisma.rescueRequest.findUniqueOrThrow({
    where: { id: rescueRequestId },
    include: { customer: true, assignedOperator: true },
  });

  // ...the entire existing body of confirmBalance, unchanged, from
  // "Unconditional, not a claim..." through the final console.log...
}
```
In `sendBalancePaymentLink`, split the existing `if (!balanceAmount)` guard into two cases:
```ts
async sendBalancePaymentLink(rescueRequest: BalancePaymentTarget) {
  const customerPhone = rescueRequest.customer.phoneNumber;
  if (!customerPhone) return;

  const balanceAmount = rescueRequest.balanceAmount;
  if (balanceAmount == null) {
    console.error(
      'No balanceAmount persisted for rescue request:',
      rescueRequest.id,
    );
    Sentry.captureMessage(
      `sendBalancePaymentLink: missing balanceAmount for ${rescueRequest.id}`,
      'error',
    );
    return;
  }
  if (balanceAmount === 0) {
    // 100% deposit — there is no balance to collect. Run the same
    // settlement finalization a real balance payment would trigger,
    // instead of ever attempting a ₦0 Paystack charge.
    await this.finalizeJobSettlement(rescueRequest.id);
    return;
  }

  // ...rest of the existing method, unchanged, starting from the
  // "The same protocol as the deposit paths..." comment...
}
```
Neither `markJobCompleted` nor `DisputeService.resolveDispute` need any changes — both already call `sendBalancePaymentLink`, and the branch above is reached automatically regardless of which one called it.

- [ ] **Step 5: Run tests to verify they pass**

Run: `yarn jest src/rescue-request/payment-events.service.spec.ts`
Expected: PASS, including every pre-existing test in this file — especially everything in `describe('confirmBalance — payout trigger', ...)`, which must remain byte-for-byte unchanged in behavior now that it's a wrapper.

Run: `yarn jest src/rescue-request/dispute.service.spec.ts`
Expected: PASS unchanged — `DisputeService`'s own tests mock `sendBalancePaymentLink` away entirely and assert only that it's called with the right arguments, so they need no changes for this task; this run is to confirm that's actually true, not to add new coverage there.

- [ ] **Step 6: Full suite, lint, commit**

```bash
yarn jest --silent
yarn eslint "{src,apps,libs,test}/**/*.ts" --max-warnings 527
git add src/rescue-request/payment-events.service.ts src/rescue-request/payment-events.service.spec.ts
git commit -m "Extract finalizeJobSettlement, handle 100%-deposit (zero balance) jobs"
```

---

### Task 8: lrr-web — staff-side deposit % field

**Files:**
- Modify: `app/hooks/useOperatorApi.ts`
- Modify: `app/components/tabs/OperatorsTab.tsx` (`StatsModal`)
- Modify: `app/components/tabs/OperatorsTab.tsx` (`OnboardOperatorModal`, same file as `StatsModal`)

**Interfaces:**
- Consumes: `PATCH /operators/:id/deposit-percent` (Task 2).

- [ ] **Step 1: Add the API method and type**

In `app/hooks/useOperatorApi.ts`, add `depositPercentOverride: number | string | null` to the `Operator` interface (matching the existing `latitude: number | string` convention — this field is a Prisma `Decimal` serialized over JSON the same way), and add a new method near `saveBankDetails`:
```ts
const setDepositPercent = useCallback(async (
  id: string,
  depositPercentOverride: number | null,
): Promise<Operator> => {
  setLoading(true);
  setError(null);
  try {
    const res = await apiFetch(`/operators/${id}/deposit-percent`, {
      method:  "PATCH",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ depositPercentOverride }),
    });
    const updated = res.data as Operator;
    setOperators((prev) => prev.map((op) => (op.id === id ? { ...op, ...updated } : op)));
    return updated;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to update deposit percentage";
    setError(msg);
    throw err;
  } finally {
    setLoading(false);
  }
}, []);
```
Add `setDepositPercent` to the hook's returned object, grouped with `saveBankDetails`/`clearBankDetails`.

- [ ] **Step 2: Add the field to `StatsModal`**

In `app/components/tabs/OperatorsTab.tsx`, `StatsModal` needs a new prop `onSetDepositPercent: (depositPercentOverride: number | null) => Promise<void>`, following the exact pattern already used for `onSetIsTest`. Add state and a field in the "Details" tab (near the address/radius editable fields), matching that section's existing inline-edit style:
```tsx
const [editingDeposit, setEditingDeposit] = useState(false);
const [depositValue, setDepositValue] = useState('');
const [savingDeposit, setSavingDeposit] = useState(false);
const [depositMsg, setDepositMsg] = useState<{ msg: string; ok: boolean } | null>(null);

async function handleSaveDeposit() {
  const trimmed = depositValue.trim();
  const n = trimmed === '' ? null : Number(trimmed);
  if (n !== null && (Number.isNaN(n) || n < 0 || n > 100)) {
    setDepositMsg({ msg: 'Enter a number between 0 and 100, or leave blank for the platform default.', ok: false });
    return;
  }
  setSavingDeposit(true);
  setDepositMsg(null);
  try {
    await onSetDepositPercent(n);
    setDepositMsg({ msg: 'Deposit percentage updated.', ok: true });
    setEditingDeposit(false);
  } catch (err) {
    setDepositMsg({ msg: err instanceof Error ? err.message : 'Failed to update deposit percentage', ok: false });
  } finally {
    setSavingDeposit(false);
  }
}
```
Render block (placed in the same info-grid area as address/radius):
```tsx
<div>
  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
    <p style={{ margin: "0 0 2px 0", fontSize: "0.76rem", color: "#9ca3af", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.03em" }}>Deposit %</p>
    {!editingDeposit && (
      <button onClick={() => { setDepositValue(operator.depositPercentOverride != null ? String(Number(operator.depositPercentOverride)) : ''); setDepositMsg(null); setEditingDeposit(true); }} aria-label="Edit deposit percentage" style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 24, height: 24, background: "none", border: "none", color: "#003DB4", cursor: "pointer" }}>
        <Pencil size={13} />
      </button>
    )}
  </div>
  {editingDeposit ? (
    <div>
      <input type="number" min={0} max={100} value={depositValue} onChange={(e) => setDepositValue(e.target.value)} placeholder="Platform default" style={{ width: "100%", padding: "0.5rem 0.6rem", borderRadius: 7, border: "1px solid #dde8f8", boxSizing: "border-box", fontSize: "0.9rem" }} />
      <div style={{ marginTop: 6, display: "flex", gap: 8 }}>
        <button onClick={handleSaveDeposit} disabled={savingDeposit} style={{ padding: "0.35rem 0.8rem", background: "#003DB4", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: "0.82rem", fontWeight: 600 }}>{savingDeposit ? 'Saving…' : 'Save'}</button>
        <button onClick={() => setEditingDeposit(false)} style={{ padding: "0.35rem 0.8rem", background: "#F6FAFF", color: "#003DB4", border: "1px solid #003DB4", borderRadius: 6, cursor: "pointer", fontSize: "0.82rem", fontWeight: 600 }}>Cancel</button>
      </div>
    </div>
  ) : (
    <p style={{ margin: 0, fontSize: "0.95rem" }}>
      {operator.depositPercentOverride != null
        ? `${Number(operator.depositPercentOverride)}%`
        : `Using platform default (${platformDefaultDepositPercent}%)`}
    </p>
  )}
  {depositMsg && (
    <p style={{ margin: "0.4rem 0 0", fontSize: "0.82rem", fontWeight: 600, color: depositMsg.ok ? "#19a56b" : "#dc2626" }}>{depositMsg.msg}</p>
  )}
</div>
```
`StatsModal` needs a new prop, `platformDefaultDepositPercent: number`, so the "using platform default" line shows the real current value, never a hardcoded assumption — the parent `OperatorsTab` component already fetches platform settings elsewhere in the app (check `PlatformSettingsTab.tsx`'s own fetch for the established hook/endpoint and reuse it rather than adding a second way to read the same setting) and should pass it down.

- [ ] **Step 3: Wire the prop through from `OperatorsTab`**

In `OperatorsTab`'s own component (where `StatsModal` is rendered, near the other `onSet*`/`onUpdate*` props), add:
```tsx
onSetDepositPercent={async (depositPercentOverride) => {
  const updated = await setDepositPercent(selectedOp.id, depositPercentOverride);
  setSelectedOp(updated);
}}
platformDefaultDepositPercent={platformDefaultDepositPercent}
```
Destructure `setDepositPercent` from `useOperatorApi()` at the top of `OperatorsTab`, alongside the hook's other existing destructured methods. Fetch `platformDefaultDepositPercent` the same way `PlatformSettingsTab.tsx` already does, in `OperatorsTab`'s own `useEffect` alongside its existing `fetchAll`/`fetchAllStats`/`fetchBanks` calls.

- [ ] **Step 4: Add the optional field to `OnboardOperatorModal`**

In the same file's `OnboardOperatorModal`, add a `depositPercent` field to its form state (default empty string, meaning "use platform default"), include it in the `onCreate` payload only when non-empty:
```tsx
const [depositPercent, setDepositPercent] = useState('');
```
In the payload construction:
```tsx
...(depositPercent.trim() !== '' && { depositPercentOverride: Number(depositPercent) }),
```
This requires `AdminCreateOperatorPayload` (in `useOperatorApi.ts`) to gain an optional `depositPercentOverride?: number` field, and the backend's `AdminCreateOperatorDto`/`OperatorService.adminCreate` (confirmed real and already shipped, at `src/operator/operator.service.ts:316`) to accept, validate, and persist it.

In `src/operator/dto/admin-create-operator.dto.ts`, add the optional field (decorators here are documentation only, same gap as everywhere else in this plan — `adminCreate` already validates its other fields by hand, e.g. `truckClasses`, rather than trusting decorators):
```ts
export class AdminCreateOperatorDto {
  // ...existing fields...
  depositPercentOverride?: number | null;
}
```
In `OperatorService.adminCreate` (`src/operator/operator.service.ts`), add the same runtime check `setDepositPercent` (Task 2) uses — this field reaches the method exactly the way any other JSON body field does, with no global `ValidationPipe` to catch a wrong type before it gets here:
```ts
if (
  data.depositPercentOverride !== undefined &&
  data.depositPercentOverride !== null &&
  (typeof data.depositPercentOverride !== 'number' ||
    !Number.isFinite(data.depositPercentOverride) ||
    data.depositPercentOverride < 0 ||
    data.depositPercentOverride > 100)
) {
  throw new BadRequestException(
    'depositPercentOverride must be between 0 and 100',
  );
}
```
Place this alongside the existing `truckClasses` validation near the top of the method, before any database calls. Then pass it through in the `tx.operator.create({ data: { ... } })` call:
```ts
depositPercentOverride: data.depositPercentOverride ?? null,
```
Add tests to `src/operator/operator.service.spec.ts`'s existing `describe('adminCreate', ...)` block: one asserting `depositPercentOverride: 0` is accepted and persisted (not treated as "not provided" — same falsy-bug class as everywhere else in this plan), one for `101` being rejected, and one for a non-numeric value (e.g. a string) being rejected, matching Task 2's equivalent tests.

If `adminCreate` didn't exist yet in this codebase, this step would be skipped in favor of the `StatsModal` edit path alone — it does exist, confirmed above, so this step is required.

Add the input field in the modal's JSX, placed near the trade/service-radius fields:
```tsx
<div>
  <label style={fieldLabelStyle}>Deposit % (optional)</label>
  <input style={inputStyle} type="number" min={0} max={100} value={depositPercent} onChange={(e) => setDepositPercent(e.target.value)} placeholder="Platform default" />
</div>
```

- [ ] **Step 5: Type-check and manual verification**

Run: `yarn tsc --noEmit`
Expected: no new errors.

Per this project's standing rule, start both dev servers and exercise this in a browser: open an operator's detail modal, set a deposit %, confirm it saves and displays; clear it back to default; confirm "0" saves correctly and doesn't silently revert to showing the platform default (the exact falsy-vs-null bug class this plan's Review Focus calls out).

- [ ] **Step 6: Commit**

```bash
git add app/hooks/useOperatorApi.ts app/components/tabs/OperatorsTab.tsx
git commit -m "Add staff-side deposit percentage field to Operators tab"
```

---

### Task 9: lrr-web — operator self-service deposit % field

**Files:**
- Modify: `app/components/OperatorProfileForm.tsx`

**Interfaces:**
- Consumes: `useOperatorApi().setDepositPercent` (Task 8).

- [ ] **Step 1: Read the current bank-details section of this form**

Run: `grep -n "saveBankDetails\|bankCode\|bankName" app/components/OperatorProfileForm.tsx` to find the exact existing pattern for a dedicated-endpoint save action on this form, and copy its state/handler shape precisely rather than inventing a new one.

- [ ] **Step 2: Add the deposit percentage field**

Following the exact state/handler/JSX shape the bank-details section already establishes in this file, add an equivalent section: local state for the input value and save/error status, a handler calling `setDepositPercent(operator.id, value)` (destructured from `useOperatorApi()`, already imported in this file per its existing `const { fetchMe, updateOperator, fetchBanks, saveBankDetails } = useOperatorApi();` line — add `setDepositPercent` to that destructure), and an input + save button matching this file's existing field styling.

Show the current effective value the same way Task 8's `StatsModal` does: the override if set, or "using platform default" with the actual current value — fetch the platform default the same way this form (or a sibling component it can reach) already fetches anything else platform-wide, if it does; if this form has no existing access to platform settings, add a minimal fetch of just that one value rather than pulling in the full settings surface.

- [ ] **Step 3: Type-check and manual verification**

Run: `yarn tsc --noEmit`
Expected: no new errors.

Per this project's standing rule, start the dev server and exercise this as a logged-in operator: set a deposit %, confirm it saves; confirm setting exactly 0 works and persists as 0, not silently cleared.

- [ ] **Step 4: Commit**

```bash
git add app/components/OperatorProfileForm.tsx
git commit -m "Add operator self-service deposit percentage field"
```

---

### Task 10: Integration tests — full deposit-override and 0% paths

**Files:**
- Create: `test/integration/per-operator-deposit-percentage.int-spec.ts`

**Interfaces:**
- Consumes: the complete backend workflow from Tasks 1-7.

- [ ] **Step 1: Write the tests**

Follow this repo's established integration-test conventions (`test/integration/factories.ts`'s `createCustomer`/`createOperator`/`createRequest` helpers, `truncateAll` in `beforeEach`, real `PrismaService` instances — check how an existing payment-flow integration spec, e.g. `test/integration/payment-deposit-flow.int-spec.ts`, instantiates services directly, and match that pattern):

```ts
import { PrismaService } from '../../src/prisma/prisma.service';
import { DispatchService } from '../../src/rescue-request/dispatch.service';
import { WhatsAppCustomerFlowService } from '../../src/rescue-request/whatsapp-customer-flow.service';
import { truncateAll, createCustomer, createOperator, createRequest } from './factories';

describe('Per-operator deposit percentage (integration)', () => {
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

  it('charges the deposit amount the customer actually saw, from an operator with a custom override', async () => {
    const customer = await createCustomer(prisma);
    const operator = await createOperator(prisma, undefined, { depositPercentOverride: 25 });
    const request = await createRequest(prisma, customer.id, { status: 'DISPATCHING' });

    // 1. Create a QUOTED DispatchOffer for this operator/request directly
    //    (bypassing full dispatch-round simulation, which is covered by
    //    dispatch.service's own integration tests).
    // 2. Call DispatchService.deliverQuoteShortlist — assert the created
    //    offer's depositPercentSnapshot is now 25.
    // 3. Change the operator's depositPercentOverride to 50 directly via
    //    Prisma, simulating a change during the selection window.
    // 4. Call the same quote-selection logic handleQuoteSelected uses
    //    (either via the service directly or its public entry point) —
    //    assert the persisted depositAmount reflects 25%, not 50%.
  });

  it('drives a 0%-deposit operator straight to OPERATOR_ASSIGNED with the offer ACCEPTED and zero DEPOSIT payments', async () => {
    const customer = await createCustomer(prisma);
    const operator = await createOperator(prisma, undefined, { depositPercentOverride: 0 });
    const request = await createRequest(prisma, customer.id, { status: 'DISPATCHING' });

    // Drive the same quote → select flow as above, with this 0%-override
    // operator's offer. Assert: final request status is OPERATOR_ASSIGNED
    // (not WAITING_FOR_DEPOSIT), depositAmount is 0, balanceAmount equals
    // the full total, the winning DispatchOffer's status is ACCEPTED (not
    // SELECTED_PENDING_PAYMENT — this is what activateAssignedJob, Task 4,
    // is responsible for), and prisma.payment.count({ where: {
    // rescueRequestId: request.id, type: 'DEPOSIT' } }) is 0.
  });
});
```
Check `createOperator`'s current signature in `test/integration/factories.ts` — it may not yet accept a `depositPercentOverride` override in its options object; if not, extend it the same way other per-field overrides already work there, rather than adding a separate one-off helper.

- [ ] **Step 2: Run and verify**

Run: `yarn jest --config test/integration/jest-integration.json test/integration/per-operator-deposit-percentage.int-spec.ts`
Expected: PASS.

- [ ] **Step 3: Full suite, lint, commit**

```bash
yarn jest --silent
yarn jest --config test/integration/jest-integration.json
yarn eslint "{src,apps,libs,test}/**/*.ts" --max-warnings 527
git add test/integration/per-operator-deposit-percentage.int-spec.ts test/integration/factories.ts
git commit -m "Add integration tests for per-operator deposit override and 0% path"
```

---

## Self-Review

**Spec coverage:**
- Data model (both fields) → Task 1.
- Freezing the percentage (snapshot mechanism) → Task 3 (write), Task 5 (read).
- Shared start-of-job activation needed by both 0%-deposit branches → Task 4.
- 0% edge case, both calculation sites → Task 5, Task 6.
- 100% edge case, both callers of `sendBalancePaymentLink` → Task 7.
- `Number(...)` conversion at every new read site → Tasks 3, 5, 6 (arithmetic sites); Task 8/9 (frontend display, following the existing `latitude`/`longitude` convention rather than adding backend conversion, per Global Constraints).
- Dedicated endpoint, audit log, permission check, transactional locking → Task 2.
- Quote shortlist display → Task 3.
- Staff-side and operator self-service UI → Tasks 8, 9.
- Testing section → distributed across every task's own Step 1/2, plus Task 10's integration tests.
- Explicitly-rejected items (folding into general profile endpoint, floor/ceiling, ranking-order influence) → no task does any of these; confirmed by absence.
- Non-goals (quote-selection buttons, operator decline buttons) → no task touches either; confirmed by absence.

**Placeholder scan:** No bare "TBD"/"TODO". Task 8/9's UI steps direct the implementer to check and match existing file patterns rather than guessing blind, but the actual field shapes, handler logic, and validation are fully specified in each case.

**Type consistency:** `OperatorService.setDepositPercent(id, depositPercentOverride, actingUser)` (Task 2) is the one signature every later task's references to "the deposit-percent endpoint" build on — Task 8's `useOperatorApi().setDepositPercent` and Task 9's usage both call through to this same backend method via the same HTTP endpoint, same parameter shape. `depositPercentSnapshot`/`depositPercentOverride` are read with `Number(...)` at every arithmetic site (Tasks 3, 5, 6) and left as the raw Prisma-serialized type at every display-only site (Tasks 8, 9), consistently with the Global Constraints' explicit decision not to add backend API conversion. `PaymentEventsService.activateAssignedJob(rescueRequestId: string): Promise<void>` (Task 4) and `finalizeJobSettlement(rescueRequestId: string): Promise<void>` (Task 7) are both self-contained, same-shaped extractions living in the same file, each consumed by a disjoint set of callers (activation at job-start vs. settlement at job-end) with no overlap between them.

**Review Focus coverage:** All five items have an owning task and an explicit test. The 0%-persists-correctly item → Task 2 Step 2's "persists exactly 0" and audit-log-records-a-real-0 tests. The rounding-to-boundary item → Task 5 Step 2's rounding test (the equivalent reasoning applies to Task 6, though no separate rounding test was written there — the branch logic is identical and already proven at the computed-amount level in Task 5). The multiple-shortlist-delivery overwrite item → Task 3 Step 2's "writes a fresh snapshot every call" test. The always-populated-snapshot item → Task 3 Step 2's first test, which covers the `null`-override/platform-default case explicitly. The quote-selection-timeout-reconciler item → not given its own task or test; flagging here rather than silently dropping it: `QuoteSelectionTimeoutCheck` only reads `RescueRequest`/`DispatchOffer` status fields to decide what to cancel, never touches `depositPercentSnapshot`, so the new column is inert to it by construction — this was confirmed by reading the check's logic during spec review, not by a new test, because there is no new behavior there to test.

**Adversarial review findings addressed (round 1):** an external review of the first draft caught five real defects, each independently re-verified against the actual current code before fixing (not taken on faith): (1) the Task 2 audit log used a truthy check that silently turned a real `0` into a logged `null` — fixed with an explicit `!= null` check, plus a dedicated test; (2) the endpoint had no way to distinguish an omitted field from an explicit `null`, and — since this app has no global `ValidationPipe`, confirmed by grep — the real fix had to be a manual check in the service, not the DTO; (3) the new mutation was missing the transactional `lockActiveMembership` locking every other operator mutation of its kind uses, confirmed by reading `saveBankDetails`/`clearBankDetails`/`updateProfile`; (4) the 0%-deposit customer flow would have left the customer's session at `OPERATOR_FOUND_WAITING_PAYMENT`, which makes a later message get "please pay using the link we sent you" — a link that was never sent — traced to the plan's own "the existing session update stays unchanged" instruction; (5) `assignOperator`'s 0%-branch never flipped its newly-created offer off `SELECTED_PENDING_PAYMENT`. Findings 4 and 5 shared one root cause (no shared activation logic for a job confirmed without a real payment) and are fixed together by the Task 4 extraction, reused by both Task 5 and Task 6, rather than as two separate patches.

**Adversarial review findings addressed (round 2):** a second pass caught four more, three fixed and one explicitly pushed back on after verification: (1) Task 2's manual check compared a value against `0`/`100` without first confirming it was a number at all — a string or object body field coerces both comparisons to `false` and reaches Prisma unvalidated; fixed with an explicit `typeof === 'number' && Number.isFinite(...)` guard, plus a test. (2) Task 3's original code would not have compiled — `RankedQuote` (`domain/quote-ranking.ts`) extends a closed, non-generic `QuoteForRanking` interface, so a `depositPercent` field added to the objects going into `rankQuotes` would not appear on its typed return value; confirmed `rankQuotes` has exactly one other caller (`handleQuoteSelected`'s own ranking, which needs no percentage on the ranked object), so the fix keeps percentages in a separate `Map<offerId, percent>` rather than widening a shared type for one caller. (3) a review claim that `activateAssignedJob` would break the non-WhatsApp-operator manual-dispatch design was checked against the real schema and codebase and found to describe a plan document, not shipped code — `grep` confirms no `whatsappEnabled` field (or equivalent) exists anywhere, and every real operator today is a WhatsApp operator; rather than add a branch against a field that doesn't exist, Task 4 now carries an explicit note flagging this as the responsibility of whichever work implements that other plan. (4) Task 8's `adminCreate` path for setting the override at onboarding time had no backend validation at all for the new field — fixed with the same manual numeric/range check Task 2 uses, plus the equivalent tests.
