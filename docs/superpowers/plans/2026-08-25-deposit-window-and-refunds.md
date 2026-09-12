# Deposit Window and Late-Payment Refunds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the deposit-payment window from 5 to 30 minutes with reminders,
stop the timeout from re-dispatching, and add a safe, auditable refund path for
deposits that arrive after a request has already moved on.

**Architecture:** One new shared method (`RescueRequestSharedService.scheduleDepositWindow`)
replaces two duplicated 5-minute timeouts. The existing payment-confirmation
webhook handler gains a three-way branch on why its atomic claim failed
(already-processed / genuinely late / unexpected). A new admin-triggered
refund flow follows the same atomic-claim pattern as `PayoutService.retryPayout`,
with a new Paystack Refund API integration and webhook handler.

**Tech Stack:** NestJS, Prisma, Paystack API, Twilio WhatsApp, Jest (mocked Prisma).

## Global Constraints

- No hold on the operator during the window; no re-dispatch on timeout — the
  request either gets paid or gets cancelled outright.
- The 30-minute cancel and the payment-confirmation claim are both atomic
  (`updateMany` conditioned on current state) — never read-then-write. They
  compete for the same row; whichever's `WHERE` matches first wins.
- `claimed.count === 0` on the payment-confirmation claim is NOT synonymous
  with "late payment" — it can also mean "this is a redelivered webhook for a
  payment we already processed." These must be distinguished (Section 2 /
  Task 3).
- Refund eligibility is the explicit `RefundStatus.ELIGIBLE` marker, written
  only by `handleLateDeposit` — never inferred from `depositPaid: true` alone.
- Full refunds only, no partial amount.
- Paystack's account-level session timeout is NOT touched — it's account-wide
  and would also affect the unrelated balance-payment flow.
- Refund webhook correlation must match on `depositRefundId` (the specific
  attempt) in addition to `depositReference` (the request) — `depositReference`
  alone is unsafe once a refund can be retried. See Task 6's required
  live-payload verification before writing the webhook handler's `WHERE`.
- Every conditional write gets a test that manually simulates both
  `count: 0` and `count: 1` — this codebase's mocked-Prisma tests cannot
  observe real `NULL`/`WHERE`-clause semantics, so call-shape assertions are
  the only verification available.

Full spec: `docs/superpowers/specs/2026-08-25-deposit-window-and-refunds-design.md`

---

## Task order and why

1. **Schema** — every later task depends on the new fields/enum existing.
2. **`scheduleDepositWindow`** — the shared timeout helper, built and tested in
   isolation before either call site is touched.
3. **Wire both call sites to it**, deleting their duplicated `setTimeout`s.
   Depends on Task 2's method existing.
4. **The confirmed-payment guard's three-way branch** — depends on nothing
   from Tasks 2-3, but is sequenced here because Task 5 (the late-payment path
   proper) is one of its branches.
5. **`handleLateDeposit`** — the specific branch Task 4 calls into.
6. **Refund webhook correlation research** — a research task, not a code task:
   trigger one real Paystack refund, capture the actual webhook payload. Task
   8 cannot be written correctly without this.
7. **`PaystackService.refundTransaction`** — small, independent, no dependency
   on Task 6's finding (it only calls Create Refund, doesn't parse a webhook).
8. **`refundDeposit` + the webhook handler** — depends on Task 6's finding for
   the webhook's `WHERE` clause, and Task 7 for the Paystack call.
9. **Admin list filter/badge** — depends on the schema fields (Task 1) only;
   sequenced last since it's the smallest, purely additive task.

---

## Task 1: Schema — refund status, refund id, migration

**Files:**
- Modify: `prisma/schema.prisma`
- Migration: `prisma migrate dev --name deposit_window_refunds`

**Interfaces:**
- Produces: `RefundStatus` enum (`NONE | ELIGIBLE | PENDING | COMPLETED | FAILED`),
  `RescueRequest.depositRefundStatus: RefundStatus @default(NONE)`,
  `RescueRequest.depositRefundId: Int?`

- [ ] **Step 1: Add the enum and fields**

In `prisma/schema.prisma`, find the `RescueRequest` model and add these two
fields near the existing `depositPaid`/`depositReference`/`depositAmount`
fields:

```prisma
depositRefundStatus RefundStatus @default(NONE)
depositRefundId     Int?
```

Add the new enum near the other enums in the file (e.g. next to
`RescueRequestStatus`):

```prisma
enum RefundStatus {
  NONE      // not a late-payment case
  ELIGIBLE  // handleLateDeposit fired — admin can refund
  PENDING   // refund initiated at Paystack, awaiting webhook confirmation
  COMPLETED
  FAILED
}
```

- [ ] **Step 2: Run the migration**

Run: `npx prisma migrate dev --name deposit_window_refunds`
Expected: migration applies cleanly. `RescueRequest` rows with no deposit
history default to `depositRefundStatus: NONE`.

- [ ] **Step 3: Regenerate the Prisma client**

Run: `npx prisma generate`
Expected: succeeds with no errors.

- [ ] **Step 4: Verify the build**

Run: `npx tsc --noEmit`
Expected: clean (no code references these fields yet, so nothing should break).

- [ ] **Step 5: Commit**

```bash
git add prisma/
git commit -m "schema: add depositRefundStatus and depositRefundId to RescueRequest"
```

---

## Task 2: `scheduleDepositWindow` — the shared 30-minute timeout helper

