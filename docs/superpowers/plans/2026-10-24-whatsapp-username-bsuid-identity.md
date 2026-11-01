# WhatsApp Username / BSUID Identity Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop WhatsApp's username/BSUID masking from corrupting `User.phoneNumber`, correctly recognize already-registered operators whose messages arrive masked, and let BSUID-only customers complete an SOS with no added friction — resolving a real phone number only at the point LRR actually needs one.

**Architecture:** A new nullable, unique `User.whatsappExternalUserId` column holds the BSUID alongside the existing `phoneNumber` column. One pure utility parses `From`/`ExternalUserId` into a sender identity; a second resolves-or-creates the right `User` from it, passively linking BSUID↔phone whenever both are visible on the same message. The inbound router recognizes a BSUID-matched operator and lets everyone else — new or returning — reach the customer flow with no gate. A masked operator's job going stale is caught by a reconciler check (same pattern as the existing `DepositExpiryCheck`), not by blocking an ambiguous first message. Customers get a real phone number via Twilio's native `REQUEST_CONTACT_INFO` button, asked only at the deposit-payment checkpoint (or the 0%-deposit equivalent), never at SOS start.

**Tech Stack:** NestJS, Prisma/Postgres, Twilio WhatsApp (Content API, `twilio/call-to-action` templates), Jest (unit + integration).

**Spec:** `docs/superpowers/specs/2026-10-24-whatsapp-username-bsuid-identity-design.md`

**Revision note (2026-10-24):** This plan was multi-LLM reviewed (Codex, Gemini, a fresh Claude subagent) after its first draft. Nine findings were accepted and are folded in below — most significantly, Task 6 ("the router blocks every unmatched BSUID sender") was self-contradictory and would have blocked every new username-using customer's first SOS; it's replaced with the reconciler-based approach described above. One finding (0%-deposit ask timing, now Task 13) reverses an explicit spec decision and is flagged for the plan owner's call rather than silently resolved either way.

## Global Constraints

- Never write a BSUID into `User.phoneNumber`, for either role (spec Goals).
- `whatsappExternalUserId` is never used as `User.id` — it is its own nullable, unique column (spec Non-goals: BSUID-as-PK was considered and rejected).
- The `request_contact_info` response's exact webhook shape is **not documented by Twilio** — Task 11 must prove it with a real test against a real number before any code assumes field names.
- `normalizePhone` (`src/common/phone.util.ts`) is registration-only and is never called from the WhatsApp customer-flow path — confirmed by grep (`normalizePhone` has zero call sites under `src/rescue-request/` or `src/payment/`). Do not add a call to it anywhere in this plan; a BSUID must never reach it.
- `toWhatsAppAddress`/`TwilioService.sendWhatsAppMessage`/`sendWhatsAppTemplateMessage` perform no validation — they only prepend `whatsapp:`. They already work unchanged for a BSUID destination. The real risk this plan guards against is passing `null` (a customer or operator with no resolvable `phoneNumber` right now), not a BSUID being rejected. This applies on **both** the customer and operator sides — a masked operator's own reminder templates are addressed by the same risk (Task 6).
- `PaystackCustomerService.customerFor` (`src/payment/paystack-customer.service.ts:72`) does `locked.phoneNumber!.replace(...)` — a non-null assertion. It will throw for a BSUID-only customer. This is exactly why Task 11's gate must run **before** `customerFor` is ever called for a request whose customer has no `phoneNumber` yet — and specifically after the operator-assignment transaction already runs, not before it (see Task 11's placement note — a first draft of this plan got this backwards and would have skipped operator assignment entirely for a BSUID-only customer).
- `OperatorMember` (`prisma/schema.prisma`) has **no soft-delete/`removedAt` field** — removal is a hard `operatorMember.delete()` (confirmed against `OperatorService.removeMember`). "Membership removed" and "membership never existed" are indistinguishable in this schema; don't write a task or test that assumes otherwise.

## Review Focus

