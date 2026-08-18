# `rescue-request.service.ts` Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the 2,541-line `rescue-request.service.ts` into 8 focused services with no behavior change, per `docs/superpowers/specs/2026-08-18-rescue-request-service-decomposition-design.md`.

**Architecture:** Each task extracts one cohesive region (by exact line range, confirmed in the spec) into its own `@Injectable()` service, registered in `rescue-request.module.ts`. No facade survives — the two real external callers (`webhooks.controller.ts`, `payment.service.ts`) are updated to inject the specific new service they need. Extraction order goes smallest/most-isolated first; the top-level router (`WhatsAppInboundService`) is extracted last since it ends up calling nearly everything else.

**Tech Stack:** NestJS + Prisma, Jest.

## Global Constraints

- **No behavior changes.** Any difference in message text, status transition, or timing found during extraction is a bug to fix separately, not to bundle in silently — flag it and ask rather than "improve" it in passing.
- **No facade `RescueRequestService`.** External callers inject the specific new service directly (see Task 8 and Task 2).
- **`DispatchService` is a singleton, registered once.** Never re-provided in a second module's `providers` array — would fork `batchTimers`/`graceTimers` into independent maps.
- **`processQuoteOrDecline` is the one canonical accept/decline operation** on `DispatchService` — both the WhatsApp operator flow and the REST `respondToOffer` path call into it, neither reimplements it.
- **`rescue-request-shared.service.ts` holds only `findOrCreateCustomer`** — infra/domain primitives used by ≥2 extracted services, never workflow orchestration. `alertAdminNoOperator` goes to `DispatchService`, not shared (all 3 call sites are dispatch-only).
- **After every task:** `npx tsc --noEmit`, full `npx jest` suite, AND a module-compile smoke test (`tsc` does not catch missing NestJS providers — this is the real DI-correctness check).
- **Exact line ranges below are as of this plan's writing** — they will drift as earlier tasks remove code from `rescue-request.service.ts`. Each task's implementer must re-locate the named methods by name/content in the *current* state of the file, not trust a stale line number.

---

### Task 1: Module-compile smoke test (do this first, before any extraction)

**Files:**
- Create: `src/rescue-request/rescue-request.module.spec.ts`

**Interfaces:**
- Produces: a reusable smoke-test pattern every later task's Step "verify DI wiring" points back to.

- [ ] **Step 1: Write the smoke test**

```ts
import { Test } from '@nestjs/testing';
import { RescueRequestModule } from './rescue-request.module';

describe('RescueRequestModule (DI smoke test)', () => {
  it('compiles the full module graph without throwing', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [RescueRequestModule],
    })
      .overrideProvider(require('../prisma/prisma.service').PrismaService).useValue({})
      .compile();

    expect(moduleRef).toBeDefined();
  });
});
```

If `PrismaService`'s real constructor requires a live DB connection to instantiate, override it as above (an empty object satisfies DI resolution — this test only checks the module graph resolves, not that methods work). If it does not require one, the `overrideProvider` line can be dropped — try without it first.

- [ ] **Step 2: Run it to confirm it currently passes**

Run: `npx jest rescue-request.module --verbose`
Expected: PASS. This is the baseline — every later task re-runs this exact test after rewiring `rescue-request.module.ts`, and a failure means a provider was moved without updating the module's `providers`/`imports`.

- [ ] **Step 3: Commit**

```bash
git add src/rescue-request/rescue-request.module.spec.ts
git commit -m "test(rescue-request): add module DI smoke test before decomposition"
```

---

### Task 2: Extract `dispute.service.ts`

**Files:**
- Create: `src/rescue-request/dispute.service.ts`
- Create: `src/rescue-request/dispute.service.spec.ts`
- Modify: `src/rescue-request/rescue-request.service.ts` (remove extracted methods, call the new service instead)
- Modify: `src/rescue-request/rescue-request.service.spec.ts` (remove the `DISPUTE handling`/`resolveDispute` describe blocks — they move wholesale)
- Modify: `src/rescue-request/rescue-request.module.ts` (register `DisputeService`)
- Modify: `src/rescue-request/rescue-request.controller.ts` (inject `DisputeService` for the `resolve-dispute` route)

**Interfaces:**
- Consumes: `PrismaService`, `TwilioService`, `PlatformConfigService` (all already available in the module).
- Produces: `DisputeService.raiseDispute(rescueRequestId: string, customerPhoneNumber: string): Promise<void>`, `DisputeService.resolveDispute(rescueRequestId: string): Promise<{ resolved: boolean }>` — consumed by Task 7 (`WhatsAppCustomerFlowService` calls `raiseDispute`) and the controller (calls `resolveDispute`).

- [ ] **Step 1: Locate and extract the three methods verbatim**

