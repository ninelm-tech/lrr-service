# WhatsApp BSUID Contact-Info Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before a BSUID-only (masked WhatsApp username) customer's rescue request is dispatched, capture their real phone number via WhatsApp's native "Share Contact" flow, so dispatch and payment never run for a customer with no phone number on file.

**Architecture:** One new blocking state (`WAITING_FOR_CONTACT_INFO`) inserted into the existing linear intake state machine in `whatsapp-customer-flow.service.ts`, between the photo step and dispatch start. A new pure-domain vCard parser extracts the phone number — the only field this gate cares about — from the Twilio-hosted vCard file. Two collision cases get explicit handling: the number belongs to a registered operator (rejected), or to a different pre-existing customer account (full identity merge: session + in-progress request move to the surviving account).

**Tech Stack:** NestJS, Prisma/Postgres, Twilio Content API (already-shipped `request_contact_info` template), yarn/Jest.

**Spec:** `docs/superpowers/specs/2026-10-26-whatsapp-bsuid-contact-gate-design.md`

**Revision note:** this plan went through a design-stage review (Codex + an independent Claude subagent; Gemini hung and was abandoned after far exceeding its normal run time). This version folds in every confirmed finding: email/address capture dropped entirely (per the user — simplifies away two of the review's findings at once: the email-write transaction bug, and address having nowhere to be stored), a real concurrency claim added (the original only handled sequential redelivery), the phone validator now requires a leading `+`, the former Tasks 3/4 split (which didn't compile independently) merged into one task, the merge path's reply-address bug fixed, and the non-null-existing-BSUID collision case explicitly tested rather than left implicit. "Commit" steps changed to match this repo's standing no-commit-without-approval rule.

## Global Constraints

- No Meta/WhatsApp template approval is required to send `request_contact_info` within an active 24h session — confirmed empirically, contradicting a stale comment in the already-shipped `twilio-content-templates.ts` (Task 1 corrects it).
- **This gate captures the phone number only.** No email, no address. (Dropped during plan review — email's "best-effort" write doesn't actually work the way a first draft assumed, since Postgres aborts a whole transaction on any failed statement regardless of try/catch; address has no `User` column to land in. Neither is worth the complexity for a field nothing downstream consumes.)
- `User.phoneNumber` and `User.whatsappExternalUserId` are each independently `@unique` (verified in `prisma/schema.prisma`). `Operator.phoneNumber` is `@unique` on a separate table — nothing at the DB level stops a customer's phone number from colliding with an operator's.
- `WhatsAppSession.userId` is `@unique` but is **not** the session's own primary key (`WhatsAppSession.id` is) — a session can be re-pointed to a different `userId` via a plain update, as long as no other session already holds that `userId`.
- Never write a BSUID into `User.phoneNumber`. Never accept a shared contact that has no `TEL` field as satisfying this gate.
- The shared phone number must never be validated with `normalizePhone` (`src/common/phone.util.ts`) — it's Nigeria-only and its own doc comment says not to use it on the WhatsApp inbound path. A vCard-extracted number must be validated by a separate, country-agnostic, non-throwing check that **requires** a leading `+` (an existing `Operator`/`User.phoneNumber` lookup only matches if the stored form is identical — a bare national-format number would silently bypass both collision checks).
- `RescueRequestStatus` stays `WAITING_FOR_MEDIA` for the whole time a session sits in `WAITING_FOR_CONTACT_INFO` — only the session-level `WhatsAppFlowState` changes.
- Every send of the `request_contact_info` template (the initial ask, and every re-prompt) must tolerate the send itself failing (missing env var, Twilio error) — catch it, log it, and still give the customer a plain-text reply telling them to try again, rather than letting an unhandled rejection block the state transition and leave Twilio redelivering.
- The merge path must keep replying to **this turn's actual inbound WhatsApp address** (the `phoneNumber` parameter `handleCustomerMessage` already received) — never the vCard-extracted number — even after the customer's identity resolves to a different `User` row. The live conversation thread is addressed by whatever Twilio is already using for it, not by a DB value.
- A concurrent duplicate delivery of the same contacts webhook must not double-run the backfill or the merge. This plan closes that with an atomic claim (see Task 3) — **this is distinct from, and does not fix,** the pre-existing, separately-tracked `handleMediaFinished` idempotency gap (`lrr-dispatch-start-idempotency-gap` backlog item), which stays out of scope.
- Every file follows this repo's CLAUDE.md conventions: `dto/` for shapes (plain `interface`, matching the existing `TwilioStatusCallbackBody` precedent), `domain/` for pure framework-free logic, no types defined inline in a service/controller file.
- `yarn`, not `npm`, for every command below.
- **No step in this plan ends with an actual `git commit`.** Per this repo's standing rule, every "Commit" step means: stage the files, show the user the diff and the proposed commit message, and wait for their explicit approval before running `git commit` — never run it unprompted.

