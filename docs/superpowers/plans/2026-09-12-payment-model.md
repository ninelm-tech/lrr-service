# Payment Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every movement of money becomes a row in one `Payment` table, with idempotency strong enough that a lost network response cannot cause a double payment, and a reconciler check that resolves any payment whose outcome we never learned.

**Architecture:** One row per *attempt*, its cuid primary key doubling as the Paystack reference and committed before any call leaves. Status transitions are conditional updates. Two partial unique indexes make a double-pay unrepresentable in Postgres. A seventh reconciler check chases anything non-final.

**Tech Stack:** NestJS, Prisma (Postgres via `@prisma/adapter-pg`), Jest. Integration tests run against real Postgres via `docker-compose.test.yml` and `yarn test:integration`.

**Spec:** `docs/superpowers/specs/2026-09-12-payment-model-design.md` — read it before starting. This plan implements it and does not restate its reasoning.

## Global Constraints

- **`Payment` is additive until Task 11.** The existing columns (`depositPaid`, `balancePaid`, `depositReference`, `balanceReference`, `depositRefundStatus`, `depositRefundId`) and the `Payout` table keep working and keep being written for Tasks 2–10. Task 11 converts readers and drops them. No intermediate commit may leave the system half-migrated.
- **The submission protocol is fixed** (spec §The submission protocol) and every call site follows it exactly:
  1. INSERT `PENDING` — committed before anything leaves
  2. CAS `PENDING → SUBMITTED`, setting `verifyAfter = now + INITIAL_VERIFY_DELAY` **in the same update**
  3. call Paystack — **only if the CAS won**
  4. explicit rejection → `FAILED`; duplicate reference → stay `SUBMITTED`; actionable non-final → `BLOCKED`; anything else → stay `SUBMITTED`
  5. only a terminal webhook or `PaymentVerifyCheck` produces `SUCCEEDED`
- **A 2xx is never `SUCCEEDED`.** No call site may set it from an HTTP response — not even when the provider's own body says `success` or `processed`. `claimTerminal` is called from webhooks and `PaymentVerifyCheck` only. From a POST, the *only* permitted transitions are `FAILED`/`REVERSED` (a definitive provider rejection) and `BLOCKED`; everything else leaves the row `SUBMITTED`.
- **Every provider call classifies its failure.** A `PaystackOutcome` is `ok`, `rejected` or `ambiguous`:
  - **`rejected`** — a 4xx with a provider `code`. Definitive: nothing landed, so `FAILED` is safe and a fresh attempt is legal.
  - **`ambiguous`** — a 5xx, a timeout, or a thrown network error. The request may have landed. It must leave the row `SUBMITTED` and **never** call `recordRejection`, or a retry becomes legal for a payment that already exists at Paystack.
  This applies to collections as much as to transfers and refunds.
- **Branch on Paystack's `code` field, never on `message`.** Verified codes: `not_found` (transfer, HTTP 404), `transaction_not_found` (transaction, HTTP 400).
- **`INITIAL_VERIFY_DELAY = 60 * 1000`.** `PaymentVerifyCheck` backoff doubles from there, capped at 30 minutes.
- **Never retry with a new reference.** A `PAYOUT` re-submits the same reference; a `REFUND` is recovered read-only; only inbound types may be failed on a not-found.
- Run `yarn tsc --noEmit`, `yarn jest` and `yarn test:integration` before every commit. Lint with the current ratchet from `.github/workflows/ci.yml` (578 at time of writing) — lower it when a task removes warnings, never raise it.
- Integration tests need Postgres: `yarn test:integration:up` once per session.

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/payment/payment.constants.ts` | Reference prefixes, `INITIAL_VERIFY_DELAY`, backoff bounds |
| `src/payment/payment-ledger.service.ts` | Create, CAS-submit, claim-terminal — the protocol, used by every flow |
| `src/payment/domain/paystack-status.ts` | Provider status → `PaymentStatus`, pure and unit-testable |
| `src/payment/dto/payment-outcome.dto.ts` | The discriminated outcome a submission reports |
| `src/rescue-request/reconciler/checks/payment-verify.check.ts` | The seventh check |

**Deleted (Task 11):** `src/payout/payout.service.ts` internals are rewritten in place; the `Payout` model is dropped in Task 11.

**Modified:** `prisma/schema.prisma`, `src/payment/payment.service.ts` (webhooks), `src/payout/payout.service.ts`, `src/rescue-request/whatsapp-customer-flow.service.ts`, `src/rescue-request/payment-events.service.ts`, `src/rescue-request/rescue-request-admin.service.ts`, `src/rescue-request/rescue-request.module.ts`, `src/integrations/paystack/paystack.service.ts`.

---

### Task 1: Settle the two unverified provider behaviours

**Files:** none — this task writes no code. It answers two questions the rest of the plan depends on.

Most provider behaviour was verified against the test integration on
2026-09-12. Two things could not be, and each is load bearing somewhere:

| Question | Depended on by | Status |
|---|---|---|
| Does `merchant_note` round-trip on a refund? | Task 8, Task 10 | ✅ **ANSWERED 2026-09-13 — yes** |
| Do concurrent same-email `POST /customer` calls dedupe? | Task 12 | Open, and **optional** — the row lock is correct either way |

**Steps 1–4 are done.** Recorded here so the work is not repeated, and because
the probe found something the spec had wrong.

**Result 1 — `merchant_note` round-trips.** Charged a test card (₦100, test
mode), refunded it with a known note, read it back. The note is present on the
create response, on `GET /refund/:id`, and on the list. Refund recovery stands
as designed.

**Result 2 — the refund list is keyed on Paystack's NUMERIC transaction id,
not our reference.** This was not in the design:

| Query | Result |
|---|---|
| `GET /refund?transaction=probe_1789301096` (our reference) | `200`, **0 rows** |
| `GET /refund?transaction=6554155210` (numeric id) | `200`, 1 row, note intact |

An empty list is not an error, so passing our reference looks exactly like
"no refund exists" — and the recovery rule would then leave the row
`SUBMITTED` forever, waiting on a query that could never match. **Task 8 and
Task 10 must read the numeric id from the sibling DEPOSIT payment's
`providerRef`** (`txn:<id>`, written by `charge.success`). The spec's *Refund
recovery* section carries the code.

Only Step 4b remains, and it is optional.

- [x] **Step 1: Create a refundable transaction in test mode** — done (test card via `POST /charge`, ₦100)

A refund needs a *successful* transaction to refund. Drive one through the app's own deposit flow on staging or locally, paying with a Paystack test card, so the transaction exists on the test integration.

- [x] **Step 2: Create a refund carrying a known note** — done (refund `18256918`)

```bash
K=$(grep -o 'PAYSTACK_SECRET_KEY=.*' .env | head -1 | sed 's/PAYSTACK_SECRET_KEY=//;s/"//g')
curl -s https://api.paystack.co/refund -H "Authorization: Bearer $K" \
  -H 'Content-Type: application/json' \
  -d '{"transaction":"<the reference from step 1>","merchant_note":"probe_merchant_note_roundtrip"}'
```

- [x] **Step 3: Read it back and look for the note** — done; note intact, but only when queried by numeric id

```bash
curl -s "https://api.paystack.co/refund?transaction=<the reference>" -H "Authorization: Bearer $K" \
  | python3 -m json.tool
```

- [x] **Step 4: Record the answer in the spec** — done

Replace the spec's *Still unverified* paragraph with what was observed.

- **If `merchant_note` round-trips:** the refund-recovery strategy stands as written. Note the exact field name on the read shape — it may differ from the create field.
- **If it does not:** stop and revisit the design. Do not fall back to amount-and-time matching without saying so explicitly — that is the ambiguous matching the spec rejects, and it would silently reintroduce the risk of adopting the wrong refund. Bring it back for a decision.

- [ ] **Step 4b: Probe concurrent customer creation** *(optional)*

Task 12 serialises customer creation under a row lock, and that lock is
correct regardless of what this probe says. It is worth running only because
a negative answer would let the lock be simplified later. Skip it freely.

```bash
E="probe_$(date +%s)@lrr.ng"
for i in 1 2 3; do
  curl -s https://api.paystack.co/customer -H "Authorization: Bearer $K" \
    -H 'Content-Type: application/json' -d "{\"email\":\"$E\"}" &