In the current `src/rescue-request/rescue-request.service.ts`, find (by name — line numbers have likely shifted from the spec's 2259–2337 if any earlier edits landed):
- `private async raiseDispute(rescueRequestId: string, customerPhoneNumber: string) { ... }`
- `private async sendStaffDisputeAlert(rescueRequest: any) { ... }`
- `async resolveDispute(rescueRequestId: string): Promise<{ resolved: boolean }> { ... }`

Copy all three method bodies verbatim (do not paraphrase or "clean up" anything — this is a pure move) into a new file:

```ts
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { toWhatsAppAddress } from '../common/phone.util';
import { formatJobRef } from './domain/rescue-request-formatting';

@Injectable()
export class DisputeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly twilioService: TwilioService,
    private readonly platformConfigService: PlatformConfigService,
  ) {}

  // raiseDispute, sendStaffDisputeAlert, resolveDispute go here, bodies
  // copied verbatim from rescue-request.service.ts. Two adjustments only:
  //   1. `this.formatJobRef(...)` becomes the imported `formatJobRef(...)`
  //      (Task 4 hasn't run yet — if Task 4 hasn't landed, temporarily keep
  //      formatJobRef as a private method copied alongside these three,
  //      and remove the duplicate once Task 4 extracts the domain module).
  //   2. Method visibility: raiseDispute and sendStaffDisputeAlert can stay
  //      private; resolveDispute must be public (called from the controller).
}
```

- [ ] **Step 2: Remove the three methods from `rescue-request.service.ts`, replace call sites**

The customer-flow `DISPUTE` branch (inside `handleIncomingWhatsAppMessage`) currently calls `this.raiseDispute(...)` — change to call an injected `DisputeService` instead. Add to `RescueRequestService`'s constructor: `private readonly disputeService: DisputeService,` and change the call site to `this.disputeService.raiseDispute(...)`.

The old `resolveDispute` public method on `RescueRequestService` is deleted entirely — `rescue-request.controller.ts`'s `resolveDispute` route handler now calls `this.disputeService.resolveDispute(id)` instead of `this.rescueRequestService.resolveDispute(id)`. Update the controller's constructor accordingly (inject `DisputeService` alongside the existing `RescueRequestService`).

- [ ] **Step 3: Move the tests**

In `rescue-request.service.spec.ts`, find the `describe('DISPUTE handling (via WhatsApp router)', ...)` block (includes the nested `describe('resolveDispute', ...)`). Cut this entire block out and paste it into a new `dispute.service.spec.ts`, adjusting:
- `TestingModule` providers: only needs `DisputeService`, `PrismaService`, `TwilioService`, `PlatformConfigService` mocks — drop `WhatsAppSessionStore`, `OperatorService`, `S3Service`, `GeocodingService`, `RatingService`, `PayoutService` (not used by this service).
- Test calls that went through `disputeTestService.handleIncomingWhatsAppMessage({...})` to trigger a dispute now call `disputeTestService.raiseDispute(rescueRequestId, customerPhone)` directly instead — the routing-through-WhatsApp-message layer is being tested elsewhere (Task 7's customer-flow tests just assert `raiseDispute` gets called with the right args, not its internals).
- `resolveDispute` tests call `disputeTestService.resolveDispute(...)` unchanged (same method name/signature, new home).

- [ ] **Step 4: Register in the module**

In `rescue-request.module.ts`, add `DisputeService` to `providers`. Confirm it doesn't need adding to `exports` unless something outside this module calls it directly (it doesn't, per the spec).

- [ ] **Step 5: Run the module smoke test**

Run: `npx jest rescue-request.module --verbose`
Expected: PASS.

- [ ] **Step 6: Run everything**

Run: `npx tsc --noEmit && npx jest`
Expected: no type errors, all suites pass.

- [ ] **Step 7: Commit**

```bash
git add src/rescue-request/
git commit -m "refactor(rescue-request): extract DisputeService"
```

---

### Task 3: Extract `payment-events.service.ts`

**Files:**
- Create: `src/rescue-request/payment-events.service.ts`
- Create: `src/rescue-request/payment-events.service.spec.ts`
- Modify: `src/rescue-request/rescue-request.service.ts`, `.spec.ts`, `rescue-request.module.ts`
- Modify: `src/payment/payment.service.ts` (inject `PaymentEventsService` instead of `RescueRequestService`)
- Modify: `src/payment/payment.module.ts` (import `RescueRequestModule` still works since `PaymentEventsService` is exported from it — no new module dependency needed, just a different provider from the same module)

**Interfaces:**
- Consumes: `PrismaService`, `PaystackService` (direct — **never** `PaymentService`, see Global Constraints), `TwilioService`, `PayoutService`.
- Produces: `PaymentEventsService.handleDepositPaymentConfirmed(reference: string): Promise<void>`, `PaymentEventsService.handleBalancePaymentConfirmed(reference: string): Promise<void>` — consumed by `payment.service.ts`. `markJobCompleted`/`sendBalancePaymentLink` stay private/internal to this service.

- [ ] **Step 1: Extract the four methods verbatim**

Locate and move (by name, not stale line numbers): `handleDepositPaymentConfirmed`, `handleBalancePaymentConfirmed`, `markJobCompleted`, `sendBalancePaymentLink`.

```ts
import { Injectable } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { PrismaService } from '../prisma/prisma.service';
import { PaystackService } from '../integrations/paystack/paystack.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { PayoutService } from '../payout/payout.service';
import { toWhatsAppAddress } from '../common/phone.util';
import { RescueRequestStatus, WhatsAppFlowState } from '@prisma/client'; // confirm exact import source by checking current usage in rescue-request.service.ts — WhatsAppFlowState comes from './state/whatsapp-session.types', not @prisma/client
import { WhatsAppSessionStore } from './state/whatsapp-session.store';

@Injectable()
export class PaymentEventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paystackService: PaystackService,
    private readonly twilioService: TwilioService,
    private readonly payoutService: PayoutService,
    private readonly sessionStore: WhatsAppSessionStore,
  ) {}

  // handleDepositPaymentConfirmed, handleBalancePaymentConfirmed,
  // markJobCompleted, sendBalancePaymentLink go here verbatim.
  //
  // CRITICAL per the design's payment-cycle rule: sendBalancePaymentLink
  // must call `this.paystackService` directly (already does, in the
  // current source) — do NOT change it to call PaymentService, and do NOT
  // add a PaymentService constructor param to this class under any
  // circumstance. That would recreate the forwardRef cycle the spec
  // explicitly calls out as something to avoid.
}
```

Double-check the exact import path for `WhatsAppFlowState` and `RescueRequestStatus` by reading the current top-of-file imports in `rescue-request.service.ts` before finalizing — copy them exactly, don't guess.

- [ ] **Step 2: Update `rescue-request.service.ts` and its callers**

Delete the four methods from the old file. Any remaining internal call to `markJobCompleted` (check the `CONFIRM` branch in the customer WhatsApp flow) becomes a call through an injected `PaymentEventsService`.

- [ ] **Step 3: Update `payment.service.ts`**

Change its constructor from injecting `RescueRequestService` (via `forwardRef`) to injecting `PaymentEventsService`. Check whether the `forwardRef` is still necessary — it existed because `RescueRequestModule` and `PaymentModule` needed each other; confirm whether `PaymentEventsService` living in `RescueRequestModule` still creates a cycle (it does, since `PaymentModule` still imports `RescueRequestModule` for this), so keep `forwardRef(() => PaymentEventsService)` in place, just swap the type.

- [ ] **Step 4: Move the tests**

Cut `describe('handleBalancePaymentConfirmed — payout trigger', ...)` (including the two "invites a phone-only customer..."/"tells a customer who already has..." tests added this session) from `rescue-request.service.spec.ts` into `payment-events.service.spec.ts`. Also move any `handleDepositPaymentConfirmed` tests if present. Update `TestingModule` providers to only what `PaymentEventsService` needs.

- [ ] **Step 5: Register in the module, verify**

Add `PaymentEventsService` to `rescue-request.module.ts`'s `providers` AND `exports` (external caller `payment.service.ts` needs it).

Run: `npx jest rescue-request.module --verbose` (smoke test), then `npx tsc --noEmit && npx jest`.

- [ ] **Step 6: Commit**

```bash
git add src/rescue-request/ src/payment/
git commit -m "refactor(rescue-request): extract PaymentEventsService"
```

---

### Task 4: Extract `domain/rescue-request-formatting.ts`

**Files:**
- Create: `src/rescue-request/domain/rescue-request-formatting.ts`
- Create: `src/rescue-request/domain/rescue-request-formatting.spec.ts`
- Modify: `src/rescue-request/rescue-request.service.ts`, `.spec.ts`
- Modify: `src/rescue-request/dispute.service.ts` (drop its temporary local `formatJobRef` copy from Task 2, import the real one)
- Modify: `src/rescue-request/payment-events.service.ts` if it uses any of these helpers

**Interfaces:**
- Produces: plain exported functions `formatIssueType`, `formatStatus`, `formatJobRef`, `buildMediaLinksSection` — pure, no DI. `formatLocationSection` and `reply`/`xmlOk` are handled specially, see Step 1.

- [ ] **Step 1: Extract, with two exceptions**

Locate `formatIssueType`, `formatStatus`, `formatJobRef`, `buildMediaLinksSection` — these are genuinely pure (no `this.` dependency beyond their own arguments) and move as plain functions:

```ts
import { IssueType, RescueRequestStatus } from '@prisma/client';

export function formatIssueType(issueType: IssueType): string {
  // body verbatim from rescue-request.service.ts
}

export function formatStatus(status: RescueRequestStatus): string {
  // body verbatim
}

export function formatJobRef(rescueRequestId: string): string {
  return `Job #${rescueRequestId.slice(-6).toUpperCase()}`;
}