**Files:**
- Modify: `src/rescue-request/rescue-request-shared.service.ts`
- Test: `src/rescue-request/rescue-request-shared.service.spec.ts` (new file if
  one doesn't already exist — check first)

**Interfaces:**
- Consumes: `PrismaService` (already injected), `TwilioService` (not yet
  injected into this file — add it), `RescueRequestStatus`, `DispatchOfferStatus`
  from `@prisma/client`.
- Produces:
  ```ts
  scheduleDepositWindow(params: {
    rescueRequestId: string;
    customerPhone: string;
    operatorPhone: string;
    paymentUrl: string;
  }): void
  ```
  Later tasks (Task 3) call this exact signature.

**Background for the implementer:** read
`docs/superpowers/specs/2026-08-25-deposit-window-and-refunds-design.md`
Section 1 in full before starting — it explains why the 30-minute cancel must
be an atomic claim (race with the payment webhook) and why reminders must
re-check status before sending. Do not skip that reasoning; the code below
depends on it.

- [ ] **Step 1: Add `TwilioService` to the constructor**

In `src/rescue-request/rescue-request-shared.service.ts`, add the import and
constructor parameter:

```ts
import { TwilioService } from '../integrations/twilio/twilio.service';
```

```ts
constructor(
  private readonly prisma: PrismaService,
  private readonly geocodingService: GeocodingService,
  private readonly twilioService: TwilioService,
) {}
```

- [ ] **Step 2: Write the failing test for "cancels at 30 minutes when still WAITING_FOR_DEPOSIT"**

Create/extend `src/rescue-request/rescue-request-shared.service.spec.ts`:

```ts
import { Test, TestingModule } from '@nestjs/testing';
import { RescueRequestSharedService } from './rescue-request-shared.service';
import { PrismaService } from '../prisma/prisma.service';
import { GeocodingService } from '../integrations/geocoding/geocoding.service';
import { TwilioService } from '../integrations/twilio/twilio.service';

describe('RescueRequestSharedService.scheduleDepositWindow', () => {
  let service: RescueRequestSharedService;
  let prisma: {
    rescueRequest: { findUnique: jest.Mock; updateMany: jest.Mock };
    dispatchOffer: { updateMany: jest.Mock };
  };
  let twilioService: { sendWhatsAppMessage: jest.Mock };

  beforeEach(async () => {
    prisma = {
      rescueRequest: { findUnique: jest.fn(), updateMany: jest.fn() },
      dispatchOffer: { updateMany: jest.fn() },
    };
    twilioService = { sendWhatsAppMessage: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RescueRequestSharedService,
        { provide: PrismaService, useValue: prisma },
        { provide: GeocodingService, useValue: {} },
        { provide: TwilioService, useValue: twilioService },
      ],
    }).compile();

    service = module.get(RescueRequestSharedService);
  });

  afterEach(() => jest.useRealTimers());

  it('cancels the request at 30 minutes when the claim succeeds — no startDispatch call, no DISPATCHING reset', async () => {
    jest.useFakeTimers();
    // The reminder pre-checks (t=5, t=15, t=25) run first; keep them harmless.
    prisma.rescueRequest.findUnique.mockResolvedValue({ status: 'WAITING_FOR_DEPOSIT' });
    prisma.rescueRequest.updateMany.mockResolvedValue({ count: 1 });
    prisma.dispatchOffer.updateMany.mockResolvedValue({ count: 1 });

    service.scheduleDepositWindow({
      rescueRequestId: 'req-1', customerPhone: '+2341', operatorPhone: '+2342',
      paymentUrl: 'https://paystack.com/pay/abc',
    });

    jest.advanceTimersByTime(30 * 60 * 1000);
    await Promise.resolve(); await Promise.resolve(); // flush pending microtasks from the timer callback

    expect(prisma.rescueRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'req-1', status: 'WAITING_FOR_DEPOSIT' },
      data: { status: 'CANCELLED' },
    });
    expect(prisma.dispatchOffer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ rescueRequestId: 'req-1' }) }),
    );
    expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
      '+2341',
      expect.stringContaining("didn't receive payment confirmation"),
    );
    expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
      '+2342',
      expect.stringContaining('no longer available'),
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/rescue-request/rescue-request-shared.service.spec.ts -t "cancels the request at 30 minutes"`
Expected: FAIL — `scheduleDepositWindow` is not a function.

- [ ] **Step 3: Implement `scheduleDepositWindow`**

Add to `src/rescue-request/rescue-request-shared.service.ts`:

```ts
private readonly DEPOSIT_REMINDER_MARKS_MS = [5, 15, 25].map((m) => m * 60 * 1000);
private readonly DEPOSIT_WINDOW_MS = 30 * 60 * 1000;

/**
 * Gives a motorist 30 minutes to pay their deposit, with reminders at
 * 5/15/25 minutes, and cancels outright at 30 — no re-dispatch, since
 * nobody declined anything; the operator was simply waiting on payment.
 *
 * See docs/superpowers/specs/2026-08-25-deposit-window-and-refunds-design.md
 * Section 1 for why the 30-minute cancel is an atomic claim (races the
 * payment-confirmation webhook) and why every reminder re-checks status
 * before sending.
 */
scheduleDepositWindow(params: {
  rescueRequestId: string;
  customerPhone: string;
  operatorPhone: string;
  paymentUrl: string;
}): void {
  const { rescueRequestId, customerPhone, operatorPhone, paymentUrl } = params;

  for (const markMs of this.DEPOSIT_REMINDER_MARKS_MS) {
    const isFinalWarning = markMs === this.DEPOSIT_REMINDER_MARKS_MS[this.DEPOSIT_REMINDER_MARKS_MS.length - 1];
    setTimeout(async () => {
      const fresh = await this.prisma.rescueRequest.findUnique({
        where: { id: rescueRequestId },
        select: { status: true },
      });
      if (fresh?.status !== RescueRequestStatus.WAITING_FOR_DEPOSIT) return; // paid or cancelled already — no nag

      const warning = isFinalWarning ? '\n\n⚠️ Your request will be cancelled soon if we don\'t receive payment.' : '';
      await this.twilioService.sendWhatsAppMessage(
        customerPhone,
        `⏰ Reminder — tap the link below to pay and confirm your rescue:\n\n👉 ${paymentUrl}${warning}`,
      );
    }, markMs);
  }

  setTimeout(async () => {
    const claimed = await this.prisma.rescueRequest.updateMany({
      where: { id: rescueRequestId, status: RescueRequestStatus.WAITING_FOR_DEPOSIT },
      data: { status: RescueRequestStatus.CANCELLED },
    });
    if (claimed.count === 0) return; // the payment webhook won the race — nothing to do

    await this.prisma.dispatchOffer.updateMany({
      where: { rescueRequestId, status: 'SELECTED_PENDING_PAYMENT' },
      data: { status: 'TIMED_OUT', respondedAt: new Date() },
    });
    await this.twilioService.sendWhatsAppMessage(
      customerPhone,
      `We didn't receive payment confirmation within 30 minutes, so your request was cancelled. If your payment completes after this, we'll refund it.`,
    );
    await this.twilioService.sendWhatsAppMessage(
      operatorPhone,
      `⏰ This job is no longer available — the customer didn't pay in time.`,
    );
  }, this.DEPOSIT_WINDOW_MS);
}
```

Add the missing import at the top of the file:

```ts
import { RescueRequestStatus } from '@prisma/client';
```

(Combine with the existing `import { UserRole } from '@prisma/client';` line
into one import statement.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/rescue-request/rescue-request-shared.service.spec.ts -t "cancels the request at 30 minutes"`
Expected: PASS

- [ ] **Step 5: Write and pass the race test — payment wins**

Add to the same `describe` block:

```ts
it('does nothing if the payment webhook already claimed the row (race at t=30)', async () => {
  jest.useFakeTimers();
  prisma.rescueRequest.findUnique.mockResolvedValue({ status: 'WAITING_FOR_DEPOSIT' });
  prisma.rescueRequest.updateMany.mockResolvedValue({ count: 0 }); // payment webhook won

  service.scheduleDepositWindow({
    rescueRequestId: 'req-1', customerPhone: '+2341', operatorPhone: '+2342',
    paymentUrl: 'https://paystack.com/pay/abc',
  });

  jest.advanceTimersByTime(30 * 60 * 1000);
  await Promise.resolve(); await Promise.resolve();

  expect(prisma.dispatchOffer.updateMany).not.toHaveBeenCalled();
  expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalled();
});
```