done; wait
curl -s "https://api.paystack.co/customer?perPage=10" -H "Authorization: Bearer $K" \
  | python3 -c "import json,sys;print([c['customer_code'] for c in json.load(sys.stdin)['data'] if c['email']=='$E'])"
```

One code back means Paystack dedupes and the row lock could later be relaxed
to a simpler claim. More than one means the lock is load bearing. Record
which in Task 12's comment, either way — **the lock stays in place until
someone deliberately removes it on the strength of this answer.**

- [ ] **Step 5: Commit the spec update**

```bash
git add docs/superpowers/specs/2026-09-12-payment-model-design.md
git commit -m "docs: record whether merchant_note round-trips on Paystack refunds"
```

---

### Task 2: Schema, enums and the two partial indexes

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_payment_model/migration.sql`
- Test: `test/integration/payment-invariants.int-spec.ts`

**Interfaces:**
- Produces: `Payment` model, `PaymentType`, `PaymentStatus`, `PaymentBlockReason`.

- [ ] **Step 1: Add the model**

Copy the model block from the spec's *Model* section into `prisma/schema.prisma`,
**plus one field the spec's block omits**:

```prisma
  // The spec says a payout escalates to staff "after a bounded number of
  // attempts". Nothing can count those without somewhere to keep the count,
  // so PaymentVerifyCheck's escalation is unimplementable without this.
  verifyAttempts  Int      @default(0)

  // Collections only. The checkout URL exists ONLY in the initialize
  // response, and Paystack will not re-issue one for an existing reference —
  // so if that response is lost, the customer can never pay this attempt.
  // Persisting it here is what lets recovery tell "no link was ever sent"
  // (safe to fail and re-attempt) from "the customer may hold a link"
  // (never fail — they could still pay it). RescueRequest.depositPaymentUrl
  // does not serve: it has no equivalent for balance payments, and Payment
  // is the source of truth.
  checkoutUrl     String?
```

Then add the back-relations:

```prisma
model RescueRequest {
  // ...existing fields unchanged...
  payments Payment[]
}

model Operator {
  // ...existing fields unchanged...
  payments Payment[]
}
```

- [ ] **Step 2: Generate the migration without applying it**

Run: `npx prisma migrate dev --name payment_model --create-only`

- [ ] **Step 3: Hand-add the partial indexes**

Prisma cannot express these, so append them to the generated `migration.sql`:

```sql
-- At most one attempt in flight per request and type. BLOCKED counts as in
-- flight: the money movement already exists at Paystack, so a second attempt
-- would duplicate it.
CREATE UNIQUE INDEX "one_inflight_payment_per_type"
  ON "Payment" ("rescueRequestId", "type")
  WHERE status IN ('PENDING', 'SUBMITTED', 'BLOCKED');

-- At most one success per request and type.
CREATE UNIQUE INDEX "one_succeeded_payment_per_type"
  ON "Payment" ("rescueRequestId", "type")
  WHERE status = 'SUCCEEDED';
```

- [ ] **Step 4: Write the failing test**

Create `test/integration/payment-invariants.int-spec.ts`. These assert database behaviour, so they must run against real Postgres — a mocked Prisma cannot demonstrate a partial index.

```ts
import { PrismaService } from '../../src/prisma/prisma.service';
import { createCustomer, createRequest, truncateAll } from './factories';

describe('Payment invariants (integration)', () => {
  let prisma: PrismaService;

  beforeAll(() => { prisma = new PrismaService(); });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(async () => { await truncateAll(prisma); });

  async function request() {
    const customer = await createCustomer(prisma);
    return createRequest(prisma, customer.id);
  }

  const attempt = (rescueRequestId: string, over: Record<string, unknown> = {}) => ({
    rescueRequestId, type: 'DEPOSIT' as const, amount: 500_000, ...over,
  });

  it('permits only one in-flight attempt per request and type', async () => {
    const r = await request();
    await prisma.payment.create({ data: attempt(r.id, { status: 'PENDING' }) });

    await expect(
      prisma.payment.create({ data: attempt(r.id, { status: 'SUBMITTED' }) }),
    ).rejects.toThrow();
  });

  it('counts BLOCKED as in flight — it already exists at Paystack', async () => {
    const r = await request();
    await prisma.payment.create({ data: attempt(r.id, { status: 'BLOCKED' }) });

    await expect(
      prisma.payment.create({ data: attempt(r.id, { status: 'PENDING' }) }),
    ).rejects.toThrow();
  });

  it('permits a fresh attempt after a failed one — that is how retry works', async () => {
    const r = await request();
    await prisma.payment.create({ data: attempt(r.id, { status: 'FAILED' }) });

    const retry = await prisma.payment.create({ data: attempt(r.id, { status: 'PENDING' }) });
    expect(retry.id).toBeDefined();
  });

  it('permits only one success per request and type', async () => {
    const r = await request();
    await prisma.payment.create({ data: attempt(r.id, { status: 'SUCCEEDED' }) });

    await expect(
      prisma.payment.create({ data: attempt(r.id, { status: 'SUCCEEDED' }) }),
    ).rejects.toThrow();
  });

  it('does not confuse types — a deposit and a payout coexist', async () => {
    const r = await request();
    await prisma.payment.create({ data: attempt(r.id, { status: 'PENDING' }) });
    const payout = await prisma.payment.create({
      data: attempt(r.id, { type: 'PAYOUT', status: 'PENDING' }),
    });
    expect(payout.id).toBeDefined();
  });

  it('namespaces providerRef so a transaction id and a refund id can share a number', async () => {
    const a = await request();
    const b = await request();
    await prisma.payment.create({ data: attempt(a.id, { providerRef: 'txn:123' }) });
    const other = await prisma.payment.create({
      data: attempt(b.id, { type: 'REFUND', providerRef: 'refund:123' }),
    });
    expect(other.providerRef).toBe('refund:123');
  });

  it('gives every new row a verifyAfter, so the reconciler can always find it', async () => {
    const r = await request();
    const p = await prisma.payment.create({ data: attempt(r.id) });
    expect(p.verifyAfter).not.toBeNull();
    expect(p.verifyAttempts).toBe(0);
  });
});
```

- [ ] **Step 5: Run it and watch it fail**

Run: `yarn test:integration:up && yarn test:integration payment-invariants`
Expected: FAIL — `prisma.payment` does not exist.

- [ ] **Step 6: Apply and regenerate**

Run: `npx prisma migrate dev && npx prisma generate`

`migrate dev` does **not** reliably regenerate the client in this repo — run `prisma generate` explicitly or the next typecheck will fail on a stale client.

- [ ] **Step 7: Verify**

Run: `yarn test:integration payment-invariants`
Expected: PASS, 7 tests. Then `yarn tsc --noEmit && yarn jest && yarn test:integration`.

Also update the spec's model block to include `verifyAttempts`, so the two documents do not disagree.

- [ ] **Step 8: Commit**

```bash
git add prisma test/integration
git commit -m "feat: add the Payment model with its two partial unique indexes"
```

---

### Task 3: The status mapper

**Files:**
- Create: `src/payment/domain/paystack-status.ts`, `src/payment/domain/paystack-status.spec.ts`

**Interfaces:**
- Produces: `mapTransferStatus`, `mapTransactionStatus`, `mapRefundStatus`, each returning `{ status: PaymentStatus; blockReason?: PaymentBlockReason }`.

Pure functions with no dependencies, so they are unit-tested rather than integration-tested. This is where the spec's *Provider status mapping* table becomes code.

- [ ] **Step 1: Write the failing test**

Create `src/payment/domain/paystack-status.spec.ts`:

```ts
import { mapTransferStatus, mapRefundStatus } from './paystack-status';

describe('mapTransferStatus', () => {
  it('maps a completed transfer to SUCCEEDED', () => {
    expect(mapTransferStatus('success')).toEqual({ status: 'SUCCEEDED' });
  });

  it('maps in-progress states to SUBMITTED — waiting resolves them', () => {
    expect(mapTransferStatus('pending')).toEqual({ status: 'SUBMITTED' });
    expect(mapTransferStatus('processing')).toEqual({ status: 'SUBMITTED' });
  });

  it('maps otp to BLOCKED — waiting never resolves it, a human must', () => {
    expect(mapTransferStatus('otp')).toEqual({
      status: 'BLOCKED', blockReason: 'AWAITING_OTP',
    });
  });

  it('maps abandoned to FAILED — initiated, never finalised, nothing moved', () => {
    // Every transfer on the test integration is in this state; it is what a
    // transfer becomes when OTP is on and nobody answers.
    expect(mapTransferStatus('abandoned')).toEqual({ status: 'FAILED' });
  });

  it('maps failed and reversed to their own terminals', () => {
    expect(mapTransferStatus('failed')).toEqual({ status: 'FAILED' });
    expect(mapTransferStatus('reversed')).toEqual({ status: 'REVERSED' });
  });

  it('treats an unrecognised status as SUBMITTED, never as a terminal', () => {
    // A status Paystack adds later must not be guessed into SUCCEEDED or
    // FAILED. Staying SUBMITTED means the row is polled and a human can see
    // it, which is the safe direction to be wrong in.
    expect(mapTransferStatus('some_future_status')).toEqual({ status: 'SUBMITTED' });
  });
});

describe('mapRefundStatus', () => {
  it('maps needs-attention to BLOCKED', () => {
    expect(mapRefundStatus('needs-attention')).toEqual({
      status: 'BLOCKED', blockReason: 'NEEDS_CUSTOMER_DETAILS',
    });
  });

  it('maps processed to SUCCEEDED and failed to FAILED', () => {
    expect(mapRefundStatus('processed')).toEqual({ status: 'SUCCEEDED' });
    expect(mapRefundStatus('failed')).toEqual({ status: 'FAILED' });
  });

  it('maps pending and processing to SUBMITTED', () => {
    expect(mapRefundStatus('pending')).toEqual({ status: 'SUBMITTED' });
    expect(mapRefundStatus('processing')).toEqual({ status: 'SUBMITTED' });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `yarn jest paystack-status`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/payment/domain/paystack-status.ts`:

```ts
import { PaymentBlockReason, PaymentStatus } from '@prisma/client';

export interface MappedStatus {
  status: PaymentStatus;
  blockReason?: PaymentBlockReason;
}

/**
 * Paystack's transfer statuses, observed on the live test integration
 * 2026-09-12 rather than taken from documentation.
 *
 * The default matters as much as the cases: an unrecognised status must NOT
 * be guessed into a terminal state. Staying SUBMITTED keeps the row polled
 * and visible, which is the safe direction to be wrong in — a wrong
 * SUCCEEDED marks money as moved that has not.
 */
export function mapTransferStatus(status: string): MappedStatus {
  switch (status) {
    case 'success':
      return { status: 'SUCCEEDED' };
    case 'failed':
      return { status: 'FAILED' };
    case 'reversed':
      return { status: 'REVERSED' };
    // Initiated and never finalised — the OTP path, left unanswered. Nothing
    // moved (transferred_at null, fee_charged 0) and it will not resume.
    case 'abandoned':
      return { status: 'FAILED' };
    case 'otp':
      return { status: 'BLOCKED', blockReason: 'AWAITING_OTP' };
    default:
      return { status: 'SUBMITTED' };
  }
}

export function mapTransactionStatus(status: string): MappedStatus {
  switch (status) {
    case 'success':
      return { status: 'SUCCEEDED' };
    case 'failed':
    case 'reversed':
      return { status: status === 'failed' ? 'FAILED' : 'REVERSED' };
    default:
      return { status: 'SUBMITTED' };
  }
}

export function mapRefundStatus(status: string): MappedStatus {
  switch (status) {
    case 'processed':
      return { status: 'SUCCEEDED' };
    case 'failed':
      return { status: 'FAILED' };
    case 'needs-attention':
      return { status: 'BLOCKED', blockReason: 'NEEDS_CUSTOMER_DETAILS' };
    default:
      return { status: 'SUBMITTED' };
  }
}
```

- [ ] **Step 4: Verify and commit**

Run: `yarn jest paystack-status` — PASS. Then the full suite.

```bash
git add src/payment/domain
git commit -m "feat: map Paystack provider statuses onto payment states"
```

---

### Task 4: `PaymentLedgerService` — the submission protocol

**Files:**
- Create: `src/payment/payment.constants.ts`, `src/payment/payment-ledger.service.ts`
- Create: `test/integration/payment-ledger.int-spec.ts`
- Modify: `src/payment/payment.module.ts`

**Interfaces:**
- Produces:
  ```ts
  create(input: { rescueRequestId: string; type: PaymentType; amount: number; operatorId?: string }): Promise<Payment>
  claimForSubmission(paymentId: string, now: Date): Promise<boolean>   // the CAS; false means someone else won
  referenceFor(payment: Payment): string
  recordRejection(paymentId: string, reason: string, blockReason?: PaymentBlockReason): Promise<void>
  recordBlocked(paymentId: string, blockReason: PaymentBlockReason): Promise<void>
  claimTerminal(paymentId: string, mapped: MappedStatus, fields?: { providerRef?: string; providerFee?: number; netAmount?: number }): Promise<boolean>
  backOff(paymentId: string, now: Date): Promise<void>
  ```

This is the single place the protocol lives. Every flow in Tasks 5–8 calls it rather than re-implementing the ordering, because the ordering is the correctness.

- [ ] **Step 1: The constants**

Create `src/payment/payment.constants.ts`:

```ts
import { PaymentType } from '@prisma/client';

/**
 * Reference prefixes. DEP and BAL are unchanged from the live format — only
 * what follows them changes, from a timestamp-plus-random string to the row
 * id. Renaming working references would buy nothing.
 *
 * Payouts use lowercase because Paystack documents transfer references as
 * lowercase alphanumerics plus `_` and `-`. Refunds send no reference at all;
 * they carry the id in merchant_note instead.
 */
export const REFERENCE_PREFIX: Record<PaymentType, string> = {
  DEPOSIT: 'DEP',
  BALANCE: 'BAL',
  PAYOUT: 'payout',
  REFUND: '',
};

/**
 * How long after submission before a row may be verified.
 *
 * Load bearing: without it a row is eligible the instant the CAS commits,
 * so another instance can verify while the POST is still in flight, see
 * "not found", and fail a payment that is about to succeed.
 */
export const INITIAL_VERIFY_DELAY_MS = 60 * 1000;

/** Backoff doubles from INITIAL_VERIFY_DELAY_MS, capped here. */
export const MAX_VERIFY_BACKOFF_MS = 30 * 60 * 1000;

/** After this many verification attempts, stop guessing and tell a human. */
export const MAX_VERIFY_ATTEMPTS = 8;
```

- [ ] **Step 2: Write the failing test**

Create `test/integration/payment-ledger.int-spec.ts`:

```ts
import { PaymentLedgerService } from '../../src/payment/payment-ledger.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createCustomer, createRequest, truncateAll } from './factories';

describe('PaymentLedgerService (integration)', () => {
  let prisma: PrismaService;
  let ledger: PaymentLedgerService;

  beforeAll(() => {
    prisma = new PrismaService();
    ledger = new PaymentLedgerService(prisma);
  });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(async () => { await truncateAll(prisma); });

  async function pending() {
    const customer = await createCustomer(prisma);
    const request = await createRequest(prisma, customer.id);
    const payment = await ledger.create({
      rescueRequestId: request.id, type: 'DEPOSIT', amount: 500_000,
    });
    return { request, payment };
  }

  it('creates a row already chaseable by the reconciler', async () => {
    const { payment } = await pending();
    expect(payment.status).toBe('PENDING');
    expect(payment.verifyAfter).not.toBeNull();
  });

  it('formats the reference from the id, keeping the live DEP_ prefix', async () => {
    const { payment } = await pending();
    expect(ledger.referenceFor(payment)).toBe(`DEP_${payment.id}`);
  });

  it('pushes verifyAfter into the future when it claims for submission', async () => {
    const { payment } = await pending();
    const before = new Date();

    expect(await ledger.claimForSubmission(payment.id, before)).toBe(true);

    const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(after.status).toBe('SUBMITTED');
    // Without this, a concurrent verification could see the row while the
    // POST is still in flight and fail a payment that is about to succeed.
    expect(after.verifyAfter.getTime()).toBeGreaterThan(before.getTime());
  });

  it('lets exactly one caller win the submission claim', async () => {
    const { payment } = await pending();

    const results = await Promise.all([
      ledger.claimForSubmission(payment.id, new Date()),
      ledger.claimForSubmission(payment.id, new Date()),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('claims a terminal state only from SUBMITTED', async () => {
    const { payment } = await pending();
    await ledger.claimForSubmission(payment.id, new Date());

    expect(await ledger.claimTerminal(payment.id, { status: 'SUCCEEDED' })).toBe(true);
    // A webhook and a verification racing: the second finds nothing to claim.
    expect(await ledger.claimTerminal(payment.id, { status: 'FAILED' })).toBe(false);

    const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(after.status).toBe('SUCCEEDED');
    expect(after.settledAt).not.toBeNull();
  });

  it('records fees alongside the terminal claim', async () => {
    const { payment } = await pending();
    await ledger.claimForSubmission(payment.id, new Date());

    await ledger.claimTerminal(payment.id, { status: 'SUCCEEDED' }, {
      providerRef: 'txn:987', providerFee: 7_500, netAmount: 492_500,
    });

    const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(after.providerFee).toBe(7_500);
    expect(after.netAmount).toBe(492_500);
    expect(after.providerRef).toBe('txn:987');
  });

  it('backs off exponentially rather than polling hard', async () => {
    const { payment } = await pending();
    await ledger.claimForSubmission(payment.id, new Date());

    const first = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    await ledger.backOff(payment.id, new Date());
    const second = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });

    expect(second.verifyAfter.getTime()).toBeGreaterThan(first.verifyAfter.getTime());
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `yarn test:integration payment-ledger`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

Create `src/payment/payment-ledger.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import {
  Payment, PaymentBlockReason, PaymentStatus, PaymentType, Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MappedStatus } from './domain/paystack-status';