## Review Focus

- A shared vCard contains no `TEL` line at all — must re-prompt, not silently accept partial contact info (Task 1/3).
- A `TEL` value with no country code (bare national format) must be rejected, not stored as a non-`+E.164` value that silently fails every later collision/identity lookup (Task 1).
- Two concurrent deliveries of the same contacts webhook must not both pass the gate — the second must find itself already claimed and exit quietly, not crash or double-dispatch (Task 3).
- The shared phone number belongs to a registered `Operator` — must be rejected, never written to `User.phoneNumber` (Task 3).
- The shared phone number belongs to a different, pre-existing `User` (with either no BSUID or a different one already) — must migrate the live session and in-progress `RescueRequest` onto the surviving row, and must keep replying to the live conversation's own address throughout (Task 3).

---

### Task 1: vCard phone parsing

**Files:**
- Create: `src/rescue-request/dto/parsed-contact.dto.ts`
- Create: `src/rescue-request/domain/parse-vcard.ts`
- Test: `src/rescue-request/domain/parse-vcard.spec.ts`
- Modify: `src/integrations/twilio/twilio-content-templates.ts:255-285` (correct the stale approval-requirement comment on the `request_contact_info` entry — it currently claims Meta approval is required regardless of session window; this was proved false by direct testing. Replace with: confirmed empirically 2026-10-26 to send and render without approval inside an active session, on the LRR Stage subaccount.)

**Interfaces:**
- Produces: `ParsedContact { phoneNumber: string }` (dto); `parseVCard(vCardText: string): ParsedContact | undefined`; `isContactShareWebhook(body: { MessageType?: string; ChannelMetadata?: string }): boolean` — both consumed by Task 3.

- [ ] **Step 1: Write the failing tests**