Run: `npx jest src/rescue-request/rescue-request-shared.service.spec.ts -t "does nothing if the payment webhook"`
Expected: PASS immediately (the implementation already handles this via `claimed.count === 0`).

- [ ] **Step 6: Write and pass the reminder-suppression test**

```ts
it('skips a reminder if the request is no longer WAITING_FOR_DEPOSIT by the time it fires', async () => {
  jest.useFakeTimers();
  prisma.rescueRequest.findUnique.mockResolvedValue({ status: 'OPERATOR_ASSIGNED' }); // paid already
  prisma.rescueRequest.updateMany.mockResolvedValue({ count: 0 });

  service.scheduleDepositWindow({
    rescueRequestId: 'req-1', customerPhone: '+2341', operatorPhone: '+2342',
    paymentUrl: 'https://paystack.com/pay/abc',
  });

  jest.advanceTimersByTime(5 * 60 * 1000);
  await Promise.resolve(); await Promise.resolve();

  expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalled();
});
```

Run: `npx jest src/rescue-request/rescue-request-shared.service.spec.ts`
Expected: all tests in the file PASS.

- [ ] **Step 7: Run the full suite and confirm no timer leaks**

Run: `npx jest`
Expected: all suites pass, no `--forceExit` needed.

- [ ] **Step 8: Commit**

```bash
git add src/rescue-request/rescue-request-shared.service.ts src/rescue-request/rescue-request-shared.service.spec.ts
git commit -m "feat(deposit): add scheduleDepositWindow — 30min window, reminders at 5/15/25, atomic cancel"
```

---

## Task 3: Wire both call sites to `scheduleDepositWindow`

**Files:**
- Modify: `src/rescue-request/whatsapp-customer-flow.service.ts:680-723` (the
  `handleQuoteSelected` deposit-send block, currently ending in its own
  5-minute `setTimeout`)
- Modify: `src/rescue-request/rescue-request-admin.service.ts:141-174` (the
  `assignOperator` deposit-send block, same shape)
- Test: `src/rescue-request/whatsapp-customer-flow.service.spec.ts`,
  `src/rescue-request/rescue-request-admin.service.spec.ts`

**Interfaces:**
- Consumes: `RescueRequestSharedService.scheduleDepositWindow` from Task 2 —
  exact signature `{ rescueRequestId, customerPhone, operatorPhone, paymentUrl }`.

**Background:** both files already inject `RescueRequestSharedService` as
`this.sharedService` — confirm this before starting (`grep -n sharedService`
in each file). If either doesn't, add it to that service's constructor and
its module's providers (it's very likely already there, since both already
use `sharedService.findOrCreateCustomer`/`formatLocationSection` elsewhere).

- [ ] **Step 1: Replace `whatsapp-customer-flow.service.ts`'s timeout block**

Find this existing code (around line 692-722):

```ts
const DEPOSIT_WINDOW_MS = 5 * 60 * 1000;
setTimeout(async () => {
  const fresh = await this.prisma.rescueRequest.findUnique({
    where: { id: rescueRequestId },
    select: { status: true },
  });
  if (fresh?.status !== RescueRequestStatus.WAITING_FOR_DEPOSIT) return;

  await this.prisma.dispatchOffer.update({
    where: { id: selectedOffer.id },
    data: { status: 'TIMED_OUT', respondedAt: new Date() },
  });
  await this.prisma.rescueRequest.update({
    where: { id: rescueRequestId },
    data: { assignedOperatorId: null, status: RescueRequestStatus.DISPATCHING },
  });
  const freshSession = await this.sessionStore.getOrCreate(rescueRequest.customerId);
  await this.sessionStore.update(rescueRequest.customerId, {
    state: WhatsAppFlowState.REQUEST_CONFIRMED,
    offeredOperatorIds: [...(freshSession.offeredOperatorIds ?? []), operator.id],
  });
  await this.twilioService.sendWhatsAppMessage(
    phoneNumber,
    `⏰ Payment window expired. Looking for the next available operator...`,
  );
  void this.dispatchService.startDispatch(rescueRequestId, rescueRequest.customerId);
  await this.twilioService.sendWhatsAppMessage(
    toWhatsAppAddress(operator.phoneNumber),
    `⏰ ${formatJobRef(rescueRequestId)} is no longer available — the customer did not pay within 5 minutes. Watch for new offers!`,
  );
}, DEPOSIT_WINDOW_MS);
```

Replace it with:

```ts
this.sharedService.scheduleDepositWindow({
  rescueRequestId,
  customerPhone: phoneNumber,
  operatorPhone: toWhatsAppAddress(operator.phoneNumber),
  paymentUrl: paymentResponse.data.authorization_url,
});
```

- [ ] **Step 2: Update the "5 minutes" text in the initial deposit message**

Still in `handleQuoteSelected`, find the initial WhatsApp message sent when
the deposit link is first created (around line 688) — it currently says
"You have *5 minutes*". Change to "You have *30 minutes*".

- [ ] **Step 3: Replace `rescue-request-admin.service.ts`'s timeout block**

Find this existing code (around line 150-174):