export function buildMediaLinksSection(mediaItems: Array<{ id: string }>): string {
  // body verbatim — note it reads process.env.API_BASE_URL, still pure
  // (no `this`), just has an env-var side input, which is fine for a
  // domain function as long as it's not a NestJS-injected ConfigService.
}
```

**`formatLocationSection` does NOT move here** — it calls `this.geocodingService.reverseGeocode(...)`, a real NestJS-injected dependency. It stays as a method on whichever service still needs pickup-location formatting after Task 7 (`WhatsAppCustomerFlowService`, since that's where `handleDepositPaymentConfirmed`... wait, that moved to `PaymentEventsService` in Task 3, and `startDispatch`/`manualOfferToOperator` in `DispatchService` (Task 6) also use it). Since `formatLocationSection` is called from both `PaymentEventsService` and `DispatchService`, and it needs `GeocodingService`, it becomes a method on whichever of those is more natural, OR — simpler — stays as a small standalone `@Injectable()` wrapper. Resolve this by checking which services actually call `formatLocationSection` once Tasks 3 and 6 are done, and add it to whichever ends up calling it more, injecting into the other if needed. Flag this as a judgment call for whoever implements Task 6, not a placeholder — the two options are both valid, pick based on actual call-site count at that point.

**`reply` and `xmlOk` do NOT move here either** — they're trivial one-liners (build a TwiML string) called from every WhatsApp-facing service. Duplicate them as private one-line methods on `WhatsAppInboundService`, `WhatsAppOperatorFlowService`, and `WhatsAppCustomerFlowService` rather than creating a shared dependency for two lines of string templating — this is the one deliberate exception to "don't duplicate," justified by how trivial and stable this code is (a Twilio TwiML envelope, not business logic).

- [ ] **Step 2: Update call sites**

Everywhere `this.formatJobRef(...)` etc. was called, change to the imported function call `formatJobRef(...)` (no `this.`). This touches `dispute.service.ts` (drop its Task-2-temporary local copy), and any remaining formatting calls still in `rescue-request.service.ts` at this point.

- [ ] **Step 3: Write/move tests**

`formatIssueType`/`formatStatus`/`formatJobRef`/`buildMediaLinksSection` — write straightforward input/output tests in the new spec file (these are pure functions, trivial to test, and may not have existing dedicated tests to move — check first, write new ones if absent).

- [ ] **Step 4: Verify**

Run: `npx jest rescue-request.module --verbose`, then `npx tsc --noEmit && npx jest`.

- [ ] **Step 5: Commit**

```bash
git add src/rescue-request/
git commit -m "refactor(rescue-request): extract pure formatting helpers to domain/"
```

---

### Task 5: Extract `rescue-request-admin.service.ts`

**Files:**
- Create: `src/rescue-request/rescue-request-admin.service.ts`
- Create: `src/rescue-request/rescue-request-admin.service.spec.ts`
- Modify: `src/rescue-request/rescue-request.service.ts`, `.spec.ts`, `rescue-request.module.ts`
- Modify: `src/rescue-request/rescue-request.controller.ts`

**Interfaces:**
- Consumes: `PrismaService`, plus whatever `assignOperator`/`cancel`/etc. currently call (check for `TwilioService`, `PaystackService` usage in `assignOperator` specifically — it sends the deposit-link WhatsApp message).
- Produces: `adminList`, `assignOperator`, `updateStatus`, `cancel`, `operatorList`, `operatorDetail`, `listForUser`, `detailForUser`, `buildListResponse` (private), `mapToDetailDto` (private) — all consumed by `rescue-request.controller.ts`.

- [ ] **Step 1: Extract the ten methods verbatim**

Locate and move: `adminList`, `assignOperator`, `updateStatus`, `cancel`, `operatorList`, `operatorDetail`, `listForUser`, `detailForUser`, `buildListResponse`, `mapToDetailDto`. Read each method's body first to confirm its actual dependencies (the design doc's line range is approximate) — `assignOperator` in particular likely needs `TwilioService` and possibly `PaystackService` since it sends a deposit-payment-link message, confirm by reading it before writing the constructor.

```ts
import { Injectable, NotFoundException /* + whatever each method actually throws */ } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
// + TwilioService, PaystackService if assignOperator needs them — confirm first
import { formatStatus, formatJobRef } from './domain/rescue-request-formatting';
import type { RescueRequestDetailResponseDto, DispatchOfferAdminDto, RescueRequestListResponseDto, RescueRequestDetailDto } from './dto/rescue-request-response.dto';