```typescript
// parse-vcard.spec.ts
describe('parseVCard', () => {
  it('extracts the phone number from a TEL line', () => {
    const vcard = 'BEGIN:VCARD\nVERSION:3.0\nFN:Jane Doe\nTEL;type=CELL;waid=15550100001:+15550100001\nEND:VCARD';
    expect(parseVCard(vcard)).toEqual({ phoneNumber: '+15550100001' });
  });

  it('returns undefined when there is no TEL line at all', () => {
    const vcard = 'BEGIN:VCARD\nFN:Jane Doe\nEMAIL:jane@example.com\nEND:VCARD';
    expect(parseVCard(vcard)).toBeUndefined();
  });

  it('returns undefined when the TEL value is not a plausible phone number', () => {
    const vcard = 'BEGIN:VCARD\nTEL:not-a-number\nEND:VCARD';
    expect(parseVCard(vcard)).toBeUndefined();
  });

  it('returns undefined for a bare national-format number with no country code', () => {
    const vcard = 'BEGIN:VCARD\nTEL:08031234567\nEND:VCARD';
    expect(parseVCard(vcard)).toBeUndefined();
  });

  it('takes the first TEL line when there are several', () => {
    const vcard = 'BEGIN:VCARD\nTEL;type=CELL:+15550100001\nTEL;type=HOME:+15550100002\nEND:VCARD';
    expect(parseVCard(vcard)?.phoneNumber).toBe('+15550100001');
  });

  it('strips formatting characters but keeps the leading +', () => {
    const vcard = 'BEGIN:VCARD\nTEL:+1 (555) 010-0001\nEND:VCARD';
    expect(parseVCard(vcard)?.phoneNumber).toBe('+15550100001');
  });
});

describe('isContactShareWebhook', () => {
  it('is true for a contacts message tied to our request', () => {
    expect(isContactShareWebhook({
      MessageType: 'contacts',
      ChannelMetadata: JSON.stringify({ data: { context: { Origin: 'contact_request' } } }),
    })).toBe(true);
  });

  it('is false when MessageType is not contacts', () => {
    expect(isContactShareWebhook({ MessageType: 'text', ChannelMetadata: '{}' })).toBe(false);
  });

  it('is false when ChannelMetadata is missing or unparseable', () => {
    expect(isContactShareWebhook({ MessageType: 'contacts' })).toBe(false);
    expect(isContactShareWebhook({ MessageType: 'contacts', ChannelMetadata: 'not json' })).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test parse-vcard.spec.ts`
Expected: FAIL with "parseVCard is not defined" / module not found.

- [ ] **Step 3: Implement**

`parseVCard(vCardText: string): ParsedContact | undefined` — split on newlines, find the first line starting with `TEL` (case-insensitive, allowing `;param=value` segments before the `:`), take everything after the last `:` as the raw value. Strip every character except digits and `+`. Validate with `/^\+\d{8,15}$/` — the stripped value must start with `+` (reject bare national formats outright, do not guess/prepend a country code) — return `undefined` for the whole function if that one `TEL` line's value doesn't match the regex. **Only the first `TEL` line is ever examined** — do not fall through to a second `TEL` line if the first fails validation; a vCard's other `TEL` entries are different numbers, not alternate spellings of the same one, so guessing among them by whichever happens to pass the regex would be arbitrary, not more correct. Do not look at `EMAIL`/`ADR` lines at all.

`isContactShareWebhook(body)` — `body.MessageType === 'contacts'` and, wrapped in try/catch, `JSON.parse(body.ChannelMetadata ?? '').data?.context?.Origin === 'contact_request'`; any parse failure or missing field returns `false`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test parse-vcard.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

Stage `src/rescue-request/dto/parsed-contact.dto.ts src/rescue-request/domain/parse-vcard.ts src/rescue-request/domain/parse-vcard.spec.ts src/integrations/twilio/twilio-content-templates.ts`, show the diff and the message "Add vCard phone parsing and correct stale Meta-approval comment", and wait for approval before committing.

---

### Task 2: `WAITING_FOR_CONTACT_INFO` state — the ask

**Files:**
- Modify: `src/rescue-request/state/whatsapp-session.types.ts` (add `WAITING_FOR_CONTACT_INFO = 'WAITING_FOR_CONTACT_INFO'` to `WhatsAppFlowState`, after `WAITING_FOR_MEDIA`)
- Modify: `src/rescue-request/whatsapp-customer-flow.service.ts:595-612` (the `message === '2'` branch of the `WAITING_FOR_MEDIA` block)
- Test: `src/rescue-request/whatsapp-customer-flow.service.spec.ts`

**Interfaces:**
- Produces: the `WAITING_FOR_CONTACT_INFO` state value and a private helper `sendContactInfoRequest(phoneNumber: string): Promise<boolean>` (sends the template, returns whether it succeeded — swallows and logs any error rather than throwing), both consumed by Task 3.

- [ ] **Step 1: Write the failing tests**