import {
  INITIAL_VERIFY_DELAY_MS, MAX_VERIFY_BACKOFF_MS, REFERENCE_PREFIX,
} from './payment.constants';

/**
 * The submission protocol, in one place.
 *
 * Every money-moving flow goes through this service rather than writing its
 * own status transitions, because the ORDERING is the correctness: the row
 * is committed before the call, the claim precedes the call, and only a
 * webhook or verification produces SUCCEEDED. A flow that re-implements any
 * of that will eventually get one of them wrong.
 */
@Injectable()
export class PaymentLedgerService {
  constructor(private readonly prisma: PrismaService) {}

  /** Step 1 — committed before anything leaves. */
  async create(input: {
    rescueRequestId: string;
    type: PaymentType;
    amount: number;
    operatorId?: string;
    tx?: Prisma.TransactionClient;
  }): Promise<Payment> {
    const client = input.tx ?? this.prisma;
    return client.payment.create({
      data: {
        rescueRequestId: input.rescueRequestId,
        type: input.type,
        amount: input.amount,
        operatorId: input.operatorId ?? null,
      },
    });
  }

  /**
   * Step 2 — the CAS, which MUST happen before the HTTP call.
   *
   * Pushing verifyAfter out in the same update is not an optimisation: a row
   * left at its creation-time verifyAfter is eligible for verification while
   * its own POST is in flight, and a concurrent check would see "not found"
   * and fail a payment that is about to succeed.
   *
   * Returns false when another caller — the reconciler and the request
   * handler can both reach here — already claimed it. The loser must NOT
   * call Paystack.
   */
  async claimForSubmission(paymentId: string, now: Date): Promise<boolean> {
    const { count } = await this.prisma.payment.updateMany({
      where: { id: paymentId, status: PaymentStatus.PENDING },
      data: {
        status: PaymentStatus.SUBMITTED,
        verifyAfter: new Date(now.getTime() + INITIAL_VERIFY_DELAY_MS),
      },
    });
    return count === 1;
  }

  /** The Paystack reference. Refunds get '' and use merchant_note instead. */
  referenceFor(payment: Pick<Payment, 'id' | 'type'>): string {
    const prefix = REFERENCE_PREFIX[payment.type];
    return prefix ? `${prefix}_${payment.id}` : '';
  }

  /** Step 4 — an explicit rejection. Never called for a duplicate reference. */
  async recordRejection(
    paymentId: string,
    failureReason: string,
    blockReason?: PaymentBlockReason,
  ): Promise<void> {
    await this.prisma.payment.updateMany({
      where: { id: paymentId, status: PaymentStatus.SUBMITTED },
      data: { status: PaymentStatus.FAILED, failureReason, blockReason: blockReason ?? null },
    });
  }

  /** Step 4 — reached Paystack, which is now waiting on a human. */
  async recordBlocked(paymentId: string, blockReason: PaymentBlockReason): Promise<void> {
    await this.prisma.payment.updateMany({
      where: { id: paymentId, status: PaymentStatus.SUBMITTED },
      data: { status: PaymentStatus.BLOCKED, blockReason },
    });
  }

  /**
   * Step 5 — the only path to SUCCEEDED, and the only path out of SUBMITTED
   * for a terminal outcome.
   *
   * The guard is the query. A webhook and a verification WILL race for the
   * same payment once both exist; whichever arrives second gets false and
   * does nothing.
   */
  async claimTerminal(
    paymentId: string,
    mapped: MappedStatus,
    fields: { providerRef?: string; providerFee?: number; netAmount?: number } = {},
  ): Promise<boolean> {
    const terminal =
      mapped.status === PaymentStatus.SUCCEEDED ||
      mapped.status === PaymentStatus.FAILED ||
      mapped.status === PaymentStatus.REVERSED;

    const { count } = await this.prisma.payment.updateMany({
      where: { id: paymentId, status: { in: [PaymentStatus.SUBMITTED, PaymentStatus.BLOCKED] } },
      data: {
        status: mapped.status,
        blockReason: mapped.blockReason ?? null,
        settledAt: terminal ? new Date() : null,
        ...(fields.providerRef ? { providerRef: fields.providerRef } : {}),
        ...(fields.providerFee !== undefined ? { providerFee: fields.providerFee } : {}),
        ...(fields.netAmount !== undefined ? { netAmount: fields.netAmount } : {}),
      },
    });
    return count === 1;
  }

  /** Paystack still says pending — come back later rather than polling hard. */
  async backOff(paymentId: string, now: Date): Promise<void> {
    const payment = await this.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    const elapsed = Math.max(
      INITIAL_VERIFY_DELAY_MS,
      now.getTime() - payment.createdAt.getTime(),
    );
    const next = Math.min(elapsed * 2, MAX_VERIFY_BACKOFF_MS);
    await this.prisma.payment.update({
      where: { id: paymentId },
      data: {
        verifyAfter: new Date(now.getTime() + next),
        // Counted so PaymentVerifyCheck can stop guessing and escalate.
        verifyAttempts: { increment: 1 },
      },
    });
  }
}
```

- [ ] **Step 5: Register it**

Add `PaymentLedgerService` to `PaymentModule`'s `providers` and `exports` — Tasks 5–10 inject it from other modules.

- [ ] **Step 6: Verify and commit**

Run: `yarn test:integration payment-ledger` — PASS, 7 tests. Then the full suite.

```bash
git add src/payment test/integration
git commit -m "feat: add the payment ledger and its submission protocol"
```

---

### Task 5: Deposits write Payment rows

**Files:**
- Modify: `src/rescue-request/whatsapp-customer-flow.service.ts` (`initiateDeposit` ~line 715, `handleQuoteSelected` ~line 950), `src/rescue-request/rescue-request-admin.service.ts` (~line 160)
- Create: `test/integration/payment-deposit-flow.int-spec.ts`

**Interfaces:**
- Consumes: `PaymentLedgerService`.

All three deposit sites follow the same shape. **The existing `depositReference` / `depositPaymentUrl` writes stay** — Task 10 removes them, and until then both records exist so nothing downstream breaks.

- [ ] **Step 0: Make `initializePayment` classify**

This is the first flow converted, so the classification shape is defined here
and Tasks 7 and 8 follow it:

```ts
  async initializePayment(params: InitializePaymentParams): Promise<{
    outcome: 'ok' | 'rejected' | 'ambiguous';
    data?: { authorization_url: string; access_code: string; reference: string };
    code?: string; message?: string;
  }> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/transaction/initialize`, { /* …unchanged… */ });
    } catch (error) {
      // Never a rejection: the request may have landed.
      return { outcome: 'ambiguous', message: (error as Error).message };
    }
    const data = await response.json().catch(() => ({}) as Record<string, unknown>);
    if (!data.status || !data.data) {
      if (response.status >= 500) return { outcome: 'ambiguous', message: data.message };
      return { outcome: 'rejected', code: data.code, message: data.message };
    }
    return { outcome: 'ok', data: data.data };
  }
```