@Injectable()
export class RescueRequestAdminService {
  constructor(
    private readonly prisma: PrismaService,
    // + confirmed additional deps
  ) {}

  // ten methods, bodies verbatim
}
```

- [ ] **Step 2: Update the controller**

`rescue-request.controller.ts` currently injects only `RescueRequestService`. Change to inject `RescueRequestAdminService` for the routes this task covers (`list`, `detail`, `assignOperator`, `updateStatus`, `cancel`) — `dispatchBoard`, `myOffers`, `respondToOffer`, `expandRadius`, `offerToOperator` stay pointed at whatever still has them until Task 6.

- [ ] **Step 3: Move tests, verify, commit**

Same pattern as Tasks 2–4: cut relevant describe blocks from `rescue-request.service.spec.ts` into the new spec file, adjust `TestingModule` providers to actual deps, run smoke test + full suite.

```bash
git add src/rescue-request/
git commit -m "refactor(rescue-request): extract RescueRequestAdminService"
```

---

### Task 6: Extract `dispatch.service.ts`

**Files:**
- Create: `src/rescue-request/dispatch.service.ts`
- Create: `src/rescue-request/dispatch.service.spec.ts`
- Modify: `src/rescue-request/rescue-request.service.ts`, `.spec.ts`, `rescue-request.module.ts`
- Modify: `src/rescue-request/rescue-request.controller.ts` (inject `DispatchService` for `dispatchBoard`, `myOffers`, `respondToOffer`, `expandRadius`, `offerToOperator`)

**Interfaces:**
- Consumes: `PrismaService`, `TwilioService`, `OperatorService`, `PlatformConfigService`, `WhatsAppSessionStore`, the `formatLocationSection` resolution from Task 4's Step 1 judgment call.
- Produces: `startDispatch`, `resolveBatch`, `maybeResolveBatchEarly`, `supersedeActiveRound`, `expandRadiusNow`, `manualOfferToOperator`, `sendQuoteShortlist`, `respondToOffer`, `listMyPendingOffers`, `getDispatchBoard`, `alertAdminNoOperator`, and the canonical `processQuoteOrDecline` — consumed by Task 7 (`WhatsAppOperatorFlowService`) and the controller.

This is the largest and most state-sensitive extraction — the `batchTimers`/`graceTimers` maps must remain instance fields on this one service.

- [ ] **Step 1: Extract all methods verbatim, including the timer maps**

```ts
import { Injectable } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { logger } from '@sentry/node';
import { PrismaService } from '../prisma/prisma.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { OperatorService } from '../operator/operator.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';
import { toWhatsAppAddress } from '../common/phone.util';
import { formatJobRef } from './domain/rescue-request-formatting';
// + WhatsAppFlowState, RescueRequestStatus, and any other types actually used
// — confirm exact import paths from the current file before finalizing.