```typescript
it('asks for contact info instead of dispatching when the customer has no phone number', async () => {
  const user = await createTestUser({ phoneNumber: null, whatsappExternalUserId: 'CA.test' });
  const request = await createTestRescueRequest({ customerId: user.id, status: 'WAITING_FOR_MEDIA' });
  await createTestMedia(request.id); // at least one photo already uploaded
  process.env.TWILIO_CONTACT_INFO_REQUEST_TEMPLATE_SID = 'HXtest';

  await service.handleCustomerMessage('whatsapp:CA.test', user.id, '2', '2', undefined, undefined, undefined, sessionAt(WAITING_FOR_MEDIA, request.id), {});

  expect(twilio.sendWhatsAppTemplateMessage).toHaveBeenCalledWith('whatsapp:CA.test', 'HXtest', {});
  const session = await sessionStore.getOrCreate(user.id);
  expect(session.state).toBe(WhatsAppFlowState.WAITING_FOR_CONTACT_INFO);
});

it('still dispatches normally when the customer already has a phone number', async () => {
  const user = await createTestUser({ phoneNumber: '+2348012345678' });
  // ... same setup, assert handleMediaFinished's effects (status DISPATCHING) instead
  // — zero new behavior for a non-masked customer.
});

it('still moves to WAITING_FOR_CONTACT_INFO, with a plain-text fallback reply, when the template send fails', async () => {
  const user = await createTestUser({ phoneNumber: null, whatsappExternalUserId: 'CA.test' });
  // ... same setup, but delete process.env.TWILIO_CONTACT_INFO_REQUEST_TEMPLATE_SID
  // (or twilio.sendWhatsAppTemplateMessage.mockRejectedValue(new Error('boom')))
  // assert: no unhandled rejection, session state still becomes WAITING_FOR_CONTACT_INFO,
  // reply is plain text (not a thrown error).
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test whatsapp-customer-flow.service.spec.ts`
Expected: FAIL — state stays `WAITING_FOR_MEDIA` / `handleMediaFinished` is called unconditionally / send failure throws.

- [ ] **Step 3: Implement**