```ts
setTimeout(async () => {
  const fresh = await this.prisma.rescueRequest.findUnique({ where: { id }, select: { status: true } });
  if (fresh?.status !== RescueRequestStatus.WAITING_FOR_DEPOSIT) return;

  await this.prisma.dispatchOffer.update({
    where: { id: offer.id },
    data:  { status: 'TIMED_OUT', respondedAt: new Date() },
  });
  await this.prisma.rescueRequest.update({
    where: { id },
    data:  { assignedOperatorId: null, status: RescueRequestStatus.DISPATCHING },
  });
  void this.twilioService.sendWhatsAppMessage(
    customerPhone,
    `⏰ Payment window expired. We're still looking for an operator for you.`,
  );
  void this.twilioService.sendWhatsAppMessage(
    operatorPhone,
    `⏰ ${formatJobRef(id)} is no longer available — the customer did not pay within 5 minutes.`,
  );
  // ... (whatever follows — check the file for the exact closing brace/MANUAL_ASSIGN_WINDOW_MS reference)
}, MANUAL_ASSIGN_WINDOW_MS);
```

Replace with:

```ts
this.sharedService.scheduleDepositWindow({
  rescueRequestId: id,
  customerPhone,
  operatorPhone,
  paymentUrl: paymentResponse.data.authorization_url,
});
```

If `RescueRequestSharedService` is not yet injected into
`RescueRequestAdminService`, add it to the constructor and confirm
`RescueRequestModule` already provides it (it does — check
`rescue-request.module.ts`'s `providers` array).

- [ ] **Step 4: Update the "5 minutes" text in `assignOperator`'s initial message**

Find the initial "You have *5 minutes*" text in this file (near where the
deposit payment link is first sent) and change to "You have *30 minutes*".

- [ ] **Step 5: Update existing tests referencing the old 5-minute timeout behavior**

Search both spec files for tests asserting the deleted `setTimeout`/`DISPATCHING`-reset
behavior:

Run: `grep -n "DEPOSIT_WINDOW_MS\|MANUAL_ASSIGN_WINDOW_MS\|5 minutes\|DISPATCHING" src/rescue-request/whatsapp-customer-flow.service.spec.ts src/rescue-request/rescue-request-admin.service.spec.ts`

For each match testing the old timeout behavior directly (not just the
"5 minutes" text), replace the assertion with one confirming
`sharedService.scheduleDepositWindow` was called with the correct params:

```ts
expect(sharedService.scheduleDepositWindow).toHaveBeenCalledWith({
  rescueRequestId: 'req-1',
  customerPhone: expect.any(String),
  operatorPhone: expect.any(String),
  paymentUrl: expect.any(String),
});
```

(Mock `sharedService` in each spec file's `TestingModule` if not already
mocked — add `scheduleDepositWindow: jest.fn()` to its mock object.)

- [ ] **Step 6: Run both affected spec files**

Run: `npx jest src/rescue-request/whatsapp-customer-flow.service.spec.ts src/rescue-request/rescue-request-admin.service.spec.ts`
Expected: all PASS.

- [ ] **Step 7: Run the full suite**

Run: `npx jest`
Expected: all suites pass.

- [ ] **Step 8: Commit**

```bash
git add src/rescue-request/whatsapp-customer-flow.service.ts src/rescue-request/rescue-request-admin.service.ts src/rescue-request/whatsapp-customer-flow.service.spec.ts src/rescue-request/rescue-request-admin.service.spec.ts
git commit -m "fix(deposit): both deposit-timeout call sites use scheduleDepositWindow, no more re-dispatch on timeout"
```

---

## Task 4: The confirmed-payment guard's three-way branch

**Files:**
- Modify: `src/rescue-request/payment-events.service.ts` (the
  `handleDepositPaymentConfirmed` method — currently an unconditional write,
  no status check at all)
- Test: `src/rescue-request/payment-events.service.spec.ts`

**Interfaces:**
- Produces: `handleUnclaimedDeposit(rescueRequestId: string, reference: string): Promise<void>`
  (private method) — Task 5 implements the `handleLateDeposit` this calls into.
- Consumes: none new from other tasks in this plan (Task 5's `handleLateDeposit`
  is implemented in the same file, sequenced next).

**Background:** read
`docs/superpowers/specs/2026-08-25-deposit-window-and-refunds-design.md`
Section 2 in full — it explains the exact webhook-redelivery scenario this
guards against (a second `charge.success` delivery for an already-processed
payment must NOT be treated as a late payment).

- [ ] **Step 1: Write the failing test — normal claim succeeds**

In `src/rescue-request/payment-events.service.spec.ts`, find or create the
`describe` block for `handleDepositPaymentConfirmed`. Add:

```ts
it('assigns the operator and confirms when the claim succeeds', async () => {
  prisma.rescueRequest.findFirst.mockResolvedValue({
    id: 'req-1', customerId: 'cust-1', assignedOperatorId: 'op-1',
    customer: { phoneNumber: '+2341' }, assignedOperator: { businessName: 'Swift', phoneNumber: '+2342' },
  });
  prisma.rescueRequest.updateMany.mockResolvedValue({ count: 1 });
  // ... mock whatever else the existing "happy path" test already mocks (dispatchOffer.updateMany, etc.)

  await service.handleDepositPaymentConfirmed('DEP_ref_1');

  expect(prisma.rescueRequest.updateMany).toHaveBeenCalledWith({
    where: { id: 'req-1', status: 'WAITING_FOR_DEPOSIT' },
    data: { depositPaid: true, status: 'OPERATOR_ASSIGNED' },
  });
  // existing assertions for the happy path (operator dispatched, customer told, etc.) continue to apply
});
```

Note: if a happy-path test already exists in this file, adapt it to expect
`updateMany` instead of `update` rather than duplicating it.

- [ ] **Step 2: Write the failing test — redelivery of an already-processed payment**

```ts
it('is a silent no-op when the claim fails because the deposit was already paid (webhook redelivery)', async () => {
  prisma.rescueRequest.findFirst.mockResolvedValue({
    id: 'req-1', customerId: 'cust-1', assignedOperatorId: 'op-1',
    customer: { phoneNumber: '+2341' }, assignedOperator: { businessName: 'Swift', phoneNumber: '+2342' },
  });
  prisma.rescueRequest.updateMany.mockResolvedValue({ count: 0 }); // claim failed
  prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
    id: 'req-1', depositPaid: true, status: 'OPERATOR_ASSIGNED', // already processed
  });

  await service.handleDepositPaymentConfirmed('DEP_ref_1');

  expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalled();
  expect(prisma.rescueRequest.update).not.toHaveBeenCalled(); // handleLateDeposit's write must not fire
});
```

- [ ] **Step 3: Write the failing test — genuine late payment**

```ts
it('routes to handleLateDeposit when the request is CANCELLED and not yet paid', async () => {
  prisma.rescueRequest.findFirst.mockResolvedValue({
    id: 'req-1', customerId: 'cust-1',
    customer: { phoneNumber: '+2341' }, assignedOperator: null,
  });
  prisma.rescueRequest.updateMany.mockResolvedValue({ count: 0 });
  prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
    id: 'req-1', customer: { phoneNumber: '+2341' }, depositPaid: false, status: 'CANCELLED',
  });
  prisma.rescueRequest.update.mockResolvedValue({});

  await service.handleDepositPaymentConfirmed('DEP_ref_1');

  expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
    where: { id: 'req-1' },
    data: { depositPaid: true, depositRefundStatus: 'ELIGIBLE' },
  });
  expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
    '+2341',
    expect.stringContaining("we're processing a refund"),
  );
});
```

(Wording match should be case-insensitive-tolerant to your exact final copy —
adjust `stringContaining` to whatever exact text Task 5 writes.)

- [ ] **Step 4: Write the failing test — unexpected status**

```ts
it('alerts Sentry and does nothing automatic for an unexpected non-CANCELLED status', async () => {
  prisma.rescueRequest.findFirst.mockResolvedValue({ id: 'req-1', customerId: 'cust-1' });
  prisma.rescueRequest.updateMany.mockResolvedValue({ count: 0 });
  prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
    id: 'req-1', depositPaid: false, status: 'ARRIVED', // some other status, neither WAITING_FOR_DEPOSIT nor CANCELLED
  });

  await service.handleDepositPaymentConfirmed('DEP_ref_1');

  expect(prisma.rescueRequest.update).not.toHaveBeenCalled();
  expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalled();
  expect(Sentry.captureMessage).toHaveBeenCalledWith(
    'Deposit confirmed in unexpected (non-CANCELLED) status',
    expect.objectContaining({ level: 'error' }),
  );
});
```

- [ ] **Step 5: Run all four new tests to verify they fail**

Run: `npx jest src/rescue-request/payment-events.service.spec.ts`
Expected: FAIL — `handleDepositPaymentConfirmed` still writes unconditionally.

- [ ] **Step 6: Implement the guard**

In `src/rescue-request/payment-events.service.ts`, find the existing
`handleDepositPaymentConfirmed` method. Replace its unconditional write:

```ts
await this.prisma.rescueRequest.update({
  where: { id: rescueRequest.id },
  data:  { depositPaid: true, status: RescueRequestStatus.OPERATOR_ASSIGNED },
});
```

with:

```ts
const claimed = await this.prisma.rescueRequest.updateMany({
  where: { id: rescueRequest.id, status: RescueRequestStatus.WAITING_FOR_DEPOSIT },
  data:  { depositPaid: true, status: RescueRequestStatus.OPERATOR_ASSIGNED },
});
if (claimed.count === 0) {
  await this.handleUnclaimedDeposit(rescueRequest.id, reference);
  return;
}
```

(`reference` is already a parameter of `handleDepositPaymentConfirmed` — the
webhook's charge reference. Confirm the exact parameter name in the current
file and use it.)

Add the new private method to the same class:

```ts
/**
 * claimed.count === 0 on the confirmed-payment claim is ambiguous — it means
 * EITHER a Paystack webhook redelivery of a payment we already successfully
 * processed, OR a genuinely late payment arriving after the request moved
 * on. These must not be conflated: see
 * docs/superpowers/specs/2026-08-25-deposit-window-and-refunds-design.md
 * Section 2.
 */