@Injectable()
export class DispatchService {
  private readonly batchTimers = new Map<string, NodeJS.Timeout>();
  private readonly graceTimers = new Map<string, NodeJS.Timeout>();
  private readonly QUOTE_GRACE_MS = 5 * 60 * 1000;
  private readonly QUOTE_SELECTION_WINDOW_MS = 5 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly twilioService: TwilioService,
    private readonly operatorService: OperatorService,
    private readonly platformConfigService: PlatformConfigService,
    private readonly sessionStore: WhatsAppSessionStore,
  ) {}

  // startDispatch, resolveBatch, maybeResolveBatchEarly, supersedeActiveRound,
  // expandRadiusNow, manualOfferToOperator, sendQuoteShortlist, respondToOffer,
  // listMyPendingOffers, getDispatchBoard, alertAdminNoOperator,
  // processQuoteOrDecline (moved here from the operator-flow region per the
  // design — this is the canonical accept/decline core both channels call),
  // plus notifyPendingOperatorsOfCountdown and scheduleGraceResolve (these
  // were listed under "operator flow" in the design's Current State section
  // but are dispatch-timer machinery, not message parsing — they belong here,
  // not in WhatsAppOperatorFlowService; confirm this placement is correct by
  // checking they only touch batchTimers/graceTimers/DispatchOffer, not
  // anything operator-conversation-specific).
  //
  // All bodies verbatim. formatLocationSection also lands here if Task 4's
  // judgment call concluded DispatchService is the primary caller — if so,
  // inject GeocodingService too.
}
```

- [ ] **Step 2: Update the controller and `WhatsAppOperatorFlowService`-to-be**

`rescue-request.controller.ts`: `dispatchBoard`, `myOffers`, `respondToOffer`, `expandRadius`, `offerToOperator` routes now call `DispatchService` methods instead of `RescueRequestService`.

The operator-side WhatsApp handling still lives in the old file at this point (Task 7 hasn't run) — update its calls to `processQuoteOrDecline`/`scheduleGraceResolve`/etc. to go through an injected `DispatchService` rather than `this.`.

- [ ] **Step 3: Move tests, verify DI wiring is a real singleton**

Move the relevant describe blocks (`getDispatchBoard`, `manualOfferToOperator`, `handleOperatorQuoteOrDecline — concurrent-offer disambiguation`, `assignOperator` — no wait, `assignOperator` stays with Task 5 — `expandRadiusNow`) into `dispatch.service.spec.ts`.

Add one test specifically asserting singleton behavior:

```ts
it('registers as a singleton — two module resolutions return the same batchTimers instance', async () => {
  const moduleRef = await Test.createTestingModule({ imports: [RescueRequestModule] })
    .overrideProvider(PrismaService).useValue({})
    .compile();
  const first = moduleRef.get(DispatchService);
  const second = moduleRef.get(DispatchService);
  expect(first).toBe(second);
});
```

Run: `npx jest rescue-request.module --verbose`, then `npx tsc --noEmit && npx jest`.

- [ ] **Step 4: Commit**

```bash
git add src/rescue-request/
git commit -m "refactor(rescue-request): extract DispatchService"
```

---

### Task 7: Extract `whatsapp-operator-flow.service.ts` and `whatsapp-customer-flow.service.ts`

**Files:**
- Create: `src/rescue-request/whatsapp-operator-flow.service.ts`, `.spec.ts`
- Create: `src/rescue-request/whatsapp-customer-flow.service.ts`, `.spec.ts`
- Modify: `src/rescue-request/rescue-request.service.ts`, `.spec.ts`, `rescue-request.module.ts`

**Interfaces:**
- `WhatsAppOperatorFlowService` consumes: `PrismaService`, `TwilioService`, `DispatchService` (for `processQuoteOrDecline`), `WhatsAppSessionStore`. Produces: `handleOperatorMessage(phoneNumber, userId, message, session, operatorRecord)` — consumed by Task 8's `WhatsAppInboundService`.
- `WhatsAppCustomerFlowService` consumes: `PrismaService`, `TwilioService`, `S3Service`, `GeocodingService`, `RatingService`, `PaystackService`, `DispatchService` (to trigger dispatch after media capture), `DisputeService`, `PaymentEventsService` (for the `CONFIRM` → `markJobCompleted` path), `WhatsAppSessionStore`. Produces: `handleCustomerMessage(phoneNumber, userId, message, rawMessage, latitude, longitude, sharedAddress, session)` — consumed by Task 8. Note this is a **new method signature**, not `handleIncomingWhatsAppMessage` — the routing decision (operator vs. customer) moves to Task 8's router, so this service's entry point takes the already-routed inputs, not the raw Twilio webhook body.

Do these two together (not as separate tasks) because they're extracted from the same interleaved source region and splitting them into separate tasks would mean one temporarily calling private methods on the other via an awkward intermediate state.

- [ ] **Step 1: Extract operator-flow methods verbatim**

`handleOperatorMessage`, `handleOperatorArrived`, `handleOperatorJobDone`. (`processQuoteOrDecline`, `notifyPendingOperatorsOfCountdown`, `scheduleGraceResolve`, `handleOperatorQuoteOrDecline` already moved to `DispatchService` in Task 6 — confirm this, and if `handleOperatorQuoteOrDecline` is actually message-parsing rather than dispatch-core logic, it may belong here instead calling into `DispatchService.processQuoteOrDecline`; read its actual body before deciding, don't assume the Task 6 placement was final without checking).

```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { DispatchService } from './dispatch.service';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';
import { toWhatsAppAddress } from '../common/phone.util';