In the `message === '2'` branch, after the existing `visualCount === 0` check and before the existing `return this.handleMediaFinished(...)` call: fetch the customer, and if `customer.phoneNumber` is null, call the new `sendContactInfoRequest(phoneNumber)` helper, then unconditionally `this.sessionStore.update(userId, { state: WhatsAppFlowState.WAITING_FOR_CONTACT_INFO })` (regardless of whether the send succeeded — per Global Constraints), and reply with a plain-text message asking them to share their contact (used whether or not the template send itself also went through — a customer who got both isn't harmed by the duplicate). Return early — do not fall through to `handleMediaFinished`. If `customer.phoneNumber` is already set, fall through to the existing `handleMediaFinished` call unchanged.

`sendContactInfoRequest(phoneNumber)`: read `process.env.TWILIO_CONTACT_INFO_REQUEST_TEMPLATE_SID`; if unset, log and return `false`. Otherwise call `this.twilioService.sendWhatsAppTemplateMessage(phoneNumber, templateSid, {})` inside a try/catch — log + `Sentry.captureException` on failure, return `true`/`false` for success/failure. Never throws.

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test whatsapp-customer-flow.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

Stage `src/rescue-request/state/whatsapp-session.types.ts src/rescue-request/whatsapp-customer-flow.service.ts src/rescue-request/whatsapp-customer-flow.service.spec.ts`, show the diff and the message "Gate dispatch on a real phone number for BSUID-only customers", and wait for approval before committing.

---

### Task 3: `WAITING_FOR_CONTACT_INFO` handler — validate, claim, backfill or merge

**Files:**
- Modify: `src/rescue-request/whatsapp-customer-flow.service.ts` (new `if (session.state === WhatsAppFlowState.WAITING_FOR_CONTACT_INFO)` block, inserted after the `WAITING_FOR_MEDIA` block)
- Create: `src/webhooks/dto/twilio-inbound-message.dto.ts` (plain optional interface: `MessageType?: string; MediaUrl0?: string; MediaContentType0?: string; ChannelMetadata?: string`, following the `TwilioStatusCallbackBody` pattern)
- Test: `src/rescue-request/whatsapp-customer-flow.service.spec.ts`

**Interfaces:**
- Consumes: `parseVCard`, `isContactShareWebhook` (Task 1); `WAITING_FOR_CONTACT_INFO`, `sendContactInfoRequest` (Task 2); `this.twilioService.downloadMedia(url: string): Promise<Buffer>` (already shipped, `twilio.service.ts:146`).
- Produces: nothing consumed elsewhere — this is the leaf handler.

(This task was originally split into two — a "simple backfill" task and a separate "merge" task — but the simple-path task's own code needs to call the merge logic to compile, so they're one task. Both branches share the same detection/validation/claim steps below; they only differ in which row ends up holding the phone number.)

- [ ] **Step 1: Write the failing tests**

```typescript
it('re-prompts on an off-script reply', async () => {
  // session in WAITING_FOR_CONTACT_INFO, inbound body has no MessageType at all
  // assert: sendContactInfoRequest called again (re-prompt), state unchanged
});

it('re-prompts when the shared vCard has no phone number', async () => {
  // MessageType: 'contacts', ChannelMetadata Origin contact_request, downloadMedia resolves
  // a vCard with no TEL line
  // assert: re-prompt, state unchanged, User.phoneNumber still null
});

it('tolerates a transient vCard fetch failure', async () => {
  // downloadMedia rejects with TwilioMediaDownloadError(url, 404, ...)
  // assert: re-prompt (not a crash), state unchanged
});

it('rejects and re-prompts when the shared number belongs to a registered operator', async () => {
  // create an Operator with phoneNumber '+15550100001'; shared vCard TEL is the same number
  // assert: re-prompt, User.phoneNumber still null, Operator row untouched
});

it('backfills the phone number and dispatches when there is no collision', async () => {
  // shared vCard TEL '+15550100001', no matching Operator, no matching User
  // assert: User.phoneNumber === '+15550100001'; handleMediaFinished's effect
  // (RescueRequest.status === DISPATCHING) ran; the reply/send address used was
  // the session's own inbound address, not the vCard number; session state
  // advanced past WAITING_FOR_CONTACT_INFO
});

it('merges onto a pre-existing account with no prior BSUID when the shared number collides', async () => {
  const existing = await createTestUser({ phoneNumber: '+15550100001', whatsappExternalUserId: null });
  const masked = await createTestUser({ phoneNumber: null, whatsappExternalUserId: 'CA.masked' });
  const request = await createTestRescueRequest({ customerId: masked.id, status: 'WAITING_FOR_MEDIA' });
  // masked has the live WhatsAppSession; existing has none

  // inbound contacts webhook, from masked's session, sharing +15550100001

  const survivor = await prisma.user.findUnique({ where: { id: existing.id } });
  expect(survivor?.whatsappExternalUserId).toBe('CA.masked');
  const updatedRequest = await prisma.rescueRequest.findUnique({ where: { id: request.id } });
  expect(updatedRequest?.customerId).toBe(existing.id);
  const session = await prisma.whatsAppSession.findUnique({ where: { userId: existing.id } });
  expect(session).not.toBeNull();
  const orphan = await prisma.user.findUnique({ where: { id: masked.id } });
  expect(orphan?.deletedAt).not.toBeNull();
});

it('merges the same way when the pre-existing account already has a different BSUID', async () => {
  // Same as above, but existing.whatsappExternalUserId = 'CA.some-other-stale-id' going in.
  // The merge overwrites it with 'CA.masked', same as findOrCreateBySender already does
  // unconditionally for the equivalent fresh-message case (rescue-request-shared.service.ts:53-80)
  // — not a special case, just confirming the same code path handles it without throwing.
  // assert: survivor.whatsappExternalUserId === 'CA.masked' (not the stale prior value), no error thrown.
});

it('discards the existing account’s own stale session in favor of the live masked one', async () => {
  const existing = await createTestUser({ phoneNumber: '+15550100001' });
  await createTestWhatsAppSession(existing.id, { state: 'IDLE' }); // existing already has an old, stale session
  // ... same merge as above
  // assert exactly one WhatsAppSession row exists afterward, keyed to existing.id,
  // carrying the masked session's live state (rescueRequestId still set), not IDLE.
});

it('a second, concurrent delivery of the same contacts webhook finds the gate already claimed and does nothing', async () => {
  // Simulate two near-simultaneous calls sharing the same valid, non-colliding vCard.
  // The first call's claim (the conditional session-state update) must succeed;
  // simulate the second by calling again with the session already past
  // WAITING_FOR_CONTACT_INFO (same as the first call left it) — assert it does NOT
  // re-run the backfill or re-call handleMediaFinished a second time (e.g. staff
  // alerts / "Searching..." sent only once — assert twilio.sendWhatsAppMessage's
  // call count, not just that the DB ended up in a sane state).
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test whatsapp-customer-flow.service.spec.ts`
Expected: FAIL — no `WAITING_FOR_CONTACT_INFO` handler block exists yet.

- [ ] **Step 3: Implement**

New block, `session.state === WhatsAppFlowState.WAITING_FOR_CONTACT_INFO`:

1. If `!isContactShareWebhook(body)`, call `sendContactInfoRequest(phoneNumber)` (re-prompt) and reply with the same plain-text fallback as Task 2 — stay in state.
2. Otherwise, `try { buffer = await this.twilioService.downloadMedia(body.MediaUrl0!) } catch { /* re-prompt same as step 1 */ }`.
3. `parsed = parseVCard(buffer.toString('utf-8'))`; if `undefined`, re-prompt same as step 1.
4. Operator-collision check: `this.prisma.operator.findUnique({ where: { phoneNumber: parsed.phoneNumber } })` (mirrors `whatsapp-inbound.service.ts:90-93`'s exact inline pattern) — if found, re-prompt same as step 1, write nothing.
5. **Claim, before any other write:** `const claim = await this.prisma.whatsAppSession.updateMany({ where: { userId, state: WhatsAppFlowState.WAITING_FOR_CONTACT_INFO }, data: { state: WhatsAppFlowState.REQUEST_CONFIRMED } })`. If `claim.count === 0`, another delivery already claimed this exact transition — return a no-op reply (empty TwiML response, same shape Twilio expects when there's genuinely nothing new to say) and do nothing further. This is the one atomic write that makes the rest of this step single-flight; `handleMediaFinished` (called below) will harmlessly re-set the same `REQUEST_CONFIRMED` value it would have set anyway.
6. `existingUser = this.prisma.user.findUnique({ where: { phoneNumber: parsed.phoneNumber } })`.
   - If none, or `existingUser.id === userId`: `this.prisma.user.update({ where: { id: userId }, data: { phoneNumber: parsed.phoneNumber } })`, then call `handleMediaFinished(phoneNumber, userId, session, session.rescueRequestId!)` — **`phoneNumber` here is the original parameter this function already received, not `parsed.phoneNumber`.**
   - Otherwise (a different existing user): call `mergeIntoExistingAccount(userId, existingUser, session.rescueRequestId!, parsed)` (Task 3's own method, see below), then call `handleMediaFinished(phoneNumber, merged.userId, session, session.rescueRequestId!)` — again, `phoneNumber` stays the original inbound value; only the `userId` argument changes.

`mergeIntoExistingAccount(maskedUserId: string, existingUser: User, rescueRequestId: string, parsed: ParsedContact): Promise<{ userId: string }>` — one `$transaction`, mirroring `findOrCreateBySender`'s BSUID-move shape (`rescue-request-shared.service.ts:53-80`) exactly, with no special-casing for whether `existingUser.whatsappExternalUserId` was null beforehand:
   a. Read the masked user's current BSUID (`tx.user.findUnique({ where: { id: maskedUserId } })`).
   b. `tx.user.updateMany({ where: { whatsappExternalUserId: <that BSUID>, id: { not: existingUser.id } }, data: { whatsappExternalUserId: null } })` then `tx.user.update({ where: { id: existingUser.id }, data: { whatsappExternalUserId: <that BSUID>, phoneNumber: parsed.phoneNumber } })`.
   c. `tx.whatsAppSession.deleteMany({ where: { userId: existingUser.id } })` (discard any stale session the existing account already had).
   d. `tx.whatsAppSession.update({ where: { userId: maskedUserId }, data: { userId: existingUser.id } })` (re-point the live, already-claimed session onto the surviving account).
   e. `tx.rescueRequest.update({ where: { id: rescueRequestId }, data: { customerId: existingUser.id } })`.
   f. `tx.user.update({ where: { id: maskedUserId }, data: { deletedAt: new Date() } })` (soft-delete the now-identity-less orphan).
   Return `{ userId: existingUser.id }`.

(No `waid=` cross-check against the vCard's own metadata is added here: this session's own live testing confirmed WhatsApp's Share-Contact reply to a `request_contact_info` prompt is scoped to the sender's own profile fields — "everything added as me" — not an arbitrary contact the sender could pick from their address book. The trust basis is the same one already extended to `WaId`/`From` on every other inbound message in this codebase.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test whatsapp-customer-flow.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

Stage `src/rescue-request/whatsapp-customer-flow.service.ts src/rescue-request/whatsapp-customer-flow.service.spec.ts src/webhooks/dto/twilio-inbound-message.dto.ts`, show the diff and the message "Handle the contact-info response: validate, claim, backfill or merge", and wait for approval before committing.

---

### Task 4: End-to-end integration test

**Files:**
- Create: `test/integration/whatsapp-bsuid-contact-gate.int-spec.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–3, exercised together against a real test database — same construction pattern as `test/integration/whatsapp-bsuid-operator-recognition.int-spec.ts` (services built directly with `new`, no DI container; Twilio as a plain jest-mock object with `sendWhatsAppTemplateMessage` and `downloadMedia` stubbed; assertions read back via `prisma.*.findUnique`, not mock call args alone).

- [ ] **Step 1: Write the integration tests**

```typescript
describe('WhatsApp BSUID contact-info gate', () => {
  it('masked happy path: SOS through photos triggers the ask, Share Contact unblocks dispatch', async () => { /* ... */ });
  it('a customer who already has a phone number never sees the new state', async () => { /* ... */ });
  it('off-script reply at the contact-info step re-prompts and stays in state', async () => { /* ... */ });
  it('a vCard with no TEL line re-prompts and stays in state', async () => { /* ... */ });
  it('a transient vCard 404 re-prompts rather than crashing', async () => { /* ... */ });
  it('a bare national-format phone number is rejected rather than stored unnormalized', async () => { /* ... */ });
  it('a number colliding with a registered operator is rejected, never written', async () => { /* ... */ });
  it('a number colliding with a different existing customer triggers the full merge, replying on the original conversation address throughout', async () => { /* ... */ });
  it('a concurrent duplicate of the contacts webhook does not double-claim, double-backfill, or double-call handleMediaFinished', async () => { /* ... */ });
  it('a customer who never responds can still reply CANCEL', async () => { /* ... */ });
});
```

- [ ] **Step 2: Run the integration suite**

Run: `yarn test:integration:up && DATABASE_URL="postgresql://lrr:lrr@localhost:5433/lrr_test" yarn test:integration && yarn test:integration:down`
Expected: PASS, including this new spec.

- [ ] **Step 3: Commit**

Stage `test/integration/whatsapp-bsuid-contact-gate.int-spec.ts`, show the diff and the message "Add end-to-end integration test for the BSUID contact-info gate", and wait for approval before committing.