- A customer taps `REQUEST_CONTACT_INFO` with a number that collides with an existing `User` row — must attach the request to that account **and** transfer the BSUID link itself, not just the request, or the person keeps hitting the same wall on every later message (Task 11).
- A 0%-deposit request never reaches the deposit checkpoint at all — must still get asked for a phone number before the job is treated as genuinely confirmed (Task 13; timing itself flagged for the plan owner, see Task 13's note).
- A masked operator's job goes stale with no WhatsApp activity — must be caught and surfaced to staff with an actual job reference, not a bare unmatched-BSUID alert with nothing for staff to act on (Task 8).
- A `From`/`ExternalUserId` value that doesn't cleanly match either the E.164 or `CC.<alphanumeric>` shape (Meta changes the format) — must never be treated as a trustworthy phone number; treat as opaque/unresolvable rather than guessing (Task 2).
- The `REQUEST_CONTACT_INFO` response webhook arrives twice (Twilio redelivery) — backfilling `phoneNumber` twice must not double-attempt the account-collision logic or throw on a second identical write (Task 11).
- A `REQUEST_CONTACT_INFO` button is sent but never tapped — the request must not sit at checkout indefinitely with no signal to anyone (Task 12).

---

### Task 1: Schema — `User.whatsappExternalUserId`

**Files:**
- Modify: `prisma/schema.prisma` (`model User`, after the existing `phoneNumber String? @unique` line)
- Create: a new migration under `prisma/migrations/`

**Interfaces:**
- Produces: `User.whatsappExternalUserId: string | null`, unique-indexed, consumed by every later task.

- [ ] **Step 1: Add the field**

```prisma
model User {
  id                      String   @id @default(cuid())
  email                   String?  @unique
  phoneNumber             String?  @unique
  whatsappExternalUserId  String?  @unique
  ...
}
```

- [ ] **Step 2: Generate and apply the migration**

Run: `npx prisma migrate dev --name add_whatsapp_external_user_id`
Expected: a new `prisma/migrations/<timestamp>_add_whatsapp_external_user_id/migration.sql` adding the column and a unique index, applied cleanly to the local dev database.

- [ ] **Step 3: Regenerate the Prisma client**

Run: `npx prisma generate`
Expected: no errors; `User.whatsappExternalUserId` is now a typed field.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "Add User.whatsappExternalUserId for WhatsApp BSUID identity"
```

---

### Task 2: `parseWhatsAppSender` utility

**Files:**
- Create: `src/common/whatsapp-sender-identity.util.ts`
- Test: `src/common/whatsapp-sender-identity.util.spec.ts`

**Interfaces:**
- Produces:
  ```typescript
  export interface ParsedWhatsAppSender {
    phoneNumber: string | null;
    externalUserId: string | null;
  }
  export function parseWhatsAppSender(
    from: string,
    externalUserId?: string,
  ): ParsedWhatsAppSender
  ```
  Consumed by Task 4 (`findOrCreateBySender`) and Task 7 (inbound router).

Twilio always prefixes both `From` and `ExternalUserId` with `whatsapp:`. After stripping that prefix: a real phone number starts with `+`; a BSUID matches `CC.<alphanumeric>` (two letters, a literal dot, then the id — e.g. `CA.1234567890123456`, confirmed in the spec's live test). `ExternalUserId` is present on every webhook per Twilio's own documentation, phone-masked or not.

- [ ] **Step 1: Write the failing tests**

```typescript
describe('parseWhatsAppSender', () => {
  it('returns the real phone number and the BSUID when both are present', () => {
    const result = parseWhatsAppSender(
      'whatsapp:+2348012345678',
      'whatsapp:CA.1234567890123456',
    );
    expect(result).toEqual({
      phoneNumber: '+2348012345678',
      externalUserId: 'CA.1234567890123456',
    });
  });

  it('returns only the BSUID when the sender has no visible phone number', () => {
    const result = parseWhatsAppSender('whatsapp:CA.1234567890123456');
    expect(result).toEqual({
      phoneNumber: null,
      externalUserId: 'CA.1234567890123456',
    });
  });

  it('returns only the phone number when no ExternalUserId is given', () => {
    const result = parseWhatsAppSender('whatsapp:+15550100003');
    expect(result).toEqual({
      phoneNumber: '+15550100003',
      externalUserId: null,
    });
  });

  it('treats a value matching neither shape as unresolvable, never as a phone number', () => {
    const result = parseWhatsAppSender('whatsapp:not-a-real-value');
    expect(result.phoneNumber).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test whatsapp-sender-identity.util -- --no-coverage`
Expected: FAIL — `parseWhatsAppSender is not a function`.

- [ ] **Step 3: Implement `parseWhatsAppSender` in `src/common/whatsapp-sender-identity.util.ts`**

Strip the `whatsapp:` prefix (case-insensitive) from both arguments. If the stripped `from` starts with `+`, it is the `phoneNumber`; the stripped `externalUserId` (if given) is the `externalUserId`. Otherwise `phoneNumber` is `null`; the `externalUserId` is the stripped `externalUserId` if it matches `/^[A-Za-z]{2}\.[A-Za-z0-9]+$/`, else fall back to the stripped `from` itself if *it* matches that shape, else `null` (the "matches neither shape" case from the last test — never promote an unrecognized value to `phoneNumber`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test whatsapp-sender-identity.util -- --no-coverage`
Expected: PASS, 4/4.

- [ ] **Step 5: Commit**

```bash
git add src/common/whatsapp-sender-identity.util.ts src/common/whatsapp-sender-identity.util.spec.ts
git commit -m "Add parseWhatsAppSender to distinguish a real number from a BSUID"
```

---

### Task 3: `toWhatsAppDestination` helper

**Files:**
- Modify: `src/common/phone.util.ts` (add alongside the existing `toWhatsAppAddress`)
- Test: create `src/common/phone.util.spec.ts` if it doesn't already exist, else extend it

**Interfaces:**
- Consumes: nothing new.
- Produces:
  ```typescript
  export function toWhatsAppDestination(target: {
    phoneNumber: string | null;
    whatsappExternalUserId: string | null;
  }): string
  ```
  Consumed by Task 6 (operator-side sends), Task 11, and Task 14 for every send where the destination is read from the database rather than from the live inbound message's own sender value — both customer and operator destinations use this same helper.

- [ ] **Step 1: Write the failing tests**

```typescript
describe('toWhatsAppDestination', () => {
  it('prefers the phone number when present', () => {
    expect(
      toWhatsAppDestination({
        phoneNumber: '+2348012345678',
        whatsappExternalUserId: 'CA.123',
      }),
    ).toBe('whatsapp:+2348012345678');
  });

  it('falls back to the BSUID when there is no phone number', () => {
    expect(
      toWhatsAppDestination({ phoneNumber: null, whatsappExternalUserId: 'CA.123' }),
    ).toBe('whatsapp:CA.123');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test phone.util -- --no-coverage`
Expected: FAIL — `toWhatsAppDestination is not a function`.

- [ ] **Step 3: Implement `toWhatsAppDestination` in `src/common/phone.util.ts`**

`return toWhatsAppAddress(target.phoneNumber ?? target.whatsappExternalUserId!)` — if both are null, let it throw naturally (a destination with neither value is a data-integrity bug, not something to paper over).

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test phone.util -- --no-coverage`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/common/phone.util.ts src/common/phone.util.spec.ts
git commit -m "Add toWhatsAppDestination for phone-or-BSUID sends"
```

---

### Task 4: `findOrCreateBySender` with passive BSUID capture

**Files:**
- Modify: `src/rescue-request/rescue-request-shared.service.ts` (alongside the existing `findOrCreateCustomer`, line 28)
- Test: `src/rescue-request/rescue-request-shared.service.spec.ts`

**Interfaces:**
- Consumes: `ParsedWhatsAppSender` (Task 2).
- Produces:
  ```typescript
  async findOrCreateBySender(parsed: ParsedWhatsAppSender): Promise<User>
  ```
  Consumed by Task 7 (inbound router), replacing its direct `findOrCreateCustomer(phoneNumber)` call for the sender-resolution step.

Behavior (per spec "Passive BSUID capture applies to both roles" and "if a BSUID-identified customer's `From` ever does later carry a real phone number again... prefer and store it"):
- `parsed.phoneNumber` present:
  1. Find by `phoneNumber`. If found: this is the unchanged, today's-behavior path. If `parsed.externalUserId` is also present and doesn't already match that row's `whatsappExternalUserId`, update it to match (passive capture, runs on *every* unmasked message, operator or customer).
  2. Not found by `phoneNumber`, but `parsed.externalUserId` is present and matches an *existing* row's `whatsappExternalUserId`: this is the "a previously BSUID-only person's real number just became visible again" case (Contact Book, or NG rollout never affecting them). Backfill `phoneNumber` onto that existing row and return it — do **not** create a second, duplicate row.
  3. Neither found: create a new `User` with both `phoneNumber` and `whatsappExternalUserId` (if given) set, same `role`-defaulting the existing `findOrCreateCustomer` uses for a fresh row.
- `parsed.phoneNumber` null: find by `whatsappExternalUserId` (`parsed.externalUserId`). If found, return it. If not found, create a new `User` with `phoneNumber: null`, `whatsappExternalUserId: parsed.externalUserId`, same role-defaulting as above.

- [ ] **Step 1: Write the failing tests**

```typescript
describe('findOrCreateBySender', () => {
  it('passively captures the BSUID onto an existing phone-matched user', async () => {
    const existing = await createTestUser({ phoneNumber: '+2348012345678' });
    const result = await service.findOrCreateBySender({
      phoneNumber: '+2348012345678',
      externalUserId: 'CA.999',
    });
    expect(result.id).toBe(existing.id);
    expect(result.whatsappExternalUserId).toBe('CA.999');
  });

  it('creates a phoneNumber: null user keyed on externalUserId when no phone is given', async () => {
    const result = await service.findOrCreateBySender({
      phoneNumber: null,
      externalUserId: 'CA.1234567890123456',
    });
    expect(result.phoneNumber).toBeNull();
    expect(result.whatsappExternalUserId).toBe('CA.1234567890123456');
  });

  it('backfills phoneNumber onto an existing BSUID-linked user instead of duplicating, when the real number reappears', async () => {
    const bsuidOnly = await service.findOrCreateBySender({
      phoneNumber: null,
      externalUserId: 'CA.recovered',
    });
    const result = await service.findOrCreateBySender({
      phoneNumber: '+2348099999999',
      externalUserId: 'CA.recovered',
    });
    expect(result.id).toBe(bsuidOnly.id);
    expect(result.phoneNumber).toBe('+2348099999999');
  });

  it('finds the same user by externalUserId on a returning BSUID-only visit', async () => {
    const first = await service.findOrCreateBySender({
      phoneNumber: null,
      externalUserId: 'CA.1234567890123456',
    });
    const second = await service.findOrCreateBySender({
      phoneNumber: null,
      externalUserId: 'CA.1234567890123456',
    });
    expect(second.id).toBe(first.id);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test rescue-request-shared.service -- --no-coverage`
Expected: FAIL — `findOrCreateBySender is not a function`.

- [ ] **Step 3: Implement `findOrCreateBySender` in `rescue-request-shared.service.ts`**

Follow the branching above. Reuse whatever role-defaulting logic `findOrCreateCustomer` (same file, line 28) already applies for a brand-new row — read that method first so the new row shape matches exactly, don't invent a different default.

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test rescue-request-shared.service -- --no-coverage`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/rescue-request/rescue-request-shared.service.ts src/rescue-request/rescue-request-shared.service.spec.ts
git commit -m "Add findOrCreateBySender with passive BSUID capture"
```

---

### Task 5: Operator lookup by BSUID

**Files:**
- Modify: `src/operator/operator-membership.service.ts`
- Test: `src/operator/operator-membership.service.spec.ts`

**Interfaces:**
- Consumes: a `userId` (from Task 4's resolved `User`).
- Produces:
  ```typescript
  async findActiveOperatorForUser(userId: string): Promise<{ id: string; whatsappEnabled: boolean; phoneNumber: string | null } | null>
  ```
  Consumed by Task 7.

Reuses the same active-membership definition `findActiveOperatorIdsForUser` (same file, line 16) already uses — read it first; this method is that one's single-operator, full-record variant, not a parallel reimplementation of "active." Per Global Constraints: `OperatorMember` has no soft-delete field, so "membership removed" and "no membership" are the same case in this schema — there is only one negative case to test, not two.

- [ ] **Step 1: Write the failing tests**

```typescript
describe('findActiveOperatorForUser', () => {
  it('returns the operator for a user with an active membership', async () => {
    const { user, operator } = await createTestOperatorMembership();
    const result = await service.findActiveOperatorForUser(user.id);
    expect(result?.id).toBe(operator.id);
  });

  it('returns null for a user with no membership — including one that was removed, since removal is a hard delete in this schema', async () => {
    const user = await createTestUser();
    expect(await service.findActiveOperatorForUser(user.id)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test operator-membership.service -- --no-coverage`
Expected: FAIL — `findActiveOperatorForUser is not a function`.

- [ ] **Step 3: Implement `findActiveOperatorForUser`**

Same active-membership filter as `findActiveOperatorIdsForUser`, but select and return the full `Operator` record's `id`, `whatsappEnabled`, `phoneNumber` instead of just the id array.

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test operator-membership.service -- --no-coverage`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/operator/operator-membership.service.ts src/operator/operator-membership.service.spec.ts
git commit -m "Add findActiveOperatorForUser for BSUID-matched operator lookup"
```

---

### Task 6: Operator-side BSUID-aware destination

**Files:**
- Modify: `src/rescue-request/whatsapp-operator-flow.service.ts` (the `replyWithTemplateOrText` call sites at the arrived/done reminder sends, ~lines 404 and 419 — confirm exact lines by reading the file, since line numbers shift as earlier tasks land)
- Test: `src/rescue-request/whatsapp-operator-flow.service.spec.ts`

**Interfaces:**
- Consumes: `toWhatsAppDestination` (Task 3).

Multi-LLM review finding: these reminder sends currently address by `operator.phoneNumber` directly, even though Task 7's router will reach this exact code path *because* an operator was recognized via a masked BSUID — meaning the operator currently has no visible phone number to send to. Sending to `operator.phoneNumber` for a masked operator either fails or silently goes nowhere, defeating the point of recognizing them at all. These two reminder sends need to resolve the operator's **linked `User`'s** `whatsappExternalUserId` (via `OperatorMembershipService`, not the `Operator` record itself — the column lives on `User`) and use `toWhatsAppDestination` instead of assuming a phone number is always reachable.

- [ ] **Step 1: Write the failing tests**

```typescript
describe('arrived/done reminder sends — masked operator', () => {
  it('addresses the reminder to the BSUID when the operator currently has no visible phone number', async () => {
    const { user, operator } = await createTestOperatorMembership({ phoneNumber: '+2348012345678' });
    await prisma.user.update({ where: { id: user.id }, data: { whatsappExternalUserId: 'CA.masked' } });
    await service.sendArrivedReminder(operator.id); // or whatever the real call site's own entry point is named — read the file first
    expect(twilioService.sendWhatsAppTemplateMessage).toHaveBeenCalledWith(
      expect.stringContaining('CA.masked'),
      expect.any(String),
      expect.any(Object),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test whatsapp-operator-flow.service -- --no-coverage`
Expected: FAIL — the reminder still addresses `operator.phoneNumber` directly.

- [ ] **Step 3: Resolve the destination via the linked `User` before sending**

At each of the two reminder call sites, look up the operator's linked `User` (via the existing `OperatorMember` relation — a direct Prisma query or a small addition to `OperatorMembershipService` if a clean one doesn't already exist) to get `whatsappExternalUserId`, then call `toWhatsAppDestination({ phoneNumber: operator.phoneNumber, whatsappExternalUserId })` instead of formatting `operator.phoneNumber` directly.

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test whatsapp-operator-flow.service -- --no-coverage`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/rescue-request/whatsapp-operator-flow.service.ts src/rescue-request/whatsapp-operator-flow.service.spec.ts
git commit -m "Address operator reminder sends by BSUID when their phone is currently masked"
```

---

### Task 7: Rewrite the inbound router

**Files:**
- Modify: `src/rescue-request/whatsapp-inbound.service.ts:25-100` (`handleIncomingWhatsAppMessage`)
- Test: `src/rescue-request/whatsapp-inbound.service.spec.ts`

**Interfaces:**
- Consumes: `parseWhatsAppSender` (Task 2), `findOrCreateBySender` (Task 4), `findActiveOperatorForUser` (Task 5).
- Produces: the rewritten routing behavior other tasks' integration tests (Task 15, 16) exercise end to end.

**Multi-LLM review correction**: the first draft of this task had an unmatched-BSUID sender both blocked *and* falling through to the customer flow — logically incompatible, and would have blocked every new username-using customer's first SOS (there is no way for the router to distinguish "a masked operator" from "a brand-new customer" from an operator-lookup miss alone). Fixed below: an unmatched BSUID always proceeds to the customer flow, exactly like a phone-matched non-operator does today. The "operator job gone silently stuck" problem this was trying to solve is instead caught by Task 8's reconciler check, which has something concrete to alert on (an actual stale job) rather than a bare, ambiguous inbound message.

- [ ] **Step 1: Write the failing tests**

```typescript
describe('handleIncomingWhatsAppMessage — BSUID routing', () => {
  it('routes a BSUID-matched operator to the operator flow using their real record', async () => {
    const { user, operator } = await createTestOperatorMembership({ phoneNumber: '+2348012345678' });
    await prisma.user.update({ where: { id: user.id }, data: { whatsappExternalUserId: 'CA.op1' } });
    await service.handleIncomingWhatsAppMessage({
      From: 'whatsapp:CA.op1',
      Body: 'ARRIVED',
    });
    expect(operatorFlow.handleOperatorMessage).toHaveBeenCalled();
  });

  it('routes an unmatched BSUID sender to the customer flow, not a blocking reply', async () => {
    await service.handleIncomingWhatsAppMessage({
      From: 'whatsapp:CA.brand-new-customer',
      Body: 'SOS',
    });
    expect(customerFlow.handleCustomerMessage).toHaveBeenCalled();
  });

  it('creates a phoneNumber: null customer for a fresh BSUID-only SOS sender', async () => {
    await service.handleIncomingWhatsAppMessage({
      From: 'whatsapp:CA.newcustomer',
      Body: 'SOS',
    });
    const created = await prisma.user.findUnique({ where: { whatsappExternalUserId: 'CA.newcustomer' } });
    expect(created?.phoneNumber).toBeNull();
  });
});
```

(Exact mock shape for `operatorFlow`/`customerFlow` should mirror whatever this spec file already uses for its existing passing tests — read the file first.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test whatsapp-inbound.service -- --no-coverage`
Expected: FAIL (current code has no BSUID branch at all).

- [ ] **Step 3: Implement the rewrite in `handleIncomingWhatsAppMessage`**

Replace the current `body.From.replace(/^whatsapp:/i, '')` + `findOrCreateCustomer` + `prisma.operator.findUnique({ where: { phoneNumber } })` sequence with:
1. `const parsed = parseWhatsAppSender(body.From, body.ExternalUserId);`
2. `const user = await this.sharedService.findOrCreateBySender(parsed);`
3. If `parsed.phoneNumber`: operator lookup exactly as today (`prisma.operator.findUnique({ where: { phoneNumber: parsed.phoneNumber } })`), unchanged downstream behavior.
4. Else (`parsed.phoneNumber` is null — a BSUID-only sender): `const operator = await this.operatorMembershipService.findActiveOperatorForUser(user.id);`
   - If found: route to `operatorFlow.handleOperatorMessage` exactly as the phone-matched path does, passing `operator.phoneNumber` (the operator's real, on-file number) wherever the existing signature expects a phone number — downstream sends that need to reach this operator specifically go through Task 6's fix, not this router.
   - If not found: fall through to step 5 below. No alert, no blocking reply — this is indistinguishable from a new customer at this point.
5. Route to `customerFlow.handleCustomerMessage` as today, passing `user.id` as `userId`, for every case not already routed to the operator flow in step 3/4.

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test whatsapp-inbound.service -- --no-coverage`
Expected: PASS.

- [ ] **Step 5: Run the full unit suite**

Run: `yarn test --ci`
Expected: all suites pass — this rewrite touches the router every WhatsApp message goes through, so a regression here would show up broadly.

- [ ] **Step 6: Commit**

```bash
git add src/rescue-request/whatsapp-inbound.service.ts src/rescue-request/whatsapp-inbound.service.spec.ts
git commit -m "Route BSUID senders through phone-or-BSUID operator/customer resolution"
```

---

### Task 8: Stuck-operator-job reconciler check

**Files:**
- Create: `src/rescue-request/reconciler/checks/stuck-operator-job.check.ts` (follow `src/rescue-request/reconciler/checks/deposit-expiry.check.ts`'s exact shape — same `ReconcilerCheck` interface, same `name`/`run(now: Date): Promise<number>` contract)
- Modify: wherever `DepositExpiryCheck` is registered into the reconciler's check list (find this by reading what imports/instantiates `DepositExpiryCheck` — likely a reconciler module or service)
- Test: `test/integration/reconciler-stuck-operator-job.int-spec.ts` (follow `test/integration/reconciler-deposit-expiry.int-spec.ts`'s pattern — real database, real reconciler run)

**Interfaces:**
- Consumes: the same `alertStaffManualFallback`-style fan-out pattern (`dispatch.service.ts:828`) for the actual staff notification — read it first, mirror its per-number try/catch + `Sentry.captureException` shape, don't reinvent it.

Replaces the first draft's router-level "unmatched BSUID → alert + block" approach (removed in Task 7 per the multi-LLM review finding). This check instead finds requests whose *job* is actually stale — a concrete thing staff can act on, which a bare "saw an unrecognized BSUID" alert never gave them.

- [ ] **Step 1: Write the failing test**

```typescript
it('alerts staff for an OPERATOR_ASSIGNED or ARRIVED request with a WhatsApp-enabled operator and no recent activity', async () => {
  const request = await createStaleAssignedRequest({
    status: 'OPERATOR_ASSIGNED',
    operatorWhatsappEnabled: true,
    updatedAt: thirtyFiveMinutesAgo,
  });
  const acted = await check.run(new Date());
  expect(acted).toBe(1);
  expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
    expect.any(String),
    expect.stringContaining(request.id.slice(0, 6).toUpperCase()), // the job ref, via formatJobRef — match whatever format alertStaffManualFallback's own jobRef uses
  );
});

it('does not alert for a request updated recently', async () => {
  const request = await createStaleAssignedRequest({
    status: 'OPERATOR_ASSIGNED',
    operatorWhatsappEnabled: true,
    updatedAt: new Date(),
  });
  expect(await check.run(new Date())).toBe(0);
});
```

(The exact staleness threshold and which timestamp/field signals "no recent activity" is left to the implementer — mirror whatever signal `DepositExpiryCheck` or a similar existing check already uses for "how long has this sat here," don't invent a new one without checking first.)

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:integration -- stuck-operator-job`
Expected: FAIL — the check doesn't exist yet.

- [ ] **Step 3: Implement `StuckOperatorJobCheck`**

Follow `DepositExpiryCheck`'s structure: `run(now)` finds candidate requests (`OPERATOR_ASSIGNED` or `ARRIVED` status, `assignedOperator.whatsappEnabled: true`, stale beyond the threshold), and for each, sends a staff alert carrying the job reference (`formatJobRef`) and a pointer to use the Task 9 manual-override action, following the existing fan-out pattern. Register it alongside `DepositExpiryCheck` in whatever wires that check into the reconciler's run list.

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test:integration -- stuck-operator-job`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/rescue-request/reconciler/checks/stuck-operator-job.check.ts test/integration/reconciler-stuck-operator-job.int-spec.ts
git commit -m "Add a reconciler check for stale operator-assigned jobs instead of a router-level block"
```

---

### Task 9: Widen manual-override guards for a WhatsApp-enabled operator, with an explicit reason and session reset

**Files:**
- Modify: `src/rescue-request/rescue-request-admin.service.ts:994` (`claimManualArrived`)
- Modify: `src/rescue-request/whatsapp-operator-flow.service.ts:622` (`startManualCompletionConfirmation`)
- Modify: `src/rescue-request/rescue-request.controller.ts:210` (`manualArrived`) and `:266` (`manualDone`)
- Test: `src/rescue-request/rescue-request-admin.service.spec.ts`, `src/rescue-request/whatsapp-operator-flow.service.spec.ts`, `src/rescue-request/rescue-request.controller.spec.ts`

**Multi-LLM review correction**: the first draft dropped the `whatsappEnabled: false` guard entirely, which is wider than the actual problem — it would permit staff to override *every* WhatsApp-enabled operator's job forever, not just the narrow transient masked case, and did nothing about the operator's own `WhatsAppSessionStore` state going stale after a staff-forced status change (if their WhatsApp reconnects normally afterward, their session still reflects the pre-override state). Fixed below: the override for a WhatsApp-enabled operator requires an explicit reason, is its own distinctly-audited action, and resets the operator's session to match.

**Interfaces:**
- `claimManualArrived`/`startManualCompletionConfirmation` gain an optional `reason?: string` parameter, required (enforced at the controller) only when the target operator's `whatsappEnabled` is `true`.

- [ ] **Step 1: Write the failing tests**

```typescript
// rescue-request-admin.service.spec.ts
it('claims a manual arrived transition for a WhatsApp-enabled operator when a reason is given', async () => {
  const request = await createTestRequest({ status: 'OPERATOR_ASSIGNED', operatorWhatsappEnabled: true });
  const { claimed } = await service.claimManualArrived(request.id, { reason: 'WhatsApp unreachable, operator called support' });
  expect(claimed).toBe(true);
});
```

```typescript
// rescue-request.controller.spec.ts
it('manualArrived rejects a WhatsApp-enabled operator override with no reason given', async () => {
  // request with assignedOperator.whatsappEnabled: true, no reason in the request body — must still throw BadRequestException.
});

it('manualArrived accepts a WhatsApp-enabled operator override when a reason is given, and resets their WhatsApp session', async () => {
  // asserts sessionStore.update (or equivalent) was called to reset state for the operator's userId after a successful claim.
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test rescue-request-admin.service whatsapp-operator-flow.service rescue-request.controller -- --no-coverage`
Expected: FAIL — current guards reject a `whatsappEnabled: true` operator outright, with no reason path at all.

- [ ] **Step 3: Narrow the guard to "allowed with a reason," not "always allowed"**

- `claimManualArrived`'s `WHERE` clause: drop `assignedOperator: { whatsappEnabled: false }`, keep `status: OPERATOR_ASSIGNED`. Accept the new `reason` parameter; write it into the existing audit-log call already made by the controller (don't add a second audit mechanism).
- `startManualCompletionConfirmation`'s `WHERE` clause: same change, keep `status: ARRIVED` and `confirmationDueAt: null`.
- `manualArrived`/`manualDone` controller methods: replace the unconditional `whatsappEnabled !== false` rejection with: if `whatsappEnabled` is `true`, require a non-empty `reason` in the request body (400 if missing); if `false`, behave exactly as today (no reason required — this is the original, already-legitimate non-WhatsApp-operator path, untouched).
- After a successful claim for a `whatsappEnabled: true` operator specifically, reset that operator's `WhatsAppSessionStore` entry (the same session the router/operator flow would otherwise read) to a neutral state consistent with the new status, so a later reconnect doesn't act on stale pre-override session state.

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test rescue-request-admin.service whatsapp-operator-flow.service rescue-request.controller -- --no-coverage`
Expected: PASS. Also re-run the existing non-WhatsApp-operator tests in all three files to confirm they still pass unchanged (no `reason` required on that path).

- [ ] **Step 5: Run the full unit suite**

Run: `yarn test --ci`
Expected: all suites pass.

- [ ] **Step 6: Commit**

```bash
git add src/rescue-request/rescue-request-admin.service.ts src/rescue-request/whatsapp-operator-flow.service.ts src/rescue-request/rescue-request.controller.ts src/rescue-request/rescue-request-admin.service.spec.ts src/rescue-request/whatsapp-operator-flow.service.spec.ts src/rescue-request/rescue-request.controller.spec.ts
git commit -m "Allow a reasoned staff override for a WhatsApp-enabled operator, resetting their session"
```

---

### Task 10: `REQUEST_CONTACT_INFO` template registration

**Files:**
- Modify: `src/integrations/twilio/twilio-content-templates.ts`

**Interfaces:**
- Produces: a `TWILIO_CONTACT_INFO_REQUEST_TEMPLATE_SID` env var reference, consumed by Task 11.

**Multi-LLM review correction**: the first draft asked for a `contentType: 'twilio/call-to-action'` entry with a titleless `REQUEST_CONTACT_INFO` button — verified against the real type, `TwilioContentTemplateDefinition.contentType` is `'text' | 'quick-reply'` only, and `buttons?: { title: string }[]` requires a title on every entry. That shape does not compile. Fixed below: widen the type first, with its own typecheck step, before adding the entry.

- [ ] **Step 1: Widen `TwilioContentTemplateDefinition`**

Add `'twilio/call-to-action'` to the `contentType` union, and add a new, separate optional field for this specific action shape — don't force it into `buttons`, since `REQUEST_CONTACT_INFO` has no title and isn't really a labeled button in the same sense `URL`/`COPY_CODE` are:

```typescript
export type TwilioContentTemplateDefinition = {
  envVar: string;
  category: 'UTILITY';
  contentType: 'text' | 'quick-reply' | 'twilio/call-to-action';
  variables: string[];
  body: string;
  buttons?: { title: string }[];
  action?: 'REQUEST_CONTACT_INFO';
  source: 'confirmed' | 'reconstructed' | 'designed';
};
```

- [ ] **Step 2: Run the typecheck**

Run: `npx tsc --noEmit`
Expected: clean (confirms the widened type compiles against every existing entry unchanged).

- [ ] **Step 3: Add the template entry**

Follow the file's own established entry shape (see `manual_fallback_alert`, line ~112): `envVar: 'TWILIO_CONTACT_INFO_REQUEST_TEMPLATE_SID'`, `category: 'UTILITY'`, `contentType: 'twilio/call-to-action'`, `action: 'REQUEST_CONTACT_INFO'`, `source: 'designed'` (this is new copy being handed off to create in the Twilio console, not a read of something already live). Body text, from the spec's drafted copy:

```
We're on WhatsApp with you, but your account has a username set, so WhatsApp isn't sharing your phone number with us automatically — that's a WhatsApp privacy setting, not something we're choosing. Tap below to share it, so you can find this request if you sign up on the LRR portal later.
```

- [ ] **Step 4: Run the typecheck again**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/integrations/twilio/twilio-content-templates.ts
git commit -m "Register the REQUEST_CONTACT_INFO template reference entry"
```

---

### Task 11: Gate checkout on a real phone number, via `REQUEST_CONTACT_INFO`

**Files:**
- Modify: `src/rescue-request/whatsapp-customer-flow.service.ts:1036` (`handleQuoteSelected`)
- Create: `test/integration/request-contact-info-response.int-spec.ts` (the Step 1 real-webhook-shape spike — this is a genuine test against Twilio, not a unit test with a guessed payload)
- Test: `src/rescue-request/whatsapp-customer-flow.service.spec.ts`

**Interfaces:**
- Consumes: `toWhatsAppDestination` (Task 3).
- Produces: `completeDepositForRequest(rescueRequestId: string): Promise<void>` — the extracted deposit-finalization tail, consumed by both the normal (phone-already-known) path and the resumed-after-contact-info path.

**Step 1 is a real-system verification spike, not a unit test — do this first, before writing any code that assumes a response shape.**

- [ ] **Step 1: Prove the `REQUEST_CONTACT_INFO` response shape against a real number**

Send a `REQUEST_CONTACT_INFO` template to a real test WhatsApp number (not NG — needs a username-enabled account, per the spec's own test setup), tap it, and capture the raw inbound webhook from Twilio Console (Monitor → Logs → Messaging), same method the spec's own BSUID finding used. Write down the exact field(s) carrying the shared phone number. If this cannot be completed (no test account with a username available), escalate to the plan owner before proceeding — do not guess a payload shape and build on the guess.

Expected: a documented, real example payload, added as a comment above Step 5's implementation.

- [ ] **Step 2: Read `handleQuoteSelected` end to end before changing it**

Run: open `src/rescue-request/whatsapp-customer-flow.service.ts:1036` and read through to its end. Confirm precisely: (a) where the operator-assignment transaction (sets `OPERATOR_ASSIGNED`/`WAITING_FOR_DEPOSIT`, flips the `DispatchOffer`, notifies other operators) actually ends, and (b) where the nonzero-deposit payment tail (claim → `customerFor` → `initializePayment` → checkout link) actually begins — **multi-LLM review correction: the first draft of this task cited "lines ~1247-1332" for the payment tail, which is wrong; the real nonzero-deposit tail starts at the `if (!payment)` check, and lines before that in that neighborhood belong to the sibling `depositAmount === 0` branch.** Don't extract or gate based on an assumed line range — confirm it by reading.

- [ ] **Step 3: Write the failing tests**

```typescript
describe('handleQuoteSelected — BSUID-only customer', () => {
  it('still assigns the operator and flips the DispatchOffer even when the customer has no phoneNumber yet', async () => {
    const request = await createTestRequestWithBsuidCustomer();
    await service.handleQuoteSelected(request.id, selectedQuote);
    const reloaded = await prisma.rescueRequest.findUnique({ where: { id: request.id } });
    expect(reloaded?.status).toBe('WAITING_FOR_DEPOSIT');
    expect(reloaded?.assignedOperatorId).not.toBeNull();
  });

  it('sends REQUEST_CONTACT_INFO instead of a checkout link when phoneNumber is null, after assignment', async () => {
    const request = await createTestRequestWithBsuidCustomer();
    await service.handleQuoteSelected(request.id, selectedQuote);
    expect(twilioService.sendWhatsAppTemplateMessage).toHaveBeenCalledWith(
      expect.stringContaining('CA.'),
      expect.any(String), // TWILIO_CONTACT_INFO_REQUEST_TEMPLATE_SID
      expect.any(Object),
    );
    expect(paystackService.initializePayment).not.toHaveBeenCalled();
  });
});

describe('completeDepositForRequest', () => {
  it('backfills phoneNumber from the contact-info response and completes checkout', async () => {
    const request = await createTestRequestWithBsuidCustomer();
    await handleContactInfoResponse(request.customerId, '+2348012345678' /* exact shape from Step 1 */);
    const customer = await prisma.user.findUnique({ where: { id: request.customerId } });
    expect(customer?.phoneNumber).toBe('+2348012345678');
    expect(paystackService.initializePayment).toHaveBeenCalled();
  });

  it('on a phone-number collision, attaches the request AND transfers the BSUID link to the existing account', async () => {
    const existing = await createTestUser({ phoneNumber: '+2348012345678' });
    const request = await createTestRequestWithBsuidCustomer({ externalUserId: 'CA.collider' });
    await handleContactInfoResponse(request.customerId, '+2348012345678');

    const reloadedRequest = await prisma.rescueRequest.findUnique({ where: { id: request.id } });
    expect(reloadedRequest?.customerId).toBe(existing.id);

    // The BSUID must now resolve to the WINNING account, not stay orphaned on the old row —
    // this is what makes the person stop hitting the "share your contact" wall on every later message.
    const winningAccount = await prisma.user.findUnique({ where: { id: existing.id } });
    expect(winningAccount?.whatsappExternalUserId).toBe('CA.collider');

    const orphanedRow = await prisma.user.findUnique({ where: { id: request.customerId } });
    expect(orphanedRow?.whatsappExternalUserId).toBeNull();
  });

  it('is idempotent against a redelivered contact-info webhook — does not double-send or throw', async () => {
    const request = await createTestRequestWithBsuidCustomer();
    await handleContactInfoResponse(request.customerId, '+2348012345678');
    twilioService.sendWhatsAppMessage.mockClear();
    paystackService.initializePayment.mockClear();
    // Same event, delivered a second time by Twilio.
    await expect(
      handleContactInfoResponse(request.customerId, '+2348012345678'),
    ).resolves.not.toThrow();
    expect(paystackService.initializePayment).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `yarn test whatsapp-customer-flow.service -- --no-coverage`
Expected: FAIL — `completeDepositForRequest` and the contact-info gate don't exist yet.

- [ ] **Step 5: Extract `completeDepositForRequest` and place the gate correctly**

Extract the payment tail confirmed in Step 2 (claim payment → `paystackCustomerService.customerFor` → `initializePayment` → send checkout link) into its own `private async completeDepositForRequest(rescueRequestId: string): Promise<void>` method, unchanged in behavior. **The phone-null gate goes immediately before the call to `completeDepositForRequest`, after the operator-assignment transaction and operator-notification code already runs** — not at the top of `handleQuoteSelected`. If `rescueRequest.customer.phoneNumber` is null at that point: send the `REQUEST_CONTACT_INFO` template (Task 10) to `toWhatsAppDestination(rescueRequest.customer)` instead of calling `completeDepositForRequest`, and return.

- [ ] **Step 6: Implement the contact-info response handler**

Using the exact field(s) found in Step 1, add handling (in the inbound router or wherever the response webhook is distinguishable from an ordinary text message) that, inside a single transaction:
1. Checks for a collision (`prisma.user.findUnique({ where: { phoneNumber } })`).
2. **No collision**: backfill `phoneNumber` onto the BSUID-only `User` row directly.
3. **Collision with a different existing `User`**: set the *current request's* `customerId` to that existing user's id; transfer `whatsappExternalUserId` from the temporary BSUID-only row onto the existing/winning row (null it on the temporary row first within the same transaction, to clear the unique constraint, then set it on the winning row); leave the temporary row in place with `whatsappExternalUserId: null` (not deleted — its `WhatsAppSession` and any other relations stay intact and harmless; it simply becomes unreachable, which is correct, since nothing should resolve to it anymore now that its BSUID has moved).

Either way, finish by calling `completeDepositForRequest(rescueRequestId)`. Make this idempotent against a redelivered webhook: if `phoneNumber` is already set on the resolved account (or the request's `customerId` already points at it) when this handler runs again, skip straight to returning without re-attempting the write, the collision logic, or re-sending the checkout link.

- [ ] **Step 7: Run tests to verify they pass**

Run: `yarn test whatsapp-customer-flow.service -- --no-coverage`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/rescue-request/whatsapp-customer-flow.service.ts src/rescue-request/whatsapp-customer-flow.service.spec.ts test/integration/request-contact-info-response.int-spec.ts
git commit -m "Gate checkout on a real phone number via REQUEST_CONTACT_INFO, after operator assignment"
```

---

### Task 12: Stale contact-info-request reconciler check

**Files:**
- Create: `src/rescue-request/reconciler/checks/stale-contact-info-request.check.ts` (same `ReconcilerCheck` pattern as Task 8 and `deposit-expiry.check.ts`)
- Test: `test/integration/reconciler-stale-contact-info.int-spec.ts`

**Interfaces:**
- Consumes: nothing new — reads `RescueRequest`/`User` state Task 11 already produces.

Multi-LLM review finding: the plan had no fallback for a `REQUEST_CONTACT_INFO` button that's sent but never tapped — a request could sit at the checkout gate indefinitely with no signal to anyone.

- [ ] **Step 1: Write the failing test**

```typescript
it('re-sends REQUEST_CONTACT_INFO for a request stuck waiting on it past the threshold', async () => {
  const request = await createRequestAwaitingContactInfo({ sentAt: twentyMinutesAgo });
  const acted = await check.run(new Date());
  expect(acted).toBe(1);
  expect(twilioService.sendWhatsAppTemplateMessage).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test:integration -- stale-contact-info`
Expected: FAIL — the check doesn't exist yet.

- [ ] **Step 3: Implement `StaleContactInfoRequestCheck`**

Find requests at `WAITING_FOR_DEPOSIT` (or whatever status Task 11 leaves a request in while waiting) whose customer still has `phoneNumber: null`, stale beyond a threshold. Re-send the `REQUEST_CONTACT_INFO` template once; if this is already a retry (track via whatever simple counter/timestamp approach matches how this codebase's other reconciler checks track retry state — e.g. `verifyAttempts` on `Payment` is the established pattern elsewhere, mirror that shape rather than inventing a new one), escalate to staff instead of retrying forever.

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test:integration -- stale-contact-info`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/rescue-request/reconciler/checks/stale-contact-info-request.check.ts test/integration/reconciler-stale-contact-info.int-spec.ts
git commit -m "Add a reconciler check for an unanswered REQUEST_CONTACT_INFO prompt"
```

---

### Task 13: 0%-deposit fallback ask

**⚠️ Open decision, not yet made — read before implementing.** The spec deliberately chose to ask for a phone number only once a 0%-deposit job is "genuinely confirmed," not at quote selection. Multi-LLM review (Gemini) pushed back on this: an operator could be dispatched to a customer who turns out to be unreachable, since the ask happens *after* dispatch, not before. This is a real trade-off against an explicit, already-made spec decision — don't resolve it unilaterally; confirm with the plan owner which of these two insertion points they want before Step 3:
- **(a) At confirmation** (the spec's original choice, implemented below): no added friction before a job is real, but a dispatched operator could reach an unreachable customer.
- **(b) At quote selection**, before the operator-assignment transaction runs: guarantees contactability before dispatch, at the cost of the same shape of friction the spec was trying to avoid everywhere else.

The steps below implement (a); if the plan owner picks (b), the insertion point moves to before the assignment transaction in `handleQuoteSelected` instead, for the 0%-deposit branch specifically.

**Files:**
- Modify: wherever a 0%-deposit request reaches its operator-assigned, confirmed state today (same file/area Task 11 touches — the 0%-deposit branch `handleQuoteSelected` already has; confirm the exact call site by reading the surrounding code, same discipline as Task 11 Step 2)
- Test: `src/rescue-request/whatsapp-customer-flow.service.spec.ts`

**Interfaces:**
- Consumes: the same `REQUEST_CONTACT_INFO` send used in Task 11 — do not duplicate the send logic, call the same helper.

- [ ] **Step 1: Write the failing test**

```typescript
it('sends REQUEST_CONTACT_INFO for a 0%-deposit BSUID-only customer once the job is confirmed', async () => {
  const request = await createTestRequestWithBsuidCustomer({ depositAmount: 0 });
  await service.handleQuoteSelected(request.id, selectedQuote);
  expect(twilioService.sendWhatsAppTemplateMessage).toHaveBeenCalledWith(
    expect.stringContaining('CA.'),
    expect.any(String),
    expect.any(Object),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test whatsapp-customer-flow.service -- --no-coverage -t "0%-deposit"`
Expected: FAIL.

- [ ] **Step 3: Add the gate to the 0%-deposit confirmation path, at the insertion point the plan owner chose above**

Reuse the exact `REQUEST_CONTACT_INFO`-send call Task 11 added (extract it to a small shared private method if Task 11 didn't already leave it as one).

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test whatsapp-customer-flow.service -- --no-coverage -t "0%-deposit"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/rescue-request/whatsapp-customer-flow.service.ts src/rescue-request/whatsapp-customer-flow.service.spec.ts
git commit -m "Ask for a phone number for 0%-deposit BSUID customers"
```

---

### Task 14: Outbound destination audit for remaining DB-driven customer sends

**Files:**
- Modify: whichever call sites Step 1 finds (likely within `src/rescue-request/*.ts` — `payment-events.service.ts`, `dispute.service.ts`, and any reconciler check that messages a customer by their stored `phoneNumber` rather than a live session value)

**Interfaces:**
- Consumes: `toWhatsAppDestination` (Task 3).

- [ ] **Step 1: Enumerate the real call sites**

Run: `grep -rn "toWhatsAppAddress(.*customer" src/ --include=*.ts | grep -v spec` and `grep -rn "sendWhatsAppMessage(\s*customer" src/ --include=*.ts | grep -v spec`
For each result, determine: is it reachable while a request's customer could still have `phoneNumber: null` (i.e., before Task 11/13's gate has run for that request)? Most sends tied to *dispatch* (operator found, quote offers) happen pre-payment and are reachable; sends tied to *post-payment* events (balance due, completion, rating) are not, since by then `phoneNumber` is guaranteed set. (Operator-side sends are covered separately by Task 6 — this task is customer-destination only.)

- [ ] **Step 2: Write a failing test per reachable call site found**

One test per site, following the existing pattern in that file's spec: mock a BSUID-only customer (`phoneNumber: null`, `whatsappExternalUserId` set) and assert the send targets `whatsapp:<externalUserId>` rather than throwing or sending `whatsapp:null`.

- [ ] **Step 3: Run tests to verify they fail**

Run: `yarn test --ci` (scoped to the touched files if faster)
Expected: FAIL at each reachable site identified in Step 1.

- [ ] **Step 4: Replace `toWhatsAppAddress(customer.phoneNumber)` with `toWhatsAppDestination(customer)` at each reachable site**

- [ ] **Step 5: Run tests to verify they pass, then the full suite**

Run: `yarn test --ci`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add <touched files>
git commit -m "Use toWhatsAppDestination for pre-payment customer sends"
```

---

### Task 15: Admin display fix for a null `phoneNumber`

**Files:**
- Modify (lrr-web): `app/components/tabs/RescueRequestsTabAdmin.tsx` (wherever the "Customer" column renders `request.customer.phoneNumber`)
- Modify (lrr-service, if needed): `src/rescue-request/dto/rescue-request-response.dto.ts` — confirm `phoneNumber` is already typed nullable on the relevant DTO; if not, widen it
- Modify (lrr-web): `app/utils/phoneValidation.ts` or wherever `toNigerianDisplayPhoneNumber` lives, if it doesn't already tolerate `null`

**Interfaces:**
- No new interfaces — display-only.

- [ ] **Step 1: Confirm the current broken display**

The spec's own live test (`#PZ6VYM`) showed `CA.1234567890123456` rendered raw in the admin Requests list's "Customer" column — this is the bug being fixed. Locate the exact JSX rendering that value.

- [ ] **Step 2: Write the failing test** (if `RescueRequestsTabAdmin.tsx` has existing test coverage; per the standing `lrr-web-browser-e2e-backlog`, it may not — if there is no test harness for this component, skip to Step 3 and note in the commit message that this is a visual-only fix verified by reading, consistent with how other lrr-web display fixes were handled this session)

- [ ] **Step 3: Render "No phone on file yet" (or similar) when `phoneNumber` is null**, instead of passing a null/BSUID value into any phone-formatting helper. Do not attempt to format a BSUID as if it were a phone number.

- [ ] **Step 4: Verify in the browser**

Start the lrr-web dev server, open the Requests tab, and confirm a request with `customer.phoneNumber: null` (seed one via the admin API or reuse the existing test request if still present) shows the fallback text, not a raw BSUID or `null`.

- [ ] **Step 5: Commit**

```bash
git add app/components/tabs/RescueRequestsTabAdmin.tsx
git commit -m "Show a clear fallback instead of a raw BSUID for a customer with no phone on file"
```

---

### Task 16: Integration test — full BSUID customer journey

**Files:**
- Create: `test/integration/whatsapp-bsuid-customer-journey.int-spec.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-14, exercised together against a real test database — same construction pattern as `test/integration/non-whatsapp-manual-dispatch.int-spec.ts` from the prior plan in this repo (hand-construct the services directly, same dependency-breaking patterns already established there).

- [ ] **Step 1: Write the end-to-end test**

SOS from a BSUID-only sender (`From: whatsapp:CA.journeytest`, no phone) → confirm a `User` is created with `phoneNumber: null` → intake proceeds through quote selection → confirm the operator-assignment transaction runs (status `WAITING_FOR_DEPOSIT`, operator assigned) → confirm `REQUEST_CONTACT_INFO` is sent instead of a checkout link → simulate the contact-info response (using the real field shape proven in Task 11 Step 1) → confirm `phoneNumber` is backfilled and `completeDepositForRequest` runs → confirm no WhatsApp send in the whole journey ever targeted a `null` or malformed destination.

- [ ] **Step 2: Run it to verify it fails for the right reason before Tasks 1-14 exist**

(This step only applies if Task 16 is executed before the earlier tasks are complete — if run after, skip straight to Step 3.)

- [ ] **Step 3: Run the integration suite**

Run: `yarn test:integration:up && DATABASE_URL="postgresql://lrr:lrr@localhost:5433/lrr_test" yarn test:integration && yarn test:integration:down`
Expected: PASS, including this new spec.

- [ ] **Step 4: Commit**

```bash
git add test/integration/whatsapp-bsuid-customer-journey.int-spec.ts
git commit -m "Add integration test for the full BSUID-only customer journey"
```

---

### Task 17: Integration test — operator BSUID recognition and manual override

**Files:**
- Create: `test/integration/whatsapp-bsuid-operator-recognition.int-spec.ts`

**Interfaces:**
- Consumes: Tasks 4-9.

- [ ] **Step 1: Write the end-to-end test**

A registered operator (real `Operator.phoneNumber`, active `OperatorMember`) sends one unmasked message (passively captures their `whatsappExternalUserId`), then sends a later masked `ARRIVED` reply (`From` is their captured BSUID, no phone) → confirm it routes to the operator flow, not the customer flow, and the correct job's status updates, and confirm the arrived-reminder template (Task 6) would address them by BSUID if sent while masked. Separately: an operator whose BSUID has never been captured sends a masked message → confirm it falls through to the customer flow (per Task 7's corrected routing) rather than being blocked → confirm `StuckOperatorJobCheck` (Task 8) finds and alerts on their job once it goes stale → confirm staff can then use the reasoned manual-override action (Task 9) for that same `whatsappEnabled: true` operator's job, and that it resets their session.

- [ ] **Step 2: Run the integration suite**

Run: `yarn test:integration:up && DATABASE_URL="postgresql://lrr:lrr@localhost:5433/lrr_test" yarn test:integration && yarn test:integration:down`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/integration/whatsapp-bsuid-operator-recognition.int-spec.ts
git commit -m "Add integration test for operator BSUID recognition, staleness, and manual override"
```