Without this, the rest of this task cannot distinguish "no link was created"
from "a link may exist that we never saw" — and that distinction is the whole
of the recovery rule in Task 10, Step 3b.

- [ ] **Step 1: Convert one site, with the protocol in the right order**

In `initiateDeposit`, replace the inline reference generation:

```ts
    // 1. Committed before anything leaves.
    const payment = await this.paymentLedger.create({
      rescueRequestId: rescueRequest.id,
      type: 'DEPOSIT',
      amount: amountKobo,
    });

    // 2. Claim BEFORE the call, pushing verifyAfter out.
    if (!(await this.paymentLedger.claimForSubmission(payment.id, new Date()))) {
      // The reconciler beat us to it; it owns the call now.
      return this.reply(`We're setting up your payment — you'll get a link shortly.`);
    }
    const reference = this.paymentLedger.referenceFor(payment);

    // 3. Call Paystack.
    const paymentResponse = await this.paystackService.initializePayment({
      email, amount: amountKobo, reference,
      metadata: { rescueRequestId: rescueRequest.id, customerId: customer.id, phoneNumber, type: 'deposit' },
    });

    // 4. Classified exactly like transfers and refunds — a 5xx or a dropped
    //    connection is ambiguous, not a rejection. Only a definitive 4xx
    //    fails the row.
    if (paymentResponse.outcome === 'ambiguous') {
      // Paystack may hold a transaction under this reference, and we have no
      // URL for it. Leave it SUBMITTED; PaymentVerifyCheck decides, and it
      // can only do so because checkoutUrl is still null here.
      return this.reply(`We're still setting up your payment — hold on a moment.`);
    }
    if (paymentResponse.outcome === 'rejected') {
      await this.paymentLedger.recordRejection(
        payment.id,
        paymentResponse.message ?? 'initialize failed',
      );
      return this.reply(`Sorry, we couldn't create a payment link. Please try again.`);
    }

    // 5. Persist the URL BEFORE sending it. Once this commits, recovery must
    //    never fail this attempt: the customer may act on the link.
    await this.prisma.payment.update({
      where: { id: payment.id },
      data: { checkoutUrl: paymentResponse.data.authorization_url },
    });
```

Leave the existing `depositReference` / `depositPaymentUrl` update in place, but write `reference` — now `DEP_<payment.id>` — into it.

- [ ] **Step 2: Repeat for the other two sites**

`handleQuoteSelected` and `RescueRequestAdminService.assignOperator` take the same treatment, with `type: 'DEPOSIT'` and their own amounts. The admin path throws rather than replying, so its rejection branch keeps `throw new BadRequestException(...)` after recording.

- [ ] **Step 3: Write the integration test**

Create `test/integration/payment-deposit-flow.int-spec.ts`, driving `initiateDeposit` with a stubbed Paystack and asserting:

```ts
  it('commits the row before calling Paystack, and leaves it SUBMITTED on a 2xx', async () => {
    let statusDuringCall: string | undefined;
    paystack.initializePayment.mockImplementation(async () => {
      // The row must already exist and be claimed while the call is in flight.
      const row = await prisma.payment.findFirstOrThrow({ where: { type: 'DEPOSIT' } });
      statusDuringCall = row.status;
      return { status: true, data: { authorization_url: 'https://pay/x', access_code: 'x', reference: 'y' } };
    });

    await service.initiateDeposit(/* … */);

    expect(statusDuringCall).toBe('SUBMITTED');
    const after = await prisma.payment.findFirstOrThrow({ where: { type: 'DEPOSIT' } });
    // A checkout URL is not a payment.
    expect(after.status).toBe('SUBMITTED');
  });

  it('records a definitive rejection as FAILED, so a retry is legal', async () => {
    paystack.initializePayment.mockResolvedValue({ outcome: 'rejected', message: 'nope' });

    await service.initiateDeposit(/* … */);

    const after = await prisma.payment.findFirstOrThrow({ where: { type: 'DEPOSIT' } });
    expect(after.status).toBe('FAILED');
    expect(after.failureReason).toBe('nope');
  });

  it('leaves an ambiguous initialize SUBMITTED with no checkoutUrl', async () => {
    // The pair (SUBMITTED, checkoutUrl null) is exactly what tells recovery
    // that no link ever reached the customer.
    paystack.initializePayment.mockResolvedValue({ outcome: 'ambiguous', message: '503' });

    await service.initiateDeposit(/* … */);

    const after = await prisma.payment.findFirstOrThrow({ where: { type: 'DEPOSIT' } });
    expect(after.status).toBe('SUBMITTED');
    expect(after.checkoutUrl).toBeNull();
  });

  it('persists the checkout URL before sending it', async () => {
    await service.initiateDeposit(/* … */);
    const after = await prisma.payment.findFirstOrThrow({ where: { type: 'DEPOSIT' } });
    expect(after.checkoutUrl).toBe('https://pay/x');
  });

  it('uses the row id as the reference', async () => {
    await service.initiateDeposit(/* … */);
    const row = await prisma.payment.findFirstOrThrow({ where: { type: 'DEPOSIT' } });
    expect(paystack.initializePayment).toHaveBeenCalledWith(
      expect.objectContaining({ reference: `DEP_${row.id}` }),
    );
  });
```

- [ ] **Step 4: Verify and commit**

Run the full suite.

```bash
git add -A src test
git commit -m "feat: deposits create Payment rows under the submission protocol"
```

---

### Task 6: Balance payments write Payment rows

**Files:**
- Modify: `src/rescue-request/payment-events.service.ts` (~line 356)
- Test: extend `test/integration/payment-deposit-flow.int-spec.ts`

Mechanically identical to Task 5 with `type: 'BALANCE'` and the `BAL` prefix. One site.

- [ ] **Step 1: Convert the balance initialization**

Same five-step shape as Task 5, with `type: 'BALANCE'`.

- [ ] **Step 2: Add its test**

Assert the reference is `BAL_<id>` and that a deposit and a balance coexist on one request — the partial index is per `(request, type)`, so both being in flight at once is legal and must not throw.

- [ ] **Step 3: Verify and commit**

```bash
git add -A src test
git commit -m "feat: balance payments create Payment rows"
```

---

### Task 7: Payouts move onto the ledger

**Files:**
- Modify: `src/payout/payout.service.ts`, `src/integrations/paystack/paystack.service.ts`
- Create: `test/integration/payment-payout-flow.int-spec.ts`

**Interfaces:**
- Produces: `initiateTransfer` returning the raw status so the caller can map it, rather than throwing on non-success.

This is the task that fixes the live bug.

**The `Payout` row keeps being written and transitioned**, exactly as today,
alongside the new `Payment` row. That is the additive-migration rule from the
Global Constraints, and it is what keeps the 86 existing `Payout` readers
working through Tasks 7–10. It is duplicated bookkeeping and it is temporary:
Task 11 deletes the table and its readers together. Do not skip it — without
it these intermediate commits ship a payout admin screen showing nothing.

- [ ] **Step 1: Make `initiateTransfer` report rather than throw**

Its current shape throws on `!data.status`, which erases the difference between a rejection and a duplicate reference. Return the payload instead:

```ts
  async initiateTransfer(params: {
    recipientCode: string; amount: number; reference: string; reason: string;
  }): Promise<{
    outcome: 'ok' | 'rejected' | 'ambiguous';
    status?: string; transferCode?: string; code?: string; message?: string;
  }> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/transfer`, { /* …unchanged… */ });
    } catch (error) {
      // The request may have landed. Ambiguous, never a rejection.
      return { outcome: 'ambiguous', message: (error as Error).message };
    }
    const data = await res.json().catch(() => ({}) as Record<string, unknown>);

    if (!data.status || !data.data) {
      // A 5xx tells us nothing about whether the transfer landed; only a 4xx
      // with a provider code is definitive. Getting this wrong is a
      // double-pay: FAILED makes a fresh reference legal.
      if (res.status >= 500) return { outcome: 'ambiguous', message: data.message };
      // `code` is Paystack's machine-readable error identifier. Branch on it,
      // never on `message`, which is prose and not a contract.
      return { outcome: 'rejected', code: data.code, message: data.message };
    }
    return { outcome: 'ok', status: data.data.status, transferCode: data.data.transfer_code };
  }
```

- [ ] **Step 2: Rewrite `attemptPayout` onto the protocol**