@Injectable()
export class WhatsAppOperatorFlowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly twilioService: TwilioService,
    private readonly dispatchService: DispatchService,
    private readonly sessionStore: WhatsAppSessionStore,
  ) {}

  async handleOperatorMessage(/* same signature as today */) { /* verbatim, with
    processQuoteOrDecline-related calls now going through this.dispatchService */ }

  // handleOperatorArrived, handleOperatorJobDone verbatim

  private reply(message: string): string { /* duplicated one-liner, see Task 4 Step 1 */ }
}
```

- [ ] **Step 2: Extract customer-flow methods verbatim**

`captureMediaAttachment`, `handleMediaFinished`, `initiateDeposit`, `handleRatingReply`, `handleQuoteSelected`, `isSosMessage`, `mapIssueType`, `scheduleRatingTimeout`, plus the body of the old `handleIncomingWhatsAppMessage` **minus** the operator-routing check at the top (that's Task 8's job) — everything from the SOS/location/vehicle/destination/media/dispute/rating state-machine logic becomes the new `handleCustomerMessage` entry point.

```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { S3Service } from '../integrations/s3/s3.service';
import { GeocodingService } from '../integrations/geocoding/geocoding.service';
import { RatingService } from '../rating/rating.service';
import { PaystackService } from '../integrations/paystack/paystack.service';
import { DispatchService } from './dispatch.service';
import { DisputeService } from './dispute.service';
import { PaymentEventsService } from './payment-events.service';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';