private async handleUnclaimedDeposit(rescueRequestId: string, reference: string): Promise<void> {
  const fresh = await this.prisma.rescueRequest.findUniqueOrThrow({ where: { id: rescueRequestId } });

  if (fresh.depositPaid) {
    logger.info('deposit: duplicate confirmation ignored', { rescueRequestId, reference });
    return;
  }

  if (fresh.status === RescueRequestStatus.CANCELLED) {
    await this.handleLateDeposit(fresh, reference);
    return;
  }

  console.error(`Deposit confirmed for request ${rescueRequestId} in unexpected status ${fresh.status}`, { reference });
  Sentry.captureMessage('Deposit confirmed in unexpected (non-CANCELLED) status', {
    level: 'error',
    extra: { rescueRequestId, reference, status: fresh.status },
  });
}
```

Do NOT implement `handleLateDeposit` yet — that's Task 5. This will not
compile until Task 5 lands; that's expected and fine within this task
sequence (both tasks are typically done in the same session/PR before the
suite needs to pass — if executing task-by-task with hard review gates,
implement Task 5's stub inline here as `private async handleLateDeposit() {}`
and let Task 5 fill it in).

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx jest src/rescue-request/payment-events.service.spec.ts`
Expected: PASS (once Task 5's `handleLateDeposit` exists — see note above).

- [ ] **Step 8: Commit**

```bash
git add src/rescue-request/payment-events.service.ts src/rescue-request/payment-events.service.spec.ts
git commit -m "fix(deposit): distinguish webhook redelivery from genuine late payment in the confirmation guard"
```

---

## Task 5: `handleLateDeposit`

**Files:**
- Modify: `src/rescue-request/payment-events.service.ts` (same file as Task 4)
- Test: `src/rescue-request/payment-events.service.spec.ts` (same file as Task 4)

**Interfaces:**
- Consumes: called from `handleUnclaimedDeposit` (Task 4).
- Produces: sets `depositRefundStatus: 'ELIGIBLE'` — the exact marker Task 8's
  `refundDeposit` claim and Task 9's admin filter both query on.

- [ ] **Step 1: Implement `handleLateDeposit`**

Add to `src/rescue-request/payment-events.service.ts`:

```ts
/**
 * The only place in the codebase that writes RefundStatus.ELIGIBLE — this
 * is deliberate. It means "a deposit arrived for a request that has already
 * moved on with nothing paid yet," which is exactly and only what this
 * feature's refund path is for. Do not write ELIGIBLE anywhere else.
 */
private async handleLateDeposit(rescueRequest: { id: string; customer: { phoneNumber: string } }, reference: string): Promise<void> {
  await this.prisma.rescueRequest.update({
    where: { id: rescueRequest.id },
    data:  { depositPaid: true, depositRefundStatus: 'ELIGIBLE' },
  });
  await this.twilioService.sendWhatsAppMessage(
    rescueRequest.customer.phoneNumber,
    `Your payment for a cancelled request has come through. We're processing a refund — you'll be notified once it's complete.`,
  );
  logger.info('deposit: late payment on a non-WAITING_FOR_DEPOSIT request', { rescueRequestId: rescueRequest.id, reference });
}
```

Confirm `findUniqueOrThrow` in `handleUnclaimedDeposit` (Task 4) selects
`customer: { select: { phoneNumber: true } }` so `fresh.customer.phoneNumber`
is available — add that to the `include`/`select` if it's missing.

- [ ] **Step 2: Run all of Task 4's tests now that this compiles**

Run: `npx jest src/rescue-request/payment-events.service.spec.ts`
Expected: all PASS, including the Task 4 "genuine late payment" test.

- [ ] **Step 3: Run the full suite**

Run: `npx jest`
Expected: all suites pass.

- [ ] **Step 4: Commit**

```bash
git add src/rescue-request/payment-events.service.ts src/rescue-request/payment-events.service.spec.ts
git commit -m "feat(deposit): handleLateDeposit marks ELIGIBLE for refund, tells the customer"
```

---

## Task 6: Verify the live Paystack refund webhook payload (research task)

**This task produces no code.** It produces a finding that Task 8 cannot be
written correctly without.

**Steps:**

- [ ] **Step 1: Trigger one real refund against a Paystack test transaction**

Using Paystack's test/sandbox mode and the LRR Stage (or dev, if stage isn't
available for this) credentials, either via their dashboard or a manual
`curl` against `POST https://api.paystack.co/refund` with a real test
transaction reference:

```bash
curl https://api.paystack.co/refund \
  -H "Authorization: Bearer <secret_key>" \
  -H "Content-Type: application/json" \
  -d '{"transaction": "<a real test transaction reference>"}'
```

- [ ] **Step 2: Capture the resulting webhook payload**

Configure a webhook receiver (or temporarily log the raw body in
`WebhooksController.handlePaystackWebhook` on a local/dev instance pointed at
via ngrok or similar) and capture the full JSON body of the resulting
`refund.processed` (or `refund.failed`, if the test refund fails) event.

- [ ] **Step 3: Answer these two questions from the captured payload**

1. What is the exact field path to the **original transaction's** reference
   inside the webhook body? (e.g. `data.transaction.reference`,
   `data.transaction_reference`, or something else entirely.)