```ts
    // The legacy row, unchanged — see the dual-write note above.
    // Every branch below that moves the Payment must move this too.
    const payout = await this.prisma.payout.findUniqueOrThrow({ where: { rescueRequestId } });

    const payment = await this.paymentLedger.create({
      rescueRequestId, type: 'PAYOUT', amount, operatorId: operator.id,
    });
    if (!(await this.paymentLedger.claimForSubmission(payment.id, new Date()))) return;

    const result = await this.paystackService.initiateTransfer({
      recipientCode: operator.paystackRecipientCode,
      amount,
      reference: this.paymentLedger.referenceFor(payment),
      reason: `Job payout — ${rescueRequestId}`,
    });

    // Ambiguous first: a 5xx or a dropped connection may still have moved
    // money, so it stays SUBMITTED and verification resolves it.
    if (result.outcome === 'ambiguous') return;

    if (result.outcome === 'rejected') {
      // A duplicate reference is POSITIVE EVIDENCE the original landed — the
      // opposite of a rejection. Marking it FAILED would make a new row and a
      // new reference legal, which is the double-pay this design prevents.
      if (isDuplicateReference(result)) return;   // stays SUBMITTED
      await this.paymentLedger.recordRejection(payment.id, result.message ?? 'transfer rejected');
      await this.prisma.payout.update({
        where: { id: payout.id },
        data: { status: 'FAILED', failureReason: result.message ?? 'transfer rejected' },
      });
      return;
    }

    // Record the transfer code regardless — it is useful context even
    // though verification keys on our own reference.
    await this.prisma.payment.update({
      where: { id: payment.id },
      data: { providerRef: `trf:${result.transferCode}` },
    });

    // A 2xx is not success. `pending` and `otp` are both possible, and even
    // a body saying `success` may NOT be claimed here: SUCCEEDED comes only
    // from a webhook or from verification. From this point the response may
    // move the row to BLOCKED or to a definitive failure, and nowhere else.
    const mapped = mapTransferStatus(result.status!);
    if (mapped.status === 'BLOCKED') {
      await this.paymentLedger.recordBlocked(payment.id, mapped.blockReason!);
    } else if (mapped.status === 'FAILED' || mapped.status === 'REVERSED') {
      await this.paymentLedger.claimTerminal(payment.id, mapped);
    }
    // Everything else — including `success` — stays SUBMITTED.
```

`isDuplicateReference` is a small local predicate that matches Paystack's duplicate-reference `code` **and** falls back to a message match, so a wording change cannot silently turn a duplicate into a rejection:

```ts
function isDuplicateReference(r: { code?: string; message?: string }): boolean {
  if (r.code === 'duplicate_reference') return true;
  return /reference.*(already|used|exist)/i.test(r.message ?? '');
}
```

- [ ] **Step 3: Test the three outcomes that matter**

```ts
  it('leaves a transfer returning otp BLOCKED, not SUBMITTED — polling would never finish it', async () => { /* … */ });
  it('maps abandoned to FAILED — the live bug', async () => { /* … */ });
  it('treats a duplicate reference as evidence the original landed, not as a rejection', async () => {
    paystack.initiateTransfer.mockResolvedValue({ outcome: 'rejected', code: 'duplicate_reference' });
    await service.attemptPayout(/* … */);
    const row = await prisma.payment.findFirstOrThrow({ where: { type: 'PAYOUT' } });
    expect(row.status).toBe('SUBMITTED');   // NOT FAILED
  });
```

- [ ] **Step 4: Verify and commit**

```bash
git add -A src test
git commit -m "feat: payouts move onto the ledger, handling otp and abandoned"
```

---

### Task 8: Refunds write Payment rows

**Files:**
- Modify: `src/rescue-request/rescue-request-admin.service.ts` (`refundDeposit`, ~line 237), `src/integrations/paystack/paystack.service.ts`
- Create: `test/integration/payment-refund-flow.int-spec.ts`

Refunds are the one type with no caller reference, so this task is **not** a
copy of Tasks 5–7. Read the spec's *Refund recovery* before starting, and do
not begin until Task 1 has established that `merchant_note` round-trips.

- [ ] **Step 1: Send the note**

`refundTransaction` currently posts `{ transaction, amount }` and discards
everything else. Add the note, which is the only identifier of ours that
travels:

```ts
  async refundTransaction(params: {
    transaction: string;
    amount: number;
    merchantNote: string;   // our Payment.id — the sole recovery handle
  }): Promise<{
    outcome: 'ok' | 'rejected' | 'ambiguous';
    id?: number; status?: string; code?: string; message?: string;
  }> {
    const response = await fetch(`${this.baseUrl}/refund`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.secretKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transaction: params.transaction,
        amount: params.amount,
        merchant_note: params.merchantNote,
      }),
    });
    const data = await response.json().catch(() => ({}) as Record<string, unknown>);
    if (!data.status || !data.data) {
      if (response.status >= 500) return { outcome: 'ambiguous', message: data.message };
      return { outcome: 'rejected', code: data.code, message: data.message };
    }
    return { outcome: 'ok', id: data.data.id, status: data.data.status };
  }
```

- [ ] **Step 2: Put `refundDeposit` on the protocol**

Same first three steps as the other flows, then a fourth that differs:

```ts
    const payment = await this.paymentLedger.create({
      rescueRequestId: id, type: 'REFUND', amount: depositAmount,
    });
    if (!(await this.paymentLedger.claimForSubmission(payment.id, new Date()))) {
      throw new BadRequestException('A refund is already in progress for this request');
    }

    const result = await this.paystackService.refundTransaction({
      transaction: depositReference,
      amount: depositAmount,
      merchantNote: payment.id,        // NOT the formatted reference — the bare id
    });

    // No duplicate-reference protection exists for refunds, so an ambiguous
    // failure must NOT become FAILED: FAILED makes a second attempt legal,
    // and a second attempt is a second refund. Leave it SUBMITTED and let
    // verification adopt whatever landed.
    if (result.outcome === 'ambiguous') {
      throw new BadRequestException(
        `Refund status unknown — it is being verified. Do not retry yet.`,
      );
    }
    if (result.outcome === 'rejected') {
      await this.paymentLedger.recordRejection(payment.id, result.message ?? 'refund rejected');
      throw new BadRequestException(`Refund failed: ${result.message}`);
    }

    // providerRef first: it is how the refund webhook will find this row,
    // since refunds carry no reference of ours.
    await this.prisma.payment.update({
      where: { id: payment.id },
      data: { providerRef: `refund:${result.id}` },
    });

    // As with transfers, the POST may not produce SUCCEEDED — `processed`
    // included. Only BLOCKED and a definitive failure may come from here.
    const mapped = mapRefundStatus(result.status!);
    if (mapped.status === 'BLOCKED') {
      await this.paymentLedger.recordBlocked(payment.id, mapped.blockReason!);
    } else if (mapped.status === 'FAILED') {
      await this.paymentLedger.claimTerminal(payment.id, mapped);
    }
    // Everything else — including `processed` — stays SUBMITTED.
```

`refundTransaction` classifies exactly as `initiateTransfer` does — a thrown
network error or a 5xx is `ambiguous`, a 4xx with a provider `code` is
`rejected`. The admin sees a different message in each case, because "unknown,
being verified, do not retry" and "rejected, try again" are genuinely
different instructions.

- [ ] **Step 3: Test the property that makes refunds different**

```ts
  it('never fails a refund on an ambiguous error — a second attempt would refund twice', async () => {
    paystack.refundTransaction.mockRejectedValue(new Error('socket hang up'));

    await service.refundDeposit('req-1').catch(() => undefined);

    const row = await prisma.payment.findFirstOrThrow({ where: { type: 'REFUND' } });
    expect(row.status).toBe('SUBMITTED');   // NOT FAILED
  });

  it('sends the bare Payment.id as merchant_note, not the formatted reference', async () => {
    await service.refundDeposit('req-1');
    const row = await prisma.payment.findFirstOrThrow({ where: { type: 'REFUND' } });
    expect(paystack.refundTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ merchantNote: row.id }),
    );
  });

  it('refuses a second refund while one is in flight — the index enforces it', async () => {
    await service.refundDeposit('req-1');
    await expect(service.refundDeposit('req-1')).rejects.toThrow();
  });

  it('permits a retry after a rejected refund — a failed row is history, not a claim', async () => {
    paystack.refundTransaction.mockResolvedValue({ outcome: 'rejected', message: 'nope' });
    await service.refundDeposit('req-1').catch(() => undefined);

    paystack.refundTransaction.mockResolvedValue({ outcome: 'ok', id: 42, status: 'pending' });
    await expect(service.refundDeposit('req-1')).resolves.not.toThrow();

    expect(await prisma.payment.count({ where: { type: 'REFUND' } })).toBe(2);
  });
```