@Injectable()
export class WhatsAppCustomerFlowService {
  private readonly RATING_TIMEOUT_MS = 10 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly twilioService: TwilioService,
    private readonly s3Service: S3Service,
    private readonly geocodingService: GeocodingService,
    private readonly ratingService: RatingService,
    private readonly paystackService: PaystackService,
    private readonly dispatchService: DispatchService,
    private readonly disputeService: DisputeService,
    private readonly paymentEventsService: PaymentEventsService,
    private readonly sessionStore: WhatsAppSessionStore,
  ) {}

  async handleCustomerMessage(
    phoneNumber: string, userId: string, message: string, rawMessage: string,
    latitude: number | undefined, longitude: number | undefined,
    sharedAddress: string | undefined, session: any,
  ) {
    // Body verbatim from the old handleIncomingWhatsAppMessage, starting
    // AFTER the operator-routing check (`if (operatorRecord) { return
    // this.handleOperatorMessage(...) }` — that whole branch is gone,
    // handled by Task 8's router before this method is ever called).
    // The DISPUTE branch inside AWAITING_COMPLETION_CONFIRM now calls
    // this.disputeService.raiseDispute(...) (Task 2). The CONFIRM branch
    // calls this.paymentEventsService.markJobCompleted(...) — wait,
    // markJobCompleted was private in Task 3's extraction; make it public
    // there if this call site needs it directly, or confirm the CONFIRM
    // branch actually calls a still-public method. Verify against the
    // current source rather than assuming.
  }

  // captureMediaAttachment, handleMediaFinished, initiateDeposit,
  // handleRatingReply, handleQuoteSelected, isSosMessage, mapIssueType,
  // scheduleRatingTimeout — verbatim, with dispatch-triggering calls
  // (handleMediaFinished's transition into dispatch) going through
  // this.dispatchService.startDispatch(...).

  private reply(message: string): string { /* duplicated one-liner */ }
  private xmlOk(): string { /* duplicated one-liner */ }
}
```

- [ ] **Step 3: Move tests, verify, commit**

Split `rescue-request.service.spec.ts`'s remaining describe blocks between the two new spec files by which service each test actually exercises (operator-message tests → operator-flow spec; SOS/location/vehicle/destination/media/rating tests → customer-flow spec). Run smoke test + full suite.

```bash
git add src/rescue-request/
git commit -m "refactor(rescue-request): extract WhatsAppOperatorFlowService and WhatsAppCustomerFlowService"
```

---

### Task 8: Extract `whatsapp-inbound.service.ts`, retire the old file

**Files:**
- Create: `src/rescue-request/whatsapp-inbound.service.ts`, `.spec.ts`
- Delete: `src/rescue-request/rescue-request.service.ts`, `.spec.ts` (should be empty or near-empty by this point — confirm before deleting, don't delete if anything real remains unaccounted for)
- Modify: `src/rescue-request/rescue-request.module.ts`
- Modify: `src/webhooks/webhooks.controller.ts`

**Interfaces:**
- Consumes: `PrismaService` (for the `operator.findUnique` routing check and `findOrCreateCustomer`), `WhatsAppOperatorFlowService`, `WhatsAppCustomerFlowService`, `WhatsAppSessionStore`.
- Produces: `WhatsAppInboundService.handleIncomingWhatsAppMessage(body: Record<string, any>): Promise<string>` — consumed by `webhooks.controller.ts`, the last remaining external caller pointed at the old service.

- [ ] **Step 1: Write the router**

```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';
import { WhatsAppOperatorFlowService } from './whatsapp-operator-flow.service';
import { WhatsAppCustomerFlowService } from './whatsapp-customer-flow.service';
import { UserRole } from '@prisma/client'; // confirm exact import used for findOrCreateCustomer's role default