2. Does the payload also carry the **refund's own id** anywhere (matching
   the `id` that `Create Refund`'s response returned when the refund was
   initiated)? If so, what's its exact field path?

- [ ] **Step 4: Record the finding**

Write both answers into
`docs/superpowers/specs/2026-08-25-deposit-window-and-refunds-design.md`,
replacing the "Before implementation" verification note in Section 4 with
the confirmed field paths. If Q2's answer is "no refund-specific id is
present anywhere in the payload," STOP and escalate to a human — the spec
explicitly forbids falling back to `depositReference`-only correlation
(Section 6), and Task 8 as currently planned cannot proceed safely without a
decision on the fallback strategy described there (disallowing retry until
the previous attempt's webhook has landed).

- [ ] **Step 5: Commit the spec update**

```bash
git add docs/superpowers/specs/2026-08-25-deposit-window-and-refunds-design.md
git commit -m "docs: record verified Paystack refund webhook payload field paths"
```

---

## Task 7: `PaystackService.refundTransaction`

**Files:**
- Modify: `src/integrations/paystack/paystack.service.ts`
- Test: `src/integrations/paystack/paystack.service.spec.ts` (check if this
  file exists; create if not, following the pattern of an existing
  integration service spec such as `src/integrations/twilio/twilio.service.spec.ts`)

**Interfaces:**
- Produces: `refundTransaction(transaction: string, amount: number): Promise<{ id: number; status: string }>`
  — Task 8's `refundDeposit` calls this exact signature.

- [ ] **Step 1: Write the failing test**

```ts
describe('PaystackService.refundTransaction', () => {
  it('POSTs to /refund with the transaction reference and amount, returns id and status', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      json: () => Promise.resolve({ status: true, data: { id: 12345, status: 'pending' } }),
    });
    global.fetch = mockFetch as any;

    const service = /* construct with a fake secretKey, following this file's existing test setup */;
    const result = await service.refundTransaction('DEP_ref_1', 500000);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.paystack.co/refund',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ transaction: 'DEP_ref_1', amount: 500000 }),
      }),
    );
    expect(result).toEqual({ id: 12345, status: 'pending' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/integrations/paystack/paystack.service.spec.ts -t "refundTransaction"`
Expected: FAIL — method doesn't exist.

- [ ] **Step 3: Implement**

Add to `src/integrations/paystack/paystack.service.ts`, following the exact
`fetch` pattern `initializePayment`/`verifyPayment` already use in this file:

```ts
/**
 * Initiates a refund via Paystack's Create Refund API. `transaction` is
 * Paystack's own parameter name — the original transaction's id or
 * reference (our depositReference) — not a generic "reference". This only
 * INITIATES the refund; Paystack settles it asynchronously and confirms via
 * the refund.processed/refund.failed webhook (see PaymentService).
 */
async refundTransaction(transaction: string, amount: number): Promise<{ id: number; status: string }> {
  const response = await fetch(`${this.baseUrl}/refund`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${this.secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ transaction, amount }),
  });

  const data = await response.json();
  console.log('Paystack refund response:', data);
  return data.data as { id: number; status: string };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/integrations/paystack/paystack.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/integrations/paystack/paystack.service.ts src/integrations/paystack/paystack.service.spec.ts
git commit -m "feat(paystack): add refundTransaction (Create Refund API)"
```

---

## Task 8: `refundDeposit` endpoint + the refund webhook handler

**Files:**
- Modify: `src/rescue-request/rescue-request-admin.service.ts` (add
  `refundDeposit` and `confirmRefundOutcome`)
- Modify: `src/rescue-request/rescue-request.controller.ts` (add the
  `POST :id/refund-deposit` route, mirroring `payout.controller.ts`'s
  `POST :id/retry`)
- Modify: `src/payment/payment.service.ts` (add `refund.processed`,
  `refund.failed`, `refund.needs-attention` cases to `handlePaystackWebhook`'s
  switch)
- Test: `src/rescue-request/rescue-request-admin.service.spec.ts`,
  `src/payment/payment.service.spec.ts`

**Interfaces:**
- Consumes: `PaystackService.refundTransaction` (Task 7), the exact webhook
  field paths recorded in Task 6, `RescueRequestSharedService`/`PaystackService`
  already injected into `RescueRequestAdminService`.
- Produces: `RescueRequestAdminService.refundDeposit(id: string): Promise<void>`,
  `RescueRequestAdminService.confirmRefundOutcome(originalReference: string, refundId: number, outcome: 'COMPLETED' | 'FAILED'): Promise<void>`.

**IMPORTANT:** before writing Step 3's webhook `WHERE` clause, read Task 6's
recorded finding in the spec doc. If Task 6 found no refund-specific id in
the payload, STOP this task and escalate — do not write a
`depositReference`-only `WHERE`, per the spec's explicit prohibition.

- [ ] **Step 1: Write the failing test — refund claim succeeds**

In `src/rescue-request/rescue-request-admin.service.spec.ts`:

```ts
describe('refundDeposit', () => {
  it('claims ELIGIBLE → PENDING, calls Paystack, stores the refund id', async () => {
    prisma.rescueRequest.updateMany.mockResolvedValue({ count: 1 });
    prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
      id: 'req-1', depositReference: 'DEP_ref_1', depositAmount: 500000,
    });
    paystackService.refundTransaction.mockResolvedValue({ id: 999, status: 'pending' });
    prisma.rescueRequest.update.mockResolvedValue({});

    await service.refundDeposit('req-1');

    expect(prisma.rescueRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'req-1', status: 'CANCELLED', depositRefundStatus: { in: ['ELIGIBLE', 'FAILED'] } },
      data: { depositRefundStatus: 'PENDING' },
    });
    expect(paystackService.refundTransaction).toHaveBeenCalledWith('DEP_ref_1', 500000);
    expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
      where: { id: 'req-1' },
      data: { depositRefundId: 999 },
    });
  });

  it('rejects the claim (BadRequestException) when depositRefundStatus is NONE — not eligible', async () => {
    prisma.rescueRequest.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.refundDeposit('req-1')).rejects.toThrow('Not eligible for refund');
  });

  it('marks FAILED and rethrows when the Paystack call throws', async () => {
    prisma.rescueRequest.updateMany.mockResolvedValue({ count: 1 });
    prisma.rescueRequest.findUniqueOrThrow.mockResolvedValue({
      id: 'req-1', depositReference: 'DEP_ref_1', depositAmount: 500000,
    });
    paystackService.refundTransaction.mockRejectedValue(new Error('Paystack down'));

    await expect(service.refundDeposit('req-1')).rejects.toThrow('Paystack down');
    expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
      where: { id: 'req-1' },
      data: { depositRefundStatus: 'FAILED' },
    });
  });
});
```

Mock `paystackService.refundTransaction` in this file's `TestingModule` setup
if `PaystackService` isn't already mocked there.

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest src/rescue-request/rescue-request-admin.service.spec.ts -t "refundDeposit"`
Expected: FAIL — method doesn't exist.

- [ ] **Step 3: Implement `refundDeposit`**

Add to `src/rescue-request/rescue-request-admin.service.ts`:

```ts
/**
 * Admin-triggered refund for a deposit that arrived after its request was
 * already CANCELLED (see PaymentEventsService.handleLateDeposit). Always
 * refunds the full deposit amount — no partial-amount input.
 *
 * ELIGIBLE and FAILED are both claimable (a FAILED attempt must stay
 * retryable, same shape as PayoutService.retryPayout). NONE is deliberately
 * not claimable — a request that was never marked ELIGIBLE is not this
 * feature's concern, even if it's CANCELLED with a paid deposit for some
 * other reason.
 */
async refundDeposit(id: string): Promise<void> {
  const claimed = await this.prisma.rescueRequest.updateMany({
    where: { id, status: RescueRequestStatus.CANCELLED, depositRefundStatus: { in: ['ELIGIBLE', 'FAILED'] } },
    data: { depositRefundStatus: 'PENDING' },
  });
  if (claimed.count === 0) {
    throw new BadRequestException('Not eligible for refund — already refunded/in progress, or not a late-payment case.');
  }

  const request = await this.prisma.rescueRequest.findUniqueOrThrow({ where: { id } });
  try {
    const refund = await this.paystackService.refundTransaction(request.depositReference!, request.depositAmount!);
    await this.prisma.rescueRequest.update({
      where: { id },
      data: { depositRefundId: refund.id },
    });
  } catch (err) {
    await this.prisma.rescueRequest.update({ where: { id }, data: { depositRefundStatus: 'FAILED' } });
    throw err;
  }
}
```

- [ ] **Step 4: Run to verify the `refundDeposit` tests pass**

Run: `npx jest src/rescue-request/rescue-request-admin.service.spec.ts -t "refundDeposit"`
Expected: PASS.

- [ ] **Step 5: Add the controller route**

In `src/rescue-request/rescue-request.controller.ts`, add near the
`assign-operator` route, matching its exact guard decorators (this
controller class only carries `@UseGuards(AuthGuard)` — role restriction is
per-method, not class-level; do not omit these two decorators or the route
will be reachable by any authenticated role):

```ts
@Post(':id/refund-deposit')
@UseGuards(RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
async refundDeposit(@Param('id') id: string) {
  await this.rescueRequestAdminService.refundDeposit(id);
  return { message: 'Refund initiated' };
}
```

- [ ] **Step 6: Write the failing test for `confirmRefundOutcome`**

⚠️ **Fill in the exact field-path code below using Task 6's recorded
finding** — the pseudocode here uses placeholder names
(`data.transaction.reference`, `data.refund.id`) that must be replaced with
whatever Task 6 actually found.

```ts
describe('confirmRefundOutcome', () => {
  it('flips PENDING → COMPLETED only when both depositReference AND depositRefundId match', async () => {
    prisma.rescueRequest.updateMany.mockResolvedValue({ count: 1 });

    await service.confirmRefundOutcome('DEP_ref_1', 999, 'COMPLETED');

    expect(prisma.rescueRequest.updateMany).toHaveBeenCalledWith({
      where: { depositReference: 'DEP_ref_1', depositRefundId: 999, depositRefundStatus: 'PENDING' },
      data: { depositRefundStatus: 'COMPLETED' },
    });
  });

  it('is a no-op when a stale attempt\'s webhook arrives after a retry changed depositRefundId', async () => {
    prisma.rescueRequest.updateMany.mockResolvedValue({ count: 0 }); // depositRefundId no longer matches

    await service.confirmRefundOutcome('DEP_ref_1', 111, 'FAILED'); // 111 = the OLD, superseded attempt's id

    // No further writes attempted — the conditional updateMany matching 0 rows is the whole story.
    expect(prisma.rescueRequest.update).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 7: Run to verify it fails**

Run: `npx jest src/rescue-request/rescue-request-admin.service.spec.ts -t "confirmRefundOutcome"`
Expected: FAIL — method doesn't exist.

- [ ] **Step 8: Implement `confirmRefundOutcome`**

Add to `src/rescue-request/rescue-request-admin.service.ts`:

```ts
/**
 * Conditional write, matching on BOTH depositReference (the right request)
 * AND depositRefundId (the right ATTEMPT) — depositReference alone is
 * unsafe once a refund can be retried, since it never changes across
 * attempts while depositRefundId does. See
 * docs/superpowers/specs/2026-08-25-deposit-window-and-refunds-design.md
 * Section 6. Matching on depositRefundStatus: 'PENDING' also makes this
 * idempotent against Paystack's webhook redelivery.
 */
async confirmRefundOutcome(originalReference: string, refundId: number, outcome: 'COMPLETED' | 'FAILED'): Promise<void> {
  await this.prisma.rescueRequest.updateMany({
    where: { depositReference: originalReference, depositRefundId: refundId, depositRefundStatus: 'PENDING' },
    data: { depositRefundStatus: outcome },
  });
}
```

- [ ] **Step 9: Run to verify it passes**

Run: `npx jest src/rescue-request/rescue-request-admin.service.spec.ts -t "confirmRefundOutcome"`
Expected: PASS.

- [ ] **Step 10: Wire the webhook cases**

In `src/payment/payment.service.ts`, add `RescueRequestAdminService` to the
constructor (import from `../rescue-request/rescue-request-admin.service`;
`PaymentModule` already `forwardRef`s `RescueRequestModule` which exports it —
confirm this in `rescue-request.module.ts`'s `exports` array before assuming
it's already wired).

In `handlePaystackWebhook`'s `switch (event)`, add, using the exact field
paths Task 6 recorded:

```ts
case 'refund.processed': {
  await this.rescueRequestAdminService.confirmRefundOutcome(
    data.transaction.reference, // ⚠️ replace with Task 6's verified field path
    data.refund.id,             // ⚠️ replace with Task 6's verified field path
    'COMPLETED',
  );
  break;
}

case 'refund.failed': {
  await this.rescueRequestAdminService.confirmRefundOutcome(
    data.transaction.reference, // ⚠️ replace with Task 6's verified field path
    data.refund.id,             // ⚠️ replace with Task 6's verified field path
    'FAILED',
  );
  break;
}

case 'refund.needs-attention': {
  Sentry.captureMessage('Refund needs-attention — Paystack requires bank details we do not collect', {
    level: 'warning',
    extra: { reference: data.transaction?.reference }, // ⚠️ replace with Task 6's verified field path
  });
  break;
}
```

- [ ] **Step 11: Write a test for the webhook wiring**

In `src/payment/payment.service.spec.ts`:

```ts
it('routes refund.processed to confirmRefundOutcome with COMPLETED', async () => {
  await service.handlePaystackWebhook({
    event: 'refund.processed',
    data: { /* the exact shape Task 6 recorded, with transaction.reference: 'DEP_ref_1', refund.id: 999 */ },
  });

  expect(rescueRequestAdminService.confirmRefundOutcome).toHaveBeenCalledWith('DEP_ref_1', 999, 'COMPLETED');
});
```

- [ ] **Step 12: Run to verify it passes**

Run: `npx jest src/payment/payment.service.spec.ts`
Expected: PASS.

- [ ] **Step 13: Run the full suite**

Run: `npx tsc --noEmit && npx jest`
Expected: clean, all suites pass, no `--forceExit`.

- [ ] **Step 14: Commit**

```bash
git add src/rescue-request/rescue-request-admin.service.ts src/rescue-request/rescue-request.controller.ts src/payment/payment.service.ts src/rescue-request/rescue-request-admin.service.spec.ts src/payment/payment.service.spec.ts
git commit -m "feat(deposit): admin-triggered refundDeposit + refund webhook handling"
```

---

## Task 9: Admin Requests list — filter/badge for refund-eligible requests

**Files:**
- Modify: `src/rescue-request/dto/rescue-request-response.dto.ts`
  (`RescueRequestListItemDto`)
- Modify: `src/rescue-request/rescue-request-admin.service.ts`
  (`adminList`/`buildListResponse`)
- Test: `src/rescue-request/rescue-request-admin.service.spec.ts`

**Interfaces:**
- Consumes: `depositRefundStatus` field from Task 1's schema.
- Produces: `RescueRequestListItemDto.depositRefundStatus`, and an
  `adminList` query param `refundEligible=true` that filters to
  `depositRefundStatus: { in: ['ELIGIBLE', 'FAILED'] }`.

- [ ] **Step 1: Add the field to the DTO**

In `src/rescue-request/dto/rescue-request-response.dto.ts`, add to
`RescueRequestListItemDto`:

```ts
depositRefundStatus: 'NONE' | 'ELIGIBLE' | 'PENDING' | 'COMPLETED' | 'FAILED';
```

- [ ] **Step 2: Write the failing test**

```ts
it('filters to refund-eligible requests when refundEligible=true is passed', async () => {
  prisma.rescueRequest.findMany.mockResolvedValue([]);
  prisma.rescueRequest.count.mockResolvedValue(0);

  await service.adminList({ refundEligible: 'true' });

  expect(prisma.rescueRequest.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({ depositRefundStatus: { in: ['ELIGIBLE', 'FAILED'] } }),
    }),
  );
});

it('includes depositRefundStatus in each list item', async () => {
  prisma.rescueRequest.findMany.mockResolvedValue([{
    id: 'req-1', status: 'CANCELLED', vehicleType: null, destination: null,
    latitude: null, longitude: null, depositPaid: true, balancePaid: false,
    depositRefundStatus: 'ELIGIBLE',
    customer: { id: 'cust-1', phoneNumber: '+2341' }, assignedOperator: null,
    createdAt: new Date(), updatedAt: new Date(),
  }]);
  prisma.rescueRequest.count.mockResolvedValue(1);

  const result = await service.adminList({});

  expect(result.data[0].depositRefundStatus).toBe('ELIGIBLE');
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx jest src/rescue-request/rescue-request-admin.service.spec.ts -t "refund-eligible"`
Expected: FAIL.

- [ ] **Step 4: Implement**

In `src/rescue-request/rescue-request-admin.service.ts`'s `adminList` method,
add alongside the existing `depositPaid`/`balancePaid` filter lines:

```ts
if (query.refundEligible === 'true' || query.refundEligible === true) {
  where.depositRefundStatus = { in: ['ELIGIBLE', 'FAILED'] };
}
```

In `buildListResponse`'s mapping (the `data: RescueRequestListItemDto[] = rawData.map(...)` block), add:

```ts
depositRefundStatus: item.depositRefundStatus,
```

- [ ] **Step 5: Run to verify they pass**

Run: `npx jest src/rescue-request/rescue-request-admin.service.spec.ts`
Expected: all PASS.

- [ ] **Step 6: Run the full suite**

Run: `npx tsc --noEmit && npx jest`
Expected: clean, all pass.

- [ ] **Step 7: Commit**

```bash
git add src/rescue-request/dto/rescue-request-response.dto.ts src/rescue-request/rescue-request-admin.service.ts src/rescue-request/rescue-request-admin.service.spec.ts
git commit -m "feat(deposit): admin list exposes depositRefundStatus + refundEligible filter"
```

---

## Self-Review

**Spec coverage check:**
- Section 1 (30-min window, reminders, atomic cancel) → Tasks 2-3. ✓
- Section 2 (confirmed-payment guard, three-way branch) → Task 4. ✓
- Section 3 (handleLateDeposit, ELIGIBLE marker) → Task 5. ✓
- Section 4 (refundDeposit, schema, Paystack shape) → Tasks 1, 7, 8. ✓
- Section 5 (admin list filter) → Task 9. ✓
- Section 6 (refund webhook, retry-correlation safety) → Tasks 6, 8. ✓
- "Explicitly not doing" items (Paystack session timeout, partial refunds,
  durable timer, new Refunds page) — none of these appear as tasks. ✓ (correct,
  they're explicitly out of scope)

**Placeholder scan:** the two `⚠️ replace with Task 6's verified field path`
markers in Task 8 are intentional and load-bearing, not a plan gap — they
mark exactly where Task 6's research output must be substituted in, and
Task 8's own instructions say to stop if Task 6 found no safe field to use.
No other placeholders present.

**Type consistency check:**
- `scheduleDepositWindow`'s signature (Task 2) matches its call sites exactly
  (Task 3).
- `handleLateDeposit`'s signature (Task 5) matches how Task 4's
  `handleUnclaimedDeposit` calls it.
- `refundTransaction(transaction: string, amount: number): Promise<{ id: number; status: string }>`
  (Task 7) matches exactly how Task 8's `refundDeposit` calls and destructures it (`refund.id`).
  `depositRefundId` is typed `Int?` in Prisma (Task 1) and `refund.id` is `number` — consistent.
  `confirmRefundOutcome`'s `refundId: number` parameter also matches.
- `RefundStatus` enum values (`NONE | ELIGIBLE | PENDING | COMPLETED | FAILED`,
  Task 1) are used identically across Tasks 5, 8, 9 — no typos introduced
  (e.g. `'ELIGABLE'` vs `'ELIGIBLE'` was checked).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-25-deposit-window-and-refunds.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between
   tasks, fast iteration. Task 6 (the live Paystack test) is the one exception
   worth flagging: it requires a human to actually trigger a real refund
   against Paystack's test environment and inspect a real webhook delivery —
   a subagent can't do this without credentials and a reachable webhook
   endpoint, so it should be done directly by you (or handed to a subagent
   with those specifics provided) before Task 8 is dispatched.

2. **Inline Execution** — execute tasks in this session using
   `executing-plans`, batch execution with checkpoints.

Which approach?