- [ ] **Step 4: Verify and commit**

Run the full suite.

```bash
git add -A src test
git commit -m "feat: refunds create Payment rows and carry their id in merchant_note"
```

---

### Task 9: Webhooks claim terminal states

**Files:**
- Modify: `src/payment/payment.service.ts`
- Create: `test/integration/payment-webhooks.int-spec.ts`

- [ ] **Step 1: Route every event through `claimTerminal`**

`charge.success`, `transfer.success`, `transfer.failed`, `transfer.reversed`, and — new — `refund.processed` and `refund.failed`, which are handled nowhere today despite a code comment claiming they are.

Resolution differs by type, and **refunds are not like the others**:

| Event | How the `Payment` is found |
|---|---|
| `charge.success` | strip the `DEP_`/`BAL_` prefix from `data.reference`, look up by id |
| `transfer.*` | strip the `payout_` prefix from `data.reference`, look up by id |
| `refund.*` | `providerRef = refund:<data.id>`; `merchant_note` is present on refund records (verified) and is the fallback |

A refund carries no reference of ours, so prefix-stripping cannot work for it.
`providerRef` was written on the create response in Task 8, which covers the
ordinary case. **If that response was lost, the row has no `providerRef` and
the webhook cannot find it** — that is exactly what `PaymentVerifyCheck`'s
refund branch is for, so a refund webhook that matches nothing must log and
return rather than treating the absence as an error.

Capture `providerFee` and `netAmount`: from `data.fees` on a charge, from
`fee_charged` on a transfer.

- [ ] **Step 2: Keep the existing side effects**

`charge.success` currently drives real business logic — marking the request `OPERATOR_ASSIGNED`, awarding the offer, sending messages. **None of that changes in this task.** Only the payment bookkeeping moves; the business transition stays exactly where it is until Task 11.

- [ ] **Step 3: Test the race explicitly**

```ts
  it('a webhook and a verification racing the same payment produce one transition', async () => {
    // Both call claimTerminal; the second must find nothing to claim.
  });
```

- [ ] **Step 4: Verify and commit**

```bash
git add -A src test
git commit -m "feat: webhooks claim payment terminal states, including refunds"
```

---

### Task 10: `PaymentVerifyCheck`

**Files:**
- Create: `src/rescue-request/reconciler/checks/payment-verify.check.ts`, `test/integration/reconciler-payment-verify.int-spec.ts`
- Modify: `src/rescue-request/rescue-request.module.ts`

The seventh check, following the same `ReconcilerCheck` contract as the six built in the durable-scheduling work.

- [ ] **Step 1: The two branches**

`PENDING` → initiate (CAS, then the first call, and for a collection **persist and send the checkout URL** — a recovered deposit the customer cannot pay is worse than the crash). `SUBMITTED` → verify. `BLOCKED` is excluded from the `where` entirely.

- [ ] **Step 2: Verify by our reference, per type**

`GET /transaction/verify/:reference` for collections, `GET /transfer/verify/:reference` for payouts. Branch on `code`: `not_found` (404) and `transaction_not_found` (400).

Refunds are the exception and the one easy to get wrong:
`GET /refund?transaction=` takes Paystack's **numeric transaction id**, not
our reference — given the reference it returns `200` with an empty list, which
is indistinguishable from "no refund exists". Read the numeric id from the
sibling `DEPOSIT` payment's `providerRef` (`txn:<id>`); if that deposit has no
`providerRef`, escalate to staff rather than polling a query that cannot
match. The spec's *Refund recovery* section carries the code.

- [ ] **Step 3: Respect the inbound/outbound asymmetry**

A not-found fails an inbound payment and does **not** fail an outbound one. A payout re-submits the same reference; a refund never re-submits. After `MAX_VERIFY_ATTEMPTS`, alert staff rather than guessing.

- [ ] **Step 3b: The unpayable-collection rule**

A `SUBMITTED` collection needs more than "not found or not". The checkout URL
lives only in the initialize response, and Paystack will not issue a second
one for an existing reference — so a lost response leaves a transaction
nobody can pay. Polling it forever is the stranded state this check exists to
remove, so the branch is explicit:

```ts
// A SUBMITTED DEPOSIT or BALANCE, after verification:
if (verified.status === 'success') {
  await ledger.claimTerminal(payment.id, { status: 'SUCCEEDED' }, { … });

} else if (notFound) {
  // Paystack never heard of the reference: the POST did not land. Nothing
  // moved and no link exists. Fail it; a fresh attempt is correct.
  await ledger.claimTerminal(payment.id, { status: 'FAILED' });

} else if (payment.checkoutUrl === null) {
  // Paystack HAS the transaction, but the response carrying its URL was
  // lost — so no link ever reached the customer and none can be re-issued
  // for this reference. This attempt is unpayable by construction.
  //
  // Failing is safe precisely because the customer cannot have a link: the
  // inbound double-pay risk needs someone able to pay twice, and nobody can
  // pay this one at all. A fresh attempt gets a new reference and a new URL.
  await ledger.claimTerminal(payment.id, { status: 'FAILED' });

} else {
  // We hold the URL, so the customer may have it — or may have missed the
  // message. Re-send it and back off. NEVER fail this branch: they could pay
  // a link we had written off, leaving money received against a dead row.
  await this.resendCheckoutLink(payment);
  await ledger.backOff(payment.id, now);
}
```

The discriminator is `checkoutUrl`, which is why Task 5 persists it *before*
sending. That ordering is what makes these two branches distinguishable at
all.

- [ ] **Step 4: Test all of it**

Every case from the spec's *Testing* section that concerns verification, including the asymmetry test with its comment explaining that it is deliberate. Plus the four collection branches:

```ts
  it('fails an unpayable collection — Paystack has it, we never got the URL', async () => {
    // The lost-initialize-response case. Nobody can pay this reference and
    // Paystack will not re-issue one, so it must not be polled forever.
    const p = await submittedDeposit({ checkoutUrl: null });
    paystack.verifyTransaction.mockResolvedValue({ outcome: 'ok', status: 'abandoned' });

    await check.run(new Date());

    expect((await reload(p)).status).toBe('FAILED');
  });

  it('never fails a collection whose URL the customer may hold', async () => {
    const p = await submittedDeposit({ checkoutUrl: 'https://pay/x' });
    paystack.verifyTransaction.mockResolvedValue({ outcome: 'ok', status: 'abandoned' });

    await check.run(new Date());

    // They could still pay it; failing would strand the money.
    expect((await reload(p)).status).toBe('SUBMITTED');
  });
```

- [ ] **Step 5: Register, verify and commit**

```bash
git add -A src test
git commit -m "feat: chase unresolved payments from the database"
```

---

### Task 11: Remove the old columns and the Payout table

**Files:**
- Modify: `prisma/schema.prisma`, every reader of the removed columns, `src/rescue-request/dto/*`
- Create: `prisma/migrations/<timestamp>_drop_legacy_payment_state/migration.sql`

Only now, with `Payment` written by every flow and read by the checks, does the duplicate state come out.

- [ ] **Step 0: Clear staging's transactional data**

Dropping the columns without backfill leaves every existing staging request
reading as unpaid, because no `Payment` row exists for it. Backfilling is not
the answer — `providerFee`, `netAmount` and a real `providerRef` cannot be
reconstructed for old deposits, so the rows would be invented, and invented
rows in a money table get trusted later.

Clear the traffic, keep the accounts:

```sql
-- Keeps User, Operator, OperatorMember and PlatformConfig — the accounts and
-- config you test against. Drops only what a test run regenerates.
TRUNCATE TABLE
  "Rating", "Payout", "RequestMedia", "DispatchOffer",
  "RescueRequest", "WhatsAppSession"
RESTART IDENTITY CASCADE;
```

`WhatsAppSession` is included deliberately: sessions carry `rescueRequestId`,
so leaving them points live conversations at deleted requests — the stale-state
class the durable-scheduling work exists to remove.

Two practical notes. Run it when nobody is mid-test, or the tester loses an
in-flight job. And confirm the `PlatformConfig` row survives — dispatch reads
its fees and windows, and an empty table changes behaviour.