@Injectable()
export class WhatsAppInboundService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionStore: WhatsAppSessionStore,
    private readonly operatorFlow: WhatsAppOperatorFlowService,
    private readonly customerFlow: WhatsAppCustomerFlowService,
  ) {}

  async handleIncomingWhatsAppMessage(body: Record<string, any>): Promise<string> {
    const phoneNumber: string = String(body.From || '').replace(/^whatsapp:/i, '');
    const rawMessage = String(body.Body || '').trim();
    const message = rawMessage.toLowerCase();
    const latitude  = body.Latitude  ? Number(body.Latitude)  : undefined;
    const longitude = body.Longitude ? Number(body.Longitude) : undefined;
    const sharedAddress = body.Address ? String(body.Address).trim() : undefined;

    const user = await this.findOrCreateCustomer(phoneNumber);
    const userId = user.id;
    const session = await this.sessionStore.getOrCreate(userId);

    const operatorRecord = await this.prisma.operator.findUnique({ where: { phoneNumber } });
    if (operatorRecord) {
      return this.operatorFlow.handleOperatorMessage(phoneNumber, userId, message, session, operatorRecord);
    }

    return this.customerFlow.handleCustomerMessage(
      phoneNumber, userId, message, rawMessage, latitude, longitude, sharedAddress, session,
    );
  }

  private async findOrCreateCustomer(phoneNumber: string) {
    return this.prisma.user.upsert({
      where: { phoneNumber },
      update: {},
      create: { phoneNumber, role: UserRole.CUSTOMER },
    });
  }
}
```

Verify the exact `console.log('Incoming WhatsApp message:', ...)` line (present in the current top-of-function code) is preserved here too — it's existing observability, not to be dropped as an "unnecessary log" during the move.

- [ ] **Step 2: Update `webhooks.controller.ts`**

Change its constructor from `@Inject(forwardRef(() => RescueRequestService)) private readonly rescueRequestService: RescueRequestService` to inject `WhatsAppInboundService` instead (check whether the `forwardRef` is still needed — it may not be, since `WhatsAppInboundService` doesn't have the same circular-module relationship `RescueRequestService` did; try without `forwardRef` first, add it back only if Nest complains).

- [ ] **Step 3: Confirm the old file is empty, delete it**

At this point `rescue-request.service.ts` should contain nothing but the `@Injectable()` class wrapper and possibly `findOrCreateCustomer` if Task 8 didn't already absorb it into the router (the design says `findOrCreateCustomer` lives on a small shared service if used by ≥2 of the new services — check whether `WhatsAppInboundService` is the only remaining caller after this task; if so, keep it there as done above rather than creating a whole separate `rescue-request-shared.service.ts` for one method with one caller — YAGNI). If anything else remains, that's a sign an earlier task's extraction was incomplete — go back and finish it rather than leaving orphaned code in a file this task is supposed to delete.

Delete `rescue-request.service.ts` and `rescue-request.service.spec.ts` once confirmed empty.

- [ ] **Step 4: Update the module**

`rescue-request.module.ts`: remove `RescueRequestService` from `providers`/`exports` entirely, add `WhatsAppInboundService`, confirm every other service (`DisputeService`, `PaymentEventsService`, `RescueRequestAdminService`, `DispatchService`, `WhatsAppOperatorFlowService`, `WhatsAppCustomerFlowService`, `WhatsAppInboundService`) is registered.

- [ ] **Step 5: Full verification**

Run: `npx jest rescue-request.module --verbose` (smoke test — this is the final, most important check, since this task touches the most module wiring), then `npx tsc --noEmit && npx jest`.

Run `wc -l src/rescue-request/*.ts` and confirm no single file is anywhere near 2,541 lines — largest should be `dispatch.service.ts`, expected roughly 400-600 lines.

- [ ] **Step 6: Commit**

```bash
git add src/rescue-request/ src/webhooks/
git commit -m "refactor(rescue-request): extract WhatsAppInboundService, retire rescue-request.service.ts

Completes the decomposition — the original 2,541-line file is gone,
replaced by 8 focused services. See
docs/superpowers/specs/2026-08-18-rescue-request-service-decomposition-design.md."
```

---

## Self-Review Notes

- **Spec coverage:** all 8 files from the design's table have a task. The router's two-way tree, the `processQuoteOrDecline` canonicalization, the payment-cycle rule, and the singleton-timer requirement are each referenced explicitly in the relevant task rather than left implicit.
- **Placeholder scan:** two judgment calls are flagged explicitly rather than hidden — `formatLocationSection`'s final home (Task 4/6) and `handleOperatorQuoteOrDecline`'s placement (Task 6/7) — both because the design doc itself didn't fully pin these down and an implementer needs to check actual call sites, not because the plan is hand-waving. Each flagged spot says exactly what to check and why, not "figure it out."
- **Type/interface consistency:** `handleCustomerMessage`'s new signature (Task 7) is used consistently in Task 8's router. `DispatchService.processQuoteOrDecline` is referenced the same way in Tasks 6 and 7.
- **One deviation from the design doc worth flagging to the user before starting:** the design's Current State section still describes `notifyPendingOperatorsOfCountdown`/`scheduleGraceResolve`/`handleOperatorQuoteOrDecline` as "WhatsApp operator flow" methods, but Task 6 places them on `DispatchService` based on what they actually touch (timers, `DispatchOffer` rows) rather than the design doc's grouping. This plan flags it for implementer judgment rather than silently overriding the spec — worth confirming this reading is correct before Task 6 runs, since it's a real (small) divergence from the written design.