- [ ] **Step 1: Convert the readers**

`depositPaid` → `payments: { some: { type: 'DEPOSIT', status: 'SUCCEEDED' } }`, and the same for `balancePaid`. The admin list filter becomes a relation filter; the response DTOs keep the same field names, derived. `refundEligible` becomes *a succeeded `DEPOSIT` exists, the request is
`CANCELLED`, and no **active or successful** `REFUND` exists* — active being
`PENDING`, `SUBMITTED` or `BLOCKED`:

```ts
  payments: {
    some: { type: 'DEPOSIT', status: 'SUCCEEDED' },
    none: { type: 'REFUND', status: { in: ['PENDING', 'SUBMITTED', 'BLOCKED', 'SUCCEEDED'] } },
  },
```

**Not "no REFUND payment exists".** One row per attempt means a failed refund
row stays on the request forever by design, so that phrasing would make a
request permanently ineligible after a single failure — the admin would lose
the ability to retry precisely when they most need it. The failed row is
history, not a claim on the request.

- [ ] **Step 2: Drop the columns and the table by hand**

Prisma refuses destructive changes non-interactively, so write the migration directly:

```sql
ALTER TABLE "RescueRequest"
  DROP COLUMN "depositPaid",
  DROP COLUMN "balancePaid",
  DROP COLUMN "depositReference",
  DROP COLUMN "balanceReference",
  DROP COLUMN "depositRefundStatus",
  DROP COLUMN "depositRefundId";
DROP TABLE "Payout";
DROP TYPE "PayoutStatus";
DROP TYPE "PayoutBlockReason";
```

Then `npx prisma migrate deploy && npx prisma generate`.

- [ ] **Step 3: Prove the API did not change**

The DTO fields `depositPaid` and `balancePaid` must still be emitted, with the same values, from the derived source. A test asserting the response shape is unchanged is the point of this step.

- [ ] **Step 4: Final verification**

```bash
yarn tsc --noEmit && npx eslint "{src,apps,libs,test}/**/*.ts" --max-warnings <ratchet> && yarn jest && yarn test:integration
grep -rn "depositPaid\|balancePaid\|paystackTransferCode" src --include="*.ts" | grep -v spec
```

The grep must return only derived-field emissions in DTOs, never a column read.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: Payment becomes the only record of money movement"
```

---

### Task 12: One Paystack customer per user, for life

**Files:**
- Modify: `prisma/schema.prisma`, `src/rescue-request/whatsapp-customer-flow.service.ts`, `src/rescue-request/payment-events.service.ts`, `src/rescue-request/rescue-request-admin.service.ts`, `src/integrations/paystack/paystack.service.ts`
- Create: `test/integration/paystack-customer-identity.int-spec.ts`

Paystack treats the `email` on `/transaction/initialize` as the **customer
identity**, and saved cards attach to that customer. Today we send
`User.email ?? <digits>@lrr.ng`, and `createOrFetchCustomer` — which already
exists in `PaystackService` — is never called. A user who registers a real
email after their first payment silently becomes a second Paystack customer.

Harmless while every payment is one-off. Not harmless with memberships: a card
saved under the first customer cannot be charged under the second.

**The identity email cannot be corrected later.** Paystack's Update Customer
API takes `first_name`, `last_name`, `phone` and `metadata` — not `email`. And
`/transaction/initialize` requires an email; it will not accept a
`customer_code`. So the only way to keep one customer per person is to freeze
what we send and never change it, which means storing it.

- [ ] **Step 1: Store the code**

```prisma
model User {
  // ...existing fields unchanged...
  // Resolved once, on first payment, and never replaced. Paystack attaches
  // saved cards and authorizations to this customer, so a second code for
  // the same person splits their payment instruments.
  paystackCustomerCode  String? @unique
  // The email that customer was created under. NOT User.email: Paystack
  // cannot change a customer's email after creation, so this is frozen and
  // sent on every later transaction. User.email stays free to change — the
  // two are different things that happen to look alike.
  paystackCustomerEmail String?
}
```

- [ ] **Step 2: Resolve it once, before the first payment**

A small helper on `PaymentLedgerService` (or a `PaystackCustomerService` if
that reads better) that all four collection sites call in place of building an
email inline:

```ts
  /**
   * The Paystack customer for this user, created on first use.
   *
   * Serialised under a ROW LOCK, not a claim afterwards. Two concurrent
   * first payments would otherwise both reach createOrFetchCustomer — a GET
   * then a POST — before either wrote anything, and a conditional update
   * after the fact decides only which code WE keep. It says nothing about
   * how many customers Paystack created, and whether a concurrent
   * same-email POST dedupes provider-side is not known.
   *
   * This holds a row lock across an HTTP round trip, which is normally worth
   * avoiding. It is acceptable here because it happens once per user, on a
   * path already waiting on Paystack.
   */
  async customerFor(userId: string): Promise<{ code: string; email: string }> {
    return this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<
        { paystackCustomerCode: string | null; paystackCustomerEmail: string | null;
          email: string | null; phoneNumber: string | null }[]
      >`SELECT "paystackCustomerCode", "paystackCustomerEmail", "email", "phoneNumber"
          FROM "User" WHERE id = ${userId} FOR UPDATE`;

      if (locked.paystackCustomerCode && locked.paystackCustomerEmail) {
        return { code: locked.paystackCustomerCode, email: locked.paystackCustomerEmail };
      }

      // The identity email is chosen ONCE here and frozen. User.email may
      // change afterwards; Paystack never sees the change.
      const identityEmail =
        locked.email ?? `${locked.phoneNumber!.replace(/\D/g, '')}@lrr.ng`;
      const { customer_code } = await this.paystack.createOrFetchCustomer({
        email: identityEmail,
        phone: locked.phoneNumber ?? undefined,
      });

      await tx.user.update({
        where: { id: userId },
        data: { paystackCustomerCode: customer_code, paystackCustomerEmail: identityEmail },
      });
      return { code: customer_code, email: identityEmail };
    });
  }
```

Every collection site then sends `(await customerFor(userId)).email` — never
`User.email`.

- [ ] **Step 3: Change nothing when the user's email changes**

This is the step that does *not* exist, and it is worth stating so nobody
adds it later. Paystack cannot change a customer's email, so there is no
call to make. `User.email` changes freely and `paystackCustomerEmail` stays
put; the Paystack dashboard will show the original address for that customer,
which is the price of a stable identity.

If the dashboard address matters operationally, put the current email in the
customer's `metadata` — which *is* updatable — rather than trying to move the
identity.

- [ ] **Step 4: Test the property**

```ts
  it('keeps one identity when the user later sets a real email', async () => {
    const user = await createCustomer(prisma);            // phone only
    const first = await ledger.customerFor(user.id);

    await prisma.user.update({ where: { id: user.id }, data: { email: 'ada@example.com' } });
    const second = await ledger.customerFor(user.id);

    expect(second).toEqual(first);
    // The frozen identity email is sent, NOT the new real one.
    expect(second.email).not.toBe('ada@example.com');
    expect(paystack.createOrFetchCustomer).toHaveBeenCalledTimes(1);
  });

  it('calls Paystack once when two payments start at once', async () => {
    // The row lock is what makes this true. A claim after the call would
    // pass the first assertion and fail this one.
    const user = await createCustomer(prisma);
    const [a, b] = await Promise.all([
      ledger.customerFor(user.id),
      ledger.customerFor(user.id),
    ]);
    expect(a).toEqual(b);
    expect(paystack.createOrFetchCustomer).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 5: Verify and commit**

```bash
git add -A src test prisma
git commit -m "feat: one Paystack customer per user, resolved once and kept"
```

---

## Verification after the final task

- [ ] A payout that returns `otp` lands `BLOCKED`, not `PROCESSING`, and appears in a staff queue.
- [ ] Killing the service between the INSERT and the CAS leaves a row the reconciler initiates within a tick.
- [ ] `SELECT status, count(*) FROM "Payment" GROUP BY status` on staging shows nothing stuck in `SUBMITTED` beyond the backoff ceiling.
- [ ] Transfers OTP is disabled and transfer IP allowlisting is configured (spec §Actionable non-terminal states) — without this, payouts abandon regardless of code.
- [ ] Test plan §13 still passes on staging.
- [ ] A user who pays, then registers an email, then pays again has **one**
      Paystack customer — check the dashboard, not just the column.
