# Dispute Intake & Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a dispute a real status (`IN_DISPUTE`), automatically collect a statement from both the customer and the operator when one is raised, and let staff resolve it with a note plus a settled balance amount that flows through the existing payment/payout pipeline unchanged.

**Architecture:** Extends the existing WhatsApp state machine (two new `WhatsAppFlowState` values, one new `RescueRequestStatus` value) and four new nullable fields on `RescueRequest`. No new services, no new tables — `DisputeService`, `PaymentEventsService`, and the existing WhatsApp flow services are extended in place. The admin dashboard's Requests tab gains a resolution form; a pre-existing, unrelated bug (dispute fields silently missing from the admin API responses) is fixed as a prerequisite since the new UI depends on those fields actually arriving.

**Tech Stack:** NestJS, Prisma, Jest, Next.js (lrr-web), Twilio WhatsApp.

**Spec:** `docs/superpowers/specs/2026-09-08-dispute-resolution-balance-adjustment-design.md`

## Global Constraints

- Settlement percentage is an integer 1–100 (0 is rejected — see spec's Non-goals). Validate before any DB write.
- A request's status only becomes `COMPLETED` when the (possibly settled) balance is actually paid — never at the moment staff resolve a dispute. Resolving sends the payment link; it does not change status.
- The original balance and the settled balance are both persisted — never overwrite one with the other in a way that loses the original figure.
- Each side (customer, operator) gets asked for a statement once and can reply once (or call in instead) — no open-ended threading in this pass.
- `lrr-web` has no test runner configured — its verification step is `npx tsc --noEmit` (from the `lrr-web` directory), not a test command.
- Every `lrr-service` task's verification step is `npx jest --silent` (from the `lrr-service` directory) plus `npx tsc --noEmit`.

---

### Task 1: Schema — new status, new fields, new session states

**Files:**
- Modify: `prisma/schema.prisma` (RescueRequestStatus enum, RescueRequest model)
- Modify: `src/rescue-request/state/whatsapp-session.types.ts`
- Test: none (schema-only; correctness is exercised by later tasks' tests)

**Interfaces:**
- Produces: `RescueRequestStatus.IN_DISPUTE`; `RescueRequest.customerDisputeStatement: string | null`, `RescueRequest.operatorDisputeStatement: string | null`, `RescueRequest.disputeResolutionNote: string | null`, `RescueRequest.disputeOriginalBalanceAmount: number | null`; `WhatsAppFlowState.AWAITING_DISPUTE_REASON`, `WhatsAppFlowState.AWAITING_DISPUTE_RESPONSE` — all consumed by Tasks 2–4.

- [ ] **Step 1: Add `IN_DISPUTE` to the status enum**

In `prisma/schema.prisma`, find:

```prisma
enum RescueRequestStatus {
  WAITING_FOR_LOCATION
  WAITING_FOR_ISSUE_TYPE
  WAITING_FOR_MEDIA
  WAITING_FOR_DEPOSIT
  DISPATCHING
  OPERATOR_ASSIGNED
  IN_PROGRESS
  ARRIVED
  COMPLETED
  CANCELLED
  STALLED
}
```

Replace with:

```prisma
enum RescueRequestStatus {
  WAITING_FOR_LOCATION
  WAITING_FOR_ISSUE_TYPE
  WAITING_FOR_MEDIA
  WAITING_FOR_DEPOSIT
  DISPATCHING
  OPERATOR_ASSIGNED
  IN_PROGRESS
  ARRIVED
  IN_DISPUTE
  COMPLETED
  CANCELLED
  STALLED
}
```

- [ ] **Step 2: Add the four new fields to `RescueRequest`**

Find:

```prisma
  disputed           Boolean             @default(false)
  disputeRaisedAt    DateTime?
  disputeResolvedAt  DateTime?
```

Replace with:

```prisma
  disputed           Boolean             @default(false)
  disputeRaisedAt    DateTime?
  disputeResolvedAt  DateTime?
  // Free-text statement each side sends when asked "what happened?" after a
  // dispute is raised. Each is captured once — not an open-ended thread.
  customerDisputeStatement String?
  operatorDisputeStatement String?
  // Staff's note on what was found/decided, entered alongside the settlement.
  disputeResolutionNote    String?
  // Snapshot of balanceAmount taken at resolution time, before any
  // adjustment — balanceAmount itself becomes the settled figure, so this
  // is the only place "what was originally owed" survives.
  disputeOriginalBalanceAmount Int?
```

- [ ] **Step 3: Generate and apply the migration**

Run: `npx prisma migrate dev --name in_dispute_status_and_statements`
Expected: migration file created under `prisma/migrations/`, applies cleanly against your local dev DB, `npx prisma generate` runs automatically as part of `migrate dev`.

- [ ] **Step 4: Add the two new WhatsApp session states**

In `src/rescue-request/state/whatsapp-session.types.ts`, find:

```ts
  // ── Customer completion state ────────────────────────────
  // Set on customer's session after operator marks job DONE;
  // customer must reply CONFIRM to release car + trigger balance payment
  AWAITING_COMPLETION_CONFIRM = 'AWAITING_COMPLETION_CONFIRM',
}
```

Replace with:

```ts
  // ── Customer completion state ────────────────────────────
  // Set on customer's session after operator marks job DONE;
  // customer must reply CONFIRM to release car + trigger balance payment
  AWAITING_COMPLETION_CONFIRM = 'AWAITING_COMPLETION_CONFIRM',

  // ── Dispute intake states ─────────────────────────────────
  // Set on the customer's session right after they reply DISPUTE; their
  // next message is captured as customerDisputeStatement.
  AWAITING_DISPUTE_REASON = 'AWAITING_DISPUTE_REASON',
  // Set on the operator's session when a dispute is raised on their job;
  // their next message is captured as operatorDisputeStatement.
  AWAITING_DISPUTE_RESPONSE = 'AWAITING_DISPUTE_RESPONSE',
}
```

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/rescue-request/state/whatsapp-session.types.ts
git commit -m "feat: add IN_DISPUTE status, dispute statement fields, and intake session states"
```

---

### Task 2: Dispute intake — raise, prompt both sides, capture statements

**Files:**
- Modify: `src/rescue-request/dispute.service.ts`
- Modify: `src/rescue-request/payment-events.service.ts` (one-line visibility change only — see Step 3a)
- Modify: `src/rescue-request/whatsapp-customer-flow.service.ts`
- Modify: `src/rescue-request/whatsapp-operator-flow.service.ts`
- Modify: `src/rescue-request/whatsapp-inbound.service.ts`
- Test: `src/rescue-request/dispute.service.spec.ts`, `src/rescue-request/whatsapp-customer-flow.service.spec.ts`, `src/rescue-request/whatsapp-operator-flow.service.spec.ts`

**Interfaces:**
- Consumes: `WhatsAppFlowState.AWAITING_DISPUTE_REASON`/`AWAITING_DISPUTE_RESPONSE` (Task 1), `RescueRequestStatus.IN_DISPUTE` (Task 1), `RescueRequestSharedService.findOrCreateCustomer(phoneNumber): Promise<{id: string}>` (existing), `WhatsAppSessionStore.update(userId, updates): Promise<WhatsAppSession>` (existing).
- Produces: `DisputeService.raiseDispute(rescueRequestId, customerPhoneNumber)` — same signature as today, new side effects. `WhatsAppOperatorFlowService.handleOperatorMessage(phoneNumber, userId, message, rawMessage, session, operator)` — **new 4th parameter `rawMessage: string`**, inserted before `session` — Task 3 and any other caller must use this new signature. `PaymentEventsService.sendBalancePaymentLink` becomes **public** in this task (Step 3a below) — Task 2's own `resolveDispute` rewrite (Step 3) calls it, so the visibility change has to land in the same task, before that call compiles. Task 3 does **not** repeat this change — it only broadens the `markJobCompleted` guard and fixes the auto-complete timer.

- [ ] **Step 1: Write the failing tests for `raiseDispute`'s new behavior**

Replace the entire contents of `src/rescue-request/dispute.service.spec.ts` with:

```ts
import { Test, TestingModule } from '@nestjs/testing';
import { DisputeService } from './dispute.service';
import { PrismaService } from '../prisma/prisma.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';
import { RescueRequestSharedService } from './rescue-request-shared.service';
import { PaymentEventsService } from './payment-events.service';
import { WhatsAppFlowState } from './state/whatsapp-session.types';

describe('DisputeService', () => {
  let service: DisputeService;
  let prisma: {
    rescueRequest: { findUnique: jest.Mock; update: jest.Mock };
  };
  let twilioService: { sendWhatsAppMessage: jest.Mock; sendWhatsAppTemplateMessage: jest.Mock };
  let platformConfigService: { getConfig: jest.Mock };
  let sessionStore: { update: jest.Mock };
  let sharedService: { findOrCreateCustomer: jest.Mock };
  let paymentEventsService: { sendBalancePaymentLink: jest.Mock };
  const originalTemplateSid = process.env.TWILIO_DISPUTE_TEMPLATE_SID;

  const rescueRequestId = 'req-1';
  const customerPhone = '+2348012345678';
  const operatorPhone = '+2348011112222';

  beforeEach(async () => {
    delete process.env.TWILIO_DISPUTE_TEMPLATE_SID;
    prisma = {
      rescueRequest: { findUnique: jest.fn(), update: jest.fn() },
    };
    twilioService = { sendWhatsAppMessage: jest.fn(), sendWhatsAppTemplateMessage: jest.fn() };
    platformConfigService = { getConfig: jest.fn().mockResolvedValue({ disputeAlertPhoneNumber: null }) };
    sessionStore = { update: jest.fn() };
    sharedService = { findOrCreateCustomer: jest.fn().mockResolvedValue({ id: 'op-user-1' }) };
    paymentEventsService = { sendBalancePaymentLink: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DisputeService,
        { provide: PrismaService, useValue: prisma },
        { provide: TwilioService, useValue: twilioService },
        { provide: PlatformConfigService, useValue: platformConfigService },
        { provide: WhatsAppSessionStore, useValue: sessionStore },
        { provide: RescueRequestSharedService, useValue: sharedService },
        { provide: PaymentEventsService, useValue: paymentEventsService },
      ],
    }).compile();

    service = module.get<DisputeService>(DisputeService);
  });

  afterEach(() => {
    if (originalTemplateSid === undefined) delete process.env.TWILIO_DISPUTE_TEMPLATE_SID;
    else process.env.TWILIO_DISPUTE_TEMPLATE_SID = originalTemplateSid;
  });

  describe('raiseDispute', () => {
    it('first raise: sets status IN_DISPUTE + disputed + disputeRaisedAt', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: rescueRequestId, disputed: false, disputeResolvedAt: null,
        status: 'ARRIVED', assignedOperator: { businessName: 'Swift Towing', phoneNumber: operatorPhone },
        balanceAmount: 22500, depositAmount: 2500, customer: { phoneNumber: customerPhone },
      });
      platformConfigService.getConfig.mockResolvedValue({ disputeAlertPhoneNumber: null });

      await service.raiseDispute(rescueRequestId, customerPhone);

      expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
        where: { id: rescueRequestId },
        data: { disputed: true, disputeRaisedAt: expect.any(Date), status: 'IN_DISPUTE' },
      });
    });

    it('first raise: puts the customer session into AWAITING_DISPUTE_REASON', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: rescueRequestId, disputed: false, disputeResolvedAt: null,
        status: 'ARRIVED', assignedOperator: null,
        balanceAmount: 22500, depositAmount: 2500, customer: { id: 'cust-1', phoneNumber: customerPhone },
      });

      await service.raiseDispute(rescueRequestId, customerPhone, 'cust-1');

      expect(sessionStore.update).toHaveBeenCalledWith('cust-1', {
        state: WhatsAppFlowState.AWAITING_DISPUTE_REASON,
        rescueRequestId,
      });
    });

    it('first raise: puts the operator session into AWAITING_DISPUTE_RESPONSE and asks for their side', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: rescueRequestId, disputed: false, disputeResolvedAt: null,
        status: 'ARRIVED', assignedOperator: { businessName: 'Swift Towing', phoneNumber: operatorPhone },
        balanceAmount: 22500, depositAmount: 2500, customer: { id: 'cust-1', phoneNumber: customerPhone },
      });

      await service.raiseDispute(rescueRequestId, customerPhone, 'cust-1');

      expect(sharedService.findOrCreateCustomer).toHaveBeenCalledWith(operatorPhone);
      expect(sessionStore.update).toHaveBeenCalledWith('op-user-1', {
        state: WhatsAppFlowState.AWAITING_DISPUTE_RESPONSE,
        rescueRequestId,
      });
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining(operatorPhone),
        expect.stringContaining('your side'),
      );
    });

    it('asks the customer for their side of the story, including the call-in number when configured', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: rescueRequestId, disputed: false, disputeResolvedAt: null,
        status: 'ARRIVED', assignedOperator: null,
        balanceAmount: 22500, depositAmount: 2500, customer: { id: 'cust-1', phoneNumber: customerPhone },
      });
      platformConfigService.getConfig.mockResolvedValue({ disputeAlertPhoneNumber: '+2348099999999' });

      await service.raiseDispute(rescueRequestId, customerPhone, 'cust-1');

      const customerCall = twilioService.sendWhatsAppMessage.mock.calls.find(
        ([to]) => to.includes(customerPhone),
      );
      expect(customerCall?.[1]).toContain('what happened');
      expect(customerCall?.[1]).toContain('+2348099999999');
    });

    it('first raise: warns the operator (not the customer) to withhold the vehicle', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: rescueRequestId, disputed: false, disputeResolvedAt: null,
        status: 'ARRIVED', assignedOperator: { businessName: 'Swift Towing', phoneNumber: operatorPhone },
        balanceAmount: 22500, depositAmount: 2500, customer: { id: 'cust-1', phoneNumber: customerPhone },
      });
      platformConfigService.getConfig.mockResolvedValue({ disputeAlertPhoneNumber: null });

      await service.raiseDispute(rescueRequestId, customerPhone, 'cust-1');

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining(operatorPhone),
        expect.stringContaining('Do NOT release the vehicle'),
      );
      const customerCall = twilioService.sendWhatsAppMessage.mock.calls.find(
        ([to]) => to.includes(customerPhone),
      );
      expect(customerCall?.[1]).not.toContain('vehicle');
    });

    it('repeat while unresolved: no DB write, no re-alert, distinct reply', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: rescueRequestId, disputed: true, disputeResolvedAt: null,
        status: 'IN_DISPUTE', assignedOperator: null, balanceAmount: null, depositAmount: null,
        customer: { id: 'cust-1', phoneNumber: customerPhone },
      });

      await service.raiseDispute(rescueRequestId, customerPhone, 'cust-1');

      expect(prisma.rescueRequest.update).not.toHaveBeenCalled();
      expect(sessionStore.update).not.toHaveBeenCalled();
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining(customerPhone),
        expect.stringContaining('already flagged'),
      );
    });

    it('reopen after resolution: clears disputeResolvedAt, refreshes disputeRaisedAt, status back to IN_DISPUTE, re-alerts staff', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: rescueRequestId, disputed: true, disputeResolvedAt: new Date('2026-01-01'),
        status: 'COMPLETED', assignedOperator: null, balanceAmount: null, depositAmount: null,
        customer: { id: 'cust-1', phoneNumber: customerPhone },
      });
      platformConfigService.getConfig.mockResolvedValue({ disputeAlertPhoneNumber: '+2348099999999' });

      await service.raiseDispute(rescueRequestId, customerPhone, 'cust-1');

      expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
        where: { id: rescueRequestId },
        data: { disputed: true, disputeRaisedAt: expect.any(Date), disputeResolvedAt: null, status: 'IN_DISPUTE' },
      });
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining(customerPhone),
        expect.stringContaining('reopened'),
      );
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest dispute.service.spec.ts`
Expected: FAIL — `raiseDispute` doesn't accept a third `customerUserId` argument, doesn't touch `status`, doesn't call `sessionStore`/`sharedService`, and the constructor doesn't declare those providers.

- [ ] **Step 3a: Make `sendBalancePaymentLink` public**

`resolveDispute` (written in Step 3 below) needs to call this method from `DisputeService`, a different class — it must be public first, or Step 3's code won't compile. In `src/rescue-request/payment-events.service.ts`, find:

```ts
  private async sendBalancePaymentLink(rescueRequest: any) {
```

Replace with:

```ts
  async sendBalancePaymentLink(rescueRequest: any) {
```

- [ ] **Step 3: Rewrite `raiseDispute` and its dependencies**

Replace the entire contents of `src/rescue-request/dispute.service.ts` with:

```ts
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { RescueRequestStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';
import { WhatsAppFlowState } from './state/whatsapp-session.types';
import { RescueRequestSharedService } from './rescue-request-shared.service';
import { PaymentEventsService } from './payment-events.service';
import { toWhatsAppAddress } from '../common/phone.util';
import { formatJobRef } from './domain/rescue-request-formatting';

@Injectable()
export class DisputeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly twilioService: TwilioService,
    private readonly platformConfigService: PlatformConfigService,
    private readonly sessionStore: WhatsAppSessionStore,
    private readonly sharedService: RescueRequestSharedService,
    private readonly paymentEventsService: PaymentEventsService,
  ) {}

  /**
   * Handles a customer's WhatsApp DISPUTE reply. Three explicit cases so
   * repeat messages can't corrupt state: first raise, no-op while already
   * open (prevents duplicate staff pings / disputeRaisedAt drift), and
   * reopen if the customer disputes again after resolution.
   *
   * customerUserId is optional so existing callers that don't have it handy
   * still compile; it's required in practice to put the customer's own
   * session into AWAITING_DISPUTE_REASON — without it we can still raise
   * the dispute, we just can't prompt that customer for their statement.
   */
  async raiseDispute(rescueRequestId: string, customerPhoneNumber: string, customerUserId?: string) {
    const rescueRequest = await this.prisma.rescueRequest.findUnique({
      where: { id: rescueRequestId },
      include: { customer: true, assignedOperator: true },
    });
    if (!rescueRequest) return;

    if (rescueRequest.disputed && !rescueRequest.disputeResolvedAt) {
      // Already open — no DB write, no re-alert.
      await this.twilioService.sendWhatsAppMessage(
        toWhatsAppAddress(customerPhoneNumber),
        `This request is already flagged as disputed — our team is on it.`,
      );
      return;
    }

    const isReopen = rescueRequest.disputed && !!rescueRequest.disputeResolvedAt;

    await this.prisma.rescueRequest.update({
      where: { id: rescueRequestId },
      data: isReopen
        ? { disputed: true, disputeRaisedAt: new Date(), disputeResolvedAt: null, status: RescueRequestStatus.IN_DISPUTE }
        : { disputed: true, disputeRaisedAt: new Date(), status: RescueRequestStatus.IN_DISPUTE },
    });

    const config = await this.platformConfigService.getConfig();
    const callLine = config.disputeAlertPhoneNumber
      ? ` Or call us directly: ${config.disputeAlertPhoneNumber}.`
      : '';

    await this.twilioService.sendWhatsAppMessage(
      toWhatsAppAddress(customerPhoneNumber),
      (isReopen
        ? `⚠️ Your dispute has been reopened. Our team is on it and will contact you shortly.`
        : `⚠️ Your dispute has been logged. Our team will contact you within 30 minutes.`)
        + `\n\nPlease reply with what happened, so we have your side of the story.${callLine}`,
    );

    if (customerUserId) {
      await this.sessionStore.update(customerUserId, {
        state: WhatsAppFlowState.AWAITING_DISPUTE_REASON,
        rescueRequestId,
      });
    }

    // The operator is the one physically holding the vehicle — they're the
    // one who needs to hear "don't release it," not the customer. Best-effort:
    // a failed operator notification shouldn't block the dispute itself.
    if (rescueRequest.assignedOperator?.phoneNumber) {
      try {
        const opUser = await this.sharedService.findOrCreateCustomer(rescueRequest.assignedOperator.phoneNumber);
        await this.sessionStore.update(opUser.id, {
          state: WhatsAppFlowState.AWAITING_DISPUTE_RESPONSE,
          rescueRequestId,
        });
        await this.twilioService.sendWhatsAppMessage(
          toWhatsAppAddress(rescueRequest.assignedOperator.phoneNumber),
          (isReopen
            ? `⚠️ The customer's dispute on ${formatJobRef(rescueRequestId)} has been reopened.`
            : `⚠️ The customer has disputed ${formatJobRef(rescueRequestId)}. Our team will review shortly.`)
            + `\n\nDo NOT release the vehicle until you hear from us.`
            + `\n\nPlease reply with your side of what happened.${callLine}`,
        );
      } catch (error) {
        console.error('Failed to notify operator of raised dispute:', error);
      }
    }

    await this.sendStaffDisputeAlert(rescueRequest);
  }

  /**
   * Best-effort — a failed staff alert never blocks the customer-facing
   * flow. This is always a business-initiated message (staff never texts
   * first), so on a real (non-sandbox) number it MUST go through the
   * approved `dispute_raised_alert` Content Template — a freeform body
   * gets rejected by Meta outside a session window. Falls back to a
   * freeform send only when TWILIO_DISPUTE_TEMPLATE_SID isn't configured
   * (e.g. local/sandbox testing before the template exists).
   */
  private async sendStaffDisputeAlert(rescueRequest: any) {
    try {
      const config = await this.platformConfigService.getConfig();
      if (!config.disputeAlertPhoneNumber) return;

      const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3001';
      const jobRef = formatJobRef(rescueRequest.id); // "Job #A1B2C3"
      const dashboardLink = `${frontendUrl}/requests?highlight=${rescueRequest.id}`;
      const templateSid = process.env.TWILIO_DISPUTE_TEMPLATE_SID;

      if (templateSid) {
        // Template body is "...Job {{1}}. Log in to review: {{2}} now." —
        // {{1}} needs the bare ref, "Job " is already static text in the
        // approved template itself.
        await this.twilioService.sendWhatsAppTemplateMessage(
          toWhatsAppAddress(config.disputeAlertPhoneNumber),
          templateSid,
          { '1': jobRef.replace('Job #', ''), '2': dashboardLink },
        );
      } else {
        await this.twilioService.sendWhatsAppMessage(
          toWhatsAppAddress(config.disputeAlertPhoneNumber),
          `🚨 New dispute raised — ${jobRef}\n\nLog in to view: ${dashboardLink}`,
        );
      }
    } catch (error) {
      console.error('Failed to send dispute staff alert:', error);
    }
  }

  /**
   * Marks a disputed request resolved. Idempotent: never-disputed is
   * rejected, already-resolved returns successfully with no side effects
   * (safe to retry), and the real case notifies both parties best-effort.
   *
   * resolutionNote is staff's record of what happened/was decided.
   * balanceAdjustmentPercent (1-100, default 100 = no change) settles what
   * the customer actually owes. Status is deliberately left at IN_DISPUTE —
   * it only becomes COMPLETED once the settled amount is actually paid
   * (handleBalancePaymentConfirmed), same trigger every job already uses.
   * This snapshots the pre-adjustment balance onto
   * disputeOriginalBalanceAmount before overwriting balanceAmount with the
   * settled figure, so "quoted vs. actually charged" is never lost.
   */
  async resolveDispute(
    rescueRequestId: string,
    resolutionNote: string,
    balanceAdjustmentPercent = 100,
  ): Promise<{ resolved: boolean }> {
    if (!Number.isInteger(balanceAdjustmentPercent) || balanceAdjustmentPercent < 1 || balanceAdjustmentPercent > 100) {
      throw new BadRequestException('balanceAdjustmentPercent must be an integer between 1 and 100.');
    }

    const rescueRequest = await this.prisma.rescueRequest.findUnique({
      where: { id: rescueRequestId },
      include: { customer: true, assignedOperator: true },
    });
    if (!rescueRequest) throw new NotFoundException('Rescue request not found');

    if (!rescueRequest.disputed) {
      throw new BadRequestException('This request has never been disputed.');
    }

    if (rescueRequest.disputeResolvedAt) {
      // Already resolved — safe to call again, no-op.
      return { resolved: true };
    }

    const originalBalance = rescueRequest.balanceAmount ?? 0;
    const settledBalance = Math.round(originalBalance * balanceAdjustmentPercent / 100);

    await this.prisma.rescueRequest.update({
      where: { id: rescueRequestId },
      data: {
        disputeResolvedAt: new Date(),
        disputeResolutionNote: resolutionNote,
        disputeOriginalBalanceAmount: originalBalance,
        balanceAmount: settledBalance,
      },
    });

    // Send the settlement payment link directly — resolving a dispute
    // replaces the customer's CONFIRM, it doesn't ask them to CONFIRM again.
    await this.paymentEventsService.sendBalancePaymentLink({ ...rescueRequest, balanceAmount: settledBalance });

    const jobRef = formatJobRef(rescueRequestId);
    const operatorMessage = `The dispute on ${jobRef} has been resolved. A payment link for ₦${(settledBalance / 100).toLocaleString()} has been sent to the customer.`;

    try {
      if (rescueRequest.assignedOperator?.phoneNumber) {
        await this.twilioService.sendWhatsAppMessage(toWhatsAppAddress(rescueRequest.assignedOperator.phoneNumber), operatorMessage);
      }
    } catch (error) {
      console.error('Failed to notify operator of dispute resolution:', error);
    }

    return { resolved: true };
  }
}
```

Note: the customer is **not** separately notified inside `resolveDispute` — `sendBalancePaymentLink` (called above) already sends them the payment-link message. Sending a second "resolved" message first would be confusing (two messages, one of which asks for money before the other explains why).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest dispute.service.spec.ts`
Expected: PASS — all `raiseDispute` cases green. (`resolveDispute` cases in the old spec were replaced; Task 4 adds new ones.)

- [ ] **Step 5: Add the `rawMessage` parameter to the operator flow router**

In `src/rescue-request/whatsapp-operator-flow.service.ts`, find:

```ts
  async handleOperatorMessage(
    phoneNumber: string,
    userId: string,
    message: string,
    session: Awaited<ReturnType<WhatsAppSessionStore['getOrCreate']>>,
    operator: { id: string; businessName: string; phoneNumber: string },
  ) {
    // Strip thousands separators so "100,000" parses the same as "100000" —
    // no valid operator command otherwise contains a comma.
    message = message.replace(/,/g, '');

    // ── Waiting for post-job rating (operator rates motorist) ─────────────
    // MUST come before the quote-parsing check below, which treats any bare
    // digit as a dispatch-offer price quote — without this ordering, a
    // rating reply would be silently swallowed as a bogus quote attempt.
    if (session.state === WhatsAppFlowState.WAITING_FOR_RATING) {
      return this.customerFlowService.handleRatingReply(
        userId, message, session.rescueRequestId, RatingDirection.OPERATOR_TO_MOTORIST,
      );
    }
```

Replace with:

```ts
  async handleOperatorMessage(
    phoneNumber: string,
    userId: string,
    message: string,
    rawMessage: string,
    session: Awaited<ReturnType<WhatsAppSessionStore['getOrCreate']>>,
    operator: { id: string; businessName: string; phoneNumber: string },
  ) {
    // Strip thousands separators so "100,000" parses the same as "100000" —
    // no valid operator command otherwise contains a comma.
    message = message.replace(/,/g, '');

    // ── Waiting for dispute statement (operator's side of the story) ──────
    // MUST come before every other branch below — none of them apply once
    // we've asked the operator for a free-text statement, and a numeric or
    // keyword-shaped reply here must not be mistaken for a price quote or
    // command.
    if (session.state === WhatsAppFlowState.AWAITING_DISPUTE_RESPONSE) {
      if (session.rescueRequestId) {
        await this.prisma.rescueRequest.update({
          where: { id: session.rescueRequestId },
          data: { operatorDisputeStatement: rawMessage },
        });
      }
      await this.sessionStore.update(userId, { state: WhatsAppFlowState.OPERATOR_AT_LOCATION });
      return this.reply(`Thanks — we've recorded that. Our team will be in touch.`);
    }

    // ── Waiting for post-job rating (operator rates motorist) ─────────────
    // MUST come before the quote-parsing check below, which treats any bare
    // digit as a dispatch-offer price quote — without this ordering, a
    // rating reply would be silently swallowed as a bogus quote attempt.
    if (session.state === WhatsAppFlowState.WAITING_FOR_RATING) {
      return this.customerFlowService.handleRatingReply(
        userId, message, session.rescueRequestId, RatingDirection.OPERATOR_TO_MOTORIST,
      );
    }
```

- [ ] **Step 6: Update the one call site to pass `rawMessage`**

In `src/rescue-request/whatsapp-inbound.service.ts`, find:

```ts
    if (operatorRecord) {
      logger.info('whatsapp: routed to operator flow', {
        phoneNumber, userId, message, sessionState: session.state, rescueRequestId: session.rescueRequestId,
      });
      return this.operatorFlow.handleOperatorMessage(phoneNumber, userId, message, session, operatorRecord);
    }
```

Replace with:

```ts
    if (operatorRecord) {
      logger.info('whatsapp: routed to operator flow', {
        phoneNumber, userId, message, sessionState: session.state, rescueRequestId: session.rescueRequestId,
      });
      return this.operatorFlow.handleOperatorMessage(phoneNumber, userId, message, rawMessage, session, operatorRecord);
    }
```

- [ ] **Step 7: Write the failing test for the operator statement-capture branch**

In `src/rescue-request/whatsapp-operator-flow.service.spec.ts`, find the existing `describe('WhatsAppOperatorFlowService'` block's setup (constructor providers) and add this new nested `describe` alongside the others in the file (matching whatever mock variable names that file already uses for `prisma` and `sessionStore` — check the file first; the shape below assumes the same `prisma.rescueRequest.update` and `sessionStore.update` mocks used elsewhere in that file):

```ts
  describe('AWAITING_DISPUTE_RESPONSE', () => {
    it('captures the operator\'s raw statement, reverts session state, and acknowledges', async () => {
      const session = { state: WhatsAppFlowState.AWAITING_DISPUTE_RESPONSE, rescueRequestId: 'req-1' };

      await service.handleOperatorMessage(
        '+2348011112222', 'op-user-1', 'the customer wasn\'t there when i arrived',
        'The customer wasn\'t there when I arrived.', session, { id: 'op-1', businessName: 'Swift Towing', phoneNumber: '+2348011112222' },
      );

      expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
        where: { id: 'req-1' },
        data: { operatorDisputeStatement: 'The customer wasn\'t there when I arrived.' },
      });
      expect(sessionStore.update).toHaveBeenCalledWith('op-user-1', { state: WhatsAppFlowState.OPERATOR_AT_LOCATION });
    });
  });
```

- [ ] **Step 8: Run to verify it fails, then it should already pass after Step 5**

Run: `npx jest whatsapp-operator-flow.service.spec.ts`
Expected: If Step 5/6 are done correctly, this passes immediately (no further implementation needed) — if the test file's existing mock shapes for `prisma`/`sessionStore` differ from what's assumed above, adjust the test to match those exact mock variable names rather than the implementation.

- [ ] **Step 9: Write the failing test for the customer statement-capture branch**

In `src/rescue-request/whatsapp-customer-flow.service.spec.ts`, add (matching that file's existing mock variable names for `prisma` and `sessionStore`):

```ts
  describe('AWAITING_DISPUTE_REASON', () => {
    it('captures the customer\'s raw statement, reverts to AWAITING_COMPLETION_CONFIRM, and acknowledges', async () => {
      const session = { state: WhatsAppFlowState.AWAITING_DISPUTE_REASON, rescueRequestId: 'req-1' };

      await service.handleCustomerMessage(
        '+2348012345678', 'cust-1', 'the tow took 3 hours',
        'The tow took 3 hours, way longer than promised.',
        undefined, undefined, undefined, session, {},
      );

      expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
        where: { id: 'req-1' },
        data: { customerDisputeStatement: 'The tow took 3 hours, way longer than promised.' },
      });
      expect(sessionStore.update).toHaveBeenCalledWith('cust-1', { state: WhatsAppFlowState.AWAITING_COMPLETION_CONFIRM });
    });
  });
```

- [ ] **Step 10: Add the customer-side branch**

In `src/rescue-request/whatsapp-customer-flow.service.ts`, find:

```ts
    // ── CONFIRM / DISPUTE job completion (customer side) ──────────────────
    if (session.state === WhatsAppFlowState.AWAITING_COMPLETION_CONFIRM) {
```

Insert immediately before it:

```ts
    // ── Waiting for dispute statement (customer's side of the story) ──────
    // MUST come before every other branch below, same reasoning as the
    // operator-side equivalent: whatever the customer sends next while in
    // this state is their statement, not a command.
    if (session.state === WhatsAppFlowState.AWAITING_DISPUTE_REASON) {
      if (session.rescueRequestId) {
        await this.prisma.rescueRequest.update({
          where: { id: session.rescueRequestId },
          data: { customerDisputeStatement: rawMessage },
        });
      }
      await this.sessionStore.update(userId, { state: WhatsAppFlowState.AWAITING_COMPLETION_CONFIRM });
      return this.reply(`Thanks — we've recorded that. Our team will be in touch.`);
    }

    // ── CONFIRM / DISPUTE job completion (customer side) ──────────────────
    if (session.state === WhatsAppFlowState.AWAITING_COMPLETION_CONFIRM) {
```

- [ ] **Step 11: Update the DISPUTE branch to pass the customer's userId**

Still in `whatsapp-customer-flow.service.ts`, find:

```ts
      if (message === 'dispute') {
        if (session.rescueRequestId) {
          await this.disputeService.raiseDispute(session.rescueRequestId, phoneNumber);
        }
        return this.xmlOk();
      }
```

Replace with:

```ts
      if (message === 'dispute') {
        if (session.rescueRequestId) {
          await this.disputeService.raiseDispute(session.rescueRequestId, phoneNumber, userId);
        }
        return this.xmlOk();
      }
```

- [ ] **Step 12: Run both flow spec files and the full suite**

Run: `npx jest whatsapp-customer-flow.service.spec.ts whatsapp-operator-flow.service.spec.ts dispute.service.spec.ts`
Expected: PASS, all green.

Run: `npx jest --silent`
Expected: PASS — some other spec file may reference `handleOperatorMessage` with the old 5-argument signature (e.g. a test calling it directly); if so, add the `rawMessage` argument there too (any string is fine when the state under test doesn't exercise the new branch).

- [ ] **Step 13: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 14: Commit**

```bash
git add src/rescue-request/dispute.service.ts src/rescue-request/dispute.service.spec.ts \
        src/rescue-request/whatsapp-customer-flow.service.ts src/rescue-request/whatsapp-customer-flow.service.spec.ts \
        src/rescue-request/whatsapp-operator-flow.service.ts src/rescue-request/whatsapp-operator-flow.service.spec.ts \
        src/rescue-request/whatsapp-inbound.service.ts
git commit -m "feat: capture a statement from both sides when a dispute is raised"
```

---

### Task 3: Guard `markJobCompleted` against any disputed request, and fix the unguarded auto-complete timer

**Files:**
- Modify: `src/rescue-request/payment-events.service.ts`
- Modify: `src/rescue-request/whatsapp-customer-flow.service.ts`
- Modify: `src/rescue-request/whatsapp-operator-flow.service.ts`
- Test: `src/rescue-request/payment-events.service.spec.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `PaymentEventsService.sendBalancePaymentLink` becomes **public** (was `private`) — Task 2's `resolveDispute` already calls it; this task is what makes that call valid.

**Why this task exists:** today's guard in `markJobCompleted` only blocks when `disputed && !disputeResolvedAt`. Once Task 2 lands, a customer can still be sitting in `AWAITING_COMPLETION_CONFIRM` after a dispute has been *resolved* (they haven't paid yet), and their session state doesn't distinguish "never disputed" from "disputed and resolved, awaiting the settlement payment." If they reply `CONFIRM` in that window, `markJobCompleted` must not run — the settlement payment link was already sent by `resolveDispute` with the correct (possibly adjusted) amount; running `markJobCompleted` too would send a second, different link and set status to `COMPLETED` before payment, both violating the "completed only after payment" rule. The fix: once a request has ever been disputed, `CONFIRM` never calls `markJobCompleted` again — full stop, whether resolved or not.

- [ ] **Step 1: Write the failing test**

In `src/rescue-request/payment-events.service.spec.ts`, add `findUnique: jest.fn()` to the `prisma.rescueRequest` mock object in the top-level `beforeEach` (alongside the existing `findFirst`, `update`, `updateMany`, `findUniqueOrThrow`), then add this new top-level `describe` block:

```ts
  describe('markJobCompleted', () => {
    it('blocks a request that was ever disputed, resolved or not', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1', disputed: true, disputeResolvedAt: new Date('2026-01-01'),
        balancePaid: false, customer: { phoneNumber: '+2348012345678' },
      });

      await expect(service.markJobCompleted('req-1')).rejects.toThrow('unresolved dispute');
      expect(prisma.rescueRequest.update).not.toHaveBeenCalled();
    });

    it('proceeds normally for a request that was never disputed', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1', disputed: false, disputeResolvedAt: null,
        balancePaid: false, balanceAmount: 45000, customerId: 'cust-1',
        customer: { phoneNumber: '+2348012345678', email: null },
      });
      prisma.rescueRequest.update.mockResolvedValue({});
      const paystackService = { generateReference: jest.fn().mockReturnValue('BAL-1'), initializePayment: jest.fn().mockResolvedValue({ status: true, data: { authorization_url: 'https://pay.example/1' } }) };
      (service as any).paystackService = paystackService;

      await service.markJobCompleted('req-1');

      expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
        where: { id: 'req-1' },
        data: { status: 'COMPLETED' },
      });
    });
  });
```

- [ ] **Step 2: Run to verify the first assertion fails**

Run: `npx jest payment-events.service.spec.ts -t markJobCompleted`
Expected: The "blocks a request that was ever disputed, resolved or not" case FAILS — today's guard only throws when `!disputeResolvedAt`, so a resolved dispute passes through and the update **is** called, contradicting the assertion.

- [ ] **Step 3: Broaden the guard**

In `src/rescue-request/payment-events.service.ts`, find:

```ts
    // A request under active dispute must not proceed to the balance
    // payment / payout stage — staff have to resolve it first (see
    // DisputeService.resolveDispute). Without this guard, the admin
    // "mark completed" shortcut (and a customer replying CONFIRM after
    // DISPUTE, since the session state doesn't change on dispute) both
    // bypass the WhatsApp CONFIRM/DISPUTE fork entirely.
    if (rescueRequest.disputed && !rescueRequest.disputeResolvedAt) {
      throw new BadRequestException('This request has an unresolved dispute — resolve it before marking the job completed.');
    }
```

Replace with:

```ts
    // Once a request has ever been disputed, markJobCompleted is
    // permanently the wrong path for it — DisputeService.resolveDispute
    // sends its own (possibly adjusted) settlement payment link directly,
    // and status only becomes COMPLETED once that's actually paid
    // (handleBalancePaymentConfirmed). Blocking here regardless of
    // disputeResolvedAt stops a customer's CONFIRM (still possible while
    // their session sits in AWAITING_COMPLETION_CONFIRM) from sending a
    // second, wrong-amount payment link or completing the job before
    // payment — both the admin "mark completed" shortcut and a same-message
    // CONFIRM/DISPUTE race were the two ways this used to be bypassed.
    if (rescueRequest.disputed) {
      throw new BadRequestException('This request has an unresolved dispute — resolve it before marking the job completed.');
    }
```

- [ ] **Step 4: Run to verify both new tests pass**

Run: `npx jest payment-events.service.spec.ts -t markJobCompleted`
Expected: PASS. (`sendBalancePaymentLink`'s visibility was already made public in Task 2, Step 3a — nothing to change here.)

- [ ] **Step 5: Update the CONFIRM catch-block message in the customer flow**

The generic "still under dispute review" message is now shown even when the dispute is resolved and the customer just hasn't paid yet, which is misleading. In `src/rescue-request/whatsapp-customer-flow.service.ts`, find:

```ts
          } catch (err) {
            // Typically: a DISPUTE was raised on this same request just
            // before this CONFIRM — session state doesn't change on
            // dispute, so both replies reach here. Session stays put so a
            // later CONFIRM (after staff resolve it) can still go through.
            if (err instanceof BadRequestException) {
              return this.reply(`This request is still under dispute review — our team will follow up before you can confirm completion.`);
            }
            throw err;
          }
```

Replace with:

```ts
          } catch (err) {
            // Typically: this request was disputed. Fetch current dispute
            // state to phrase the reply correctly — "still under review" if
            // unresolved, or "check the payment link we already sent" if
            // staff have already resolved it (resolveDispute sends its own
            // settlement link; this CONFIRM must not send a second one).
            if (err instanceof BadRequestException) {
              const current = await this.prisma.rescueRequest.findUnique({
                where: { id: session.rescueRequestId! },
                select: { disputeResolvedAt: true },
              });
              return this.reply(
                current?.disputeResolvedAt
                  ? `Your dispute has been resolved — please use the payment link we already sent to complete payment.`
                  : `This request is still under dispute review — our team will follow up before you can confirm completion.`,
              );
            }
            throw err;
          }
```

- [ ] **Step 6: Fix the unguarded 30-minute auto-complete timer**

In `src/rescue-request/whatsapp-operator-flow.service.ts`, find:

```ts
    // Auto-complete after 30 minutes if customer doesn't respond
    setTimeout(async () => {
      const fresh = await this.prisma.rescueRequest.findUnique({
        where: { id: rescueRequestId },
        select: { status: true },
      });
      if (fresh && fresh.status !== RescueRequestStatus.COMPLETED && fresh.status !== RescueRequestStatus.CANCELLED) {
        console.log(`⏱ Auto-completing request ${rescueRequestId} — customer did not confirm in 30 min`);
        await this.paymentEventsService.markJobCompleted(rescueRequestId);
        await this.sessionStore.update(customerId, { state: WhatsAppFlowState.IDLE, rescueRequestId: undefined });
      }
    }, 30 * 60 * 1000);
```

Replace with:

```ts
    // Auto-complete after 30 minutes if customer doesn't respond. Skips
    // disputed requests entirely — markJobCompleted now throws for any
    // disputed request (see Task 3 guard), and this callback has no caller
    // to catch that: an unguarded call would surface as an unhandled
    // promise rejection instead of the clear error it is everywhere else.
    setTimeout(async () => {
      const fresh = await this.prisma.rescueRequest.findUnique({
        where: { id: rescueRequestId },
        select: { status: true, disputed: true },
      });
      if (fresh && fresh.disputed) {
        console.log(`⏱ Skipping auto-complete for ${rescueRequestId} — request is disputed`);
        return;
      }
      if (fresh && fresh.status !== RescueRequestStatus.COMPLETED && fresh.status !== RescueRequestStatus.CANCELLED) {
        console.log(`⏱ Auto-completing request ${rescueRequestId} — customer did not confirm in 30 min`);
        await this.paymentEventsService.markJobCompleted(rescueRequestId);
        await this.sessionStore.update(customerId, { state: WhatsAppFlowState.IDLE, rescueRequestId: undefined });
      }
    }, 30 * 60 * 1000);
```

- [ ] **Step 7: Run the full suite and type-check**

Run: `npx jest --silent`
Expected: PASS.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/rescue-request/payment-events.service.ts src/rescue-request/payment-events.service.spec.ts \
        src/rescue-request/whatsapp-customer-flow.service.ts src/rescue-request/whatsapp-operator-flow.service.ts
git commit -m "fix: block any disputed request from markJobCompleted, not just unresolved ones"
```

---

### Task 4: Resolution wiring — DTO, controller, and `resolveDispute` tests

**Files:**
- Create: `src/rescue-request/dto/resolve-dispute.dto.ts`
- Modify: `src/rescue-request/rescue-request.controller.ts`
- Test: `src/rescue-request/dispute.service.spec.ts` (add `resolveDispute` cases), `src/rescue-request/rescue-request.controller.spec.ts` (if it exists — check first)

**Interfaces:**
- Consumes: `DisputeService.resolveDispute(rescueRequestId, resolutionNote, balanceAdjustmentPercent?)` (Task 2).
- Produces: `ResolveDisputeDto { resolutionNote: string; balanceAdjustmentPercent?: number }` — consumed by Task 6's frontend hook as the PATCH body shape.

- [ ] **Step 1: Write the failing `resolveDispute` tests**

Add to `src/rescue-request/dispute.service.spec.ts`, inside a new `describe('resolveDispute', ...)` block (after the `raiseDispute` block, before the closing brace of the outer `describe`):

```ts
  describe('resolveDispute', () => {
    it('rejects when the request was never disputed', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({ id: rescueRequestId, disputed: false, disputeResolvedAt: null });

      await expect(service.resolveDispute(rescueRequestId, 'looked into it')).rejects.toThrow('never been disputed');
      expect(prisma.rescueRequest.update).not.toHaveBeenCalled();
    });

    it('rejects an out-of-range or non-integer percent without touching the DB', async () => {
      await expect(service.resolveDispute(rescueRequestId, 'note', 0)).rejects.toThrow('between 1 and 100');
      await expect(service.resolveDispute(rescueRequestId, 'note', 101)).rejects.toThrow('between 1 and 100');
      await expect(service.resolveDispute(rescueRequestId, 'note', 50.5)).rejects.toThrow('between 1 and 100');
      expect(prisma.rescueRequest.findUnique).not.toHaveBeenCalled();
    });

    it('is a no-op when already resolved — no DB write, no payment link, no re-notification', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: rescueRequestId, disputed: true, disputeResolvedAt: new Date('2026-01-01'),
        customer: { phoneNumber: customerPhone }, assignedOperator: null,
      });

      const result = await service.resolveDispute(rescueRequestId, 'note');

      expect(result).toEqual({ resolved: true });
      expect(prisma.rescueRequest.update).not.toHaveBeenCalled();
      expect(paymentEventsService.sendBalancePaymentLink).not.toHaveBeenCalled();
      expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalled();
    });

    it('resolves with no adjustment: settled balance equals the original, snapshot still written', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: rescueRequestId, disputed: true, disputeResolvedAt: null, balanceAmount: 45000,
        customer: { phoneNumber: customerPhone }, assignedOperator: { phoneNumber: operatorPhone },
      });
      prisma.rescueRequest.update.mockResolvedValue({});

      await service.resolveDispute(rescueRequestId, 'operator was right, no change');

      expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
        where: { id: rescueRequestId },
        data: {
          disputeResolvedAt: expect.any(Date),
          disputeResolutionNote: 'operator was right, no change',
          disputeOriginalBalanceAmount: 45000,
          balanceAmount: 45000,
        },
      });
      expect(paymentEventsService.sendBalancePaymentLink).toHaveBeenCalledWith(
        expect.objectContaining({ balanceAmount: 45000 }),
      );
    });

    it('resolves with a 60% adjustment: settled balance is 60% of the original, both amounts stored', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: rescueRequestId, disputed: true, disputeResolvedAt: null, balanceAmount: 45000,
        customer: { phoneNumber: customerPhone }, assignedOperator: { phoneNumber: operatorPhone },
      });
      prisma.rescueRequest.update.mockResolvedValue({});

      await service.resolveDispute(rescueRequestId, 'tow took too long, 60% agreed', 60);

      expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
        where: { id: rescueRequestId },
        data: {
          disputeResolvedAt: expect.any(Date),
          disputeResolutionNote: 'tow took too long, 60% agreed',
          disputeOriginalBalanceAmount: 45000,
          balanceAmount: 27000,
        },
      });
      expect(paymentEventsService.sendBalancePaymentLink).toHaveBeenCalledWith(
        expect.objectContaining({ balanceAmount: 27000 }),
      );
    });

    it('notifies the operator that the settlement link was sent, best-effort on Twilio failure', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: rescueRequestId, disputed: true, disputeResolvedAt: null, balanceAmount: 45000,
        customer: { phoneNumber: customerPhone }, assignedOperator: { phoneNumber: operatorPhone },
      });
      prisma.rescueRequest.update.mockResolvedValue({});
      twilioService.sendWhatsAppMessage.mockRejectedValueOnce(new Error('Twilio down'));

      await expect(service.resolveDispute(rescueRequestId, 'note')).resolves.toEqual({ resolved: true });

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining(operatorPhone),
        expect.stringContaining('resolved'),
      );
    });
  });
```

- [ ] **Step 2: Run to verify these pass**

Run: `npx jest dispute.service.spec.ts`
Expected: PASS — `resolveDispute` was already fully rewritten in Task 2 Step 3, so this task is verification, not new implementation, unless the exact assertions above reveal a mismatch (e.g. rounding) — fix `resolveDispute` if so, not the test.

- [ ] **Step 3: Create the DTO**

Create `src/rescue-request/dto/resolve-dispute.dto.ts`:

```ts
import { IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';

export class ResolveDisputeDto {
  /** Staff's record of what happened and why the settlement was decided. */
  @IsString()
  @MinLength(1)
  resolutionNote: string;

  /** 1-100. Omit (or 100) for "no change" — the customer pays the original balance. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  balanceAdjustmentPercent?: number;
}
```

- [ ] **Step 4: Wire the controller**

In `src/rescue-request/rescue-request.controller.ts`, find:

```ts
  /** Mark a disputed request resolved. Idempotent — safe to call more than once. */
  @Patch(':id/resolve-dispute')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async resolveDispute(@Param('id') id: string) {
    return this.disputeService.resolveDispute(id);
  }
}
```

Replace with:

```ts
  /** Mark a disputed request resolved. Idempotent — safe to call more than once. */
  @Patch(':id/resolve-dispute')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async resolveDispute(@Param('id') id: string, @Body() dto: ResolveDisputeDto) {
    return this.disputeService.resolveDispute(id, dto.resolutionNote, dto.balanceAdjustmentPercent);
  }
}
```

Add the import near the top of the file, alongside the other DTO imports:

```ts
import { ResolveDisputeDto } from './dto/resolve-dispute.dto';
```

- [ ] **Step 5: Run the full backend suite and type-check**

Run: `npx jest --silent`
Expected: PASS.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/rescue-request/dto/resolve-dispute.dto.ts src/rescue-request/rescue-request.controller.ts src/rescue-request/dispute.service.spec.ts
git commit -m "feat: accept a resolution note and settlement percentage on resolve-dispute"
```

---

### Task 5: Expose dispute fields on the admin API (fixes a pre-existing gap + adds the new fields)

**Files:**
- Modify: `src/rescue-request/dto/rescue-request-response.dto.ts`
- Modify: `src/rescue-request/rescue-request-admin.service.ts`
- Test: `src/rescue-request/rescue-request-admin.service.spec.ts` (check if it exists and covers `list`/`mapToDetailDto` first; add cases there if so, otherwise add a focused new spec file as described in Step 4)

**Interfaces:**
- Produces: `RescueRequestListItemDto` and `RescueRequestDetailDto` both gain `disputed: boolean`, `disputeRaisedAt: Date | null`, `disputeResolvedAt: Date | null`, `customerDisputeStatement: string | null`, `operatorDisputeStatement: string | null`, `disputeResolutionNote: string | null`, `disputeOriginalBalanceAmount: number | null` — consumed by Task 6 (frontend types) and Task 7 (UI).

**Why this task exists:** `disputed`/`disputeRaisedAt`/`disputeResolvedAt` already exist on the Prisma model and are already declared on the frontend's `RescueRequestListItem` type (confirmed by reading `lrr-web/app/types.ts`), but the admin service's hand-built DTO mapping never copies them from the Prisma row into the response — they're silently dropped before the frontend ever sees them. This means the "Disputed" badge in the admin Requests tab has likely never actually rendered in production. This task fixes that alongside adding the four new fields from this feature, since it's the same mapping code.

- [ ] **Step 1: Add the fields to both response DTOs**

In `src/rescue-request/dto/rescue-request-response.dto.ts`, find:

```ts
export class RescueRequestListItemDto {
  id: string;
  status: RescueRequestStatus;
  issueType?: IssueType;
  latitude?: number;
  longitude?: number;
  depositPaid: boolean;
  balancePaid: boolean;
  depositRefundStatus: 'NONE' | 'ELIGIBLE' | 'PENDING' | 'COMPLETED' | 'FAILED';
  customer: CustomerSummaryDto;
  assignedOperator?: OperatorSummaryDto;
  createdAt: Date;
  updatedAt: Date;
}
```

Replace with:

```ts
export class RescueRequestListItemDto {
  id: string;
  status: RescueRequestStatus;
  issueType?: IssueType;
  latitude?: number;
  longitude?: number;
  depositPaid: boolean;
  balancePaid: boolean;
  depositRefundStatus: 'NONE' | 'ELIGIBLE' | 'PENDING' | 'COMPLETED' | 'FAILED';
  customer: CustomerSummaryDto;
  assignedOperator?: OperatorSummaryDto;
  disputed: boolean;
  disputeRaisedAt?: Date;
  disputeResolvedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}
```

Find:

```ts
export class RescueRequestDetailDto {
  id: string;
  status: RescueRequestStatus;
  issueType?: IssueType;
  vehicleType?: VehicleType;
  destination?: string;
  mediaLinks: string[];
  latitude?: number;
  longitude?: number;
  depositPaid: boolean;
  depositAmount?: number;
  depositReference?: string;
  balancePaid: boolean;
  balanceAmount?: number;
  balanceReference?: string;
  customer: CustomerDetailDto;
  assignedOperator?: OperatorDetailDto;
  createdAt: Date;
  updatedAt: Date;
  offers?: DispatchOfferAdminDto[];
}
```

Replace with:

```ts
export class RescueRequestDetailDto {
  id: string;
  status: RescueRequestStatus;
  issueType?: IssueType;
  vehicleType?: VehicleType;
  destination?: string;
  mediaLinks: string[];
  latitude?: number;
  longitude?: number;
  depositPaid: boolean;
  depositAmount?: number;
  depositReference?: string;
  balancePaid: boolean;
  balanceAmount?: number;
  balanceReference?: string;
  customer: CustomerDetailDto;
  assignedOperator?: OperatorDetailDto;
  disputed: boolean;
  disputeRaisedAt?: Date;
  disputeResolvedAt?: Date;
  customerDisputeStatement?: string;
  operatorDisputeStatement?: string;
  disputeResolutionNote?: string;
  disputeOriginalBalanceAmount?: number;
  createdAt: Date;
  updatedAt: Date;
  offers?: DispatchOfferAdminDto[];
}
```

- [ ] **Step 2: Copy the fields through in `list()`**

In `src/rescue-request/rescue-request-admin.service.ts`, find:

```ts
    const data: RescueRequestListItemDto[] = rawData.map((item) => ({
      id:        item.id,
      status:    item.status,
      issueType: item.issueType ?? undefined,
      latitude:  item.latitude  ? Number(item.latitude)  : undefined,
      longitude: item.longitude ? Number(item.longitude) : undefined,
      depositPaid: item.depositPaid,
      balancePaid: item.balancePaid,
      depositRefundStatus: item.depositRefundStatus,
      customer: { id: item.customer.id, phoneNumber: item.customer.phoneNumber! },
      assignedOperator: item.assignedOperator
        ? { id: item.assignedOperator.id, businessName: item.assignedOperator.businessName }
        : undefined,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    }));
```

Replace with:

```ts
    const data: RescueRequestListItemDto[] = rawData.map((item) => ({
      id:        item.id,
      status:    item.status,
      issueType: item.issueType ?? undefined,
      latitude:  item.latitude  ? Number(item.latitude)  : undefined,
      longitude: item.longitude ? Number(item.longitude) : undefined,
      depositPaid: item.depositPaid,
      balancePaid: item.balancePaid,
      depositRefundStatus: item.depositRefundStatus,
      customer: { id: item.customer.id, phoneNumber: item.customer.phoneNumber! },
      assignedOperator: item.assignedOperator
        ? { id: item.assignedOperator.id, businessName: item.assignedOperator.businessName }
        : undefined,
      disputed: item.disputed,
      disputeRaisedAt: item.disputeRaisedAt ?? undefined,
      disputeResolvedAt: item.disputeResolvedAt ?? undefined,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    }));
```

- [ ] **Step 3: Copy the fields through in `mapToDetailDto()`**

Find:

```ts
      assignedOperator: raw.assignedOperator
        ? {
            id:           raw.assignedOperator.id,
            businessName: raw.assignedOperator.businessName,
            phoneNumber:  raw.assignedOperator.phoneNumber,
            email:        raw.assignedOperator.email,
          }
        : undefined,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      offers,
    };
  }
}
```

Replace with:

```ts
      assignedOperator: raw.assignedOperator
        ? {
            id:           raw.assignedOperator.id,
            businessName: raw.assignedOperator.businessName,
            phoneNumber:  raw.assignedOperator.phoneNumber,
            email:        raw.assignedOperator.email,
          }
        : undefined,
      disputed: raw.disputed,
      disputeRaisedAt: raw.disputeRaisedAt ?? undefined,
      disputeResolvedAt: raw.disputeResolvedAt ?? undefined,
      customerDisputeStatement: raw.customerDisputeStatement ?? undefined,
      operatorDisputeStatement: raw.operatorDisputeStatement ?? undefined,
      disputeResolutionNote: raw.disputeResolutionNote ?? undefined,
      disputeOriginalBalanceAmount: raw.disputeOriginalBalanceAmount ?? undefined,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      offers,
    };
  }
}
```

- [ ] **Step 4: Write a regression test proving the fields survive mapping**

First check whether `src/rescue-request/rescue-request-admin.service.spec.ts` exists:

Run: `ls src/rescue-request/rescue-request-admin.service.spec.ts`

**If it exists:** open it, find its `describe('list'` (or equivalent) block, and add a case matching its existing mock conventions that asserts a `rawData` item with `disputed: true, disputeRaisedAt: <date>, disputeResolvedAt: null` produces a `data[0]` entry with those same three fields set — not dropped.

**If it does not exist:** create `src/rescue-request/rescue-request-admin.service.spec.ts` with a minimal focused test (adjust the constructor's other providers to empty-object stubs if the class requires more than shown — check the class's actual constructor signature first with `grep -n "constructor" src/rescue-request/rescue-request-admin.service.ts`):

```ts
import { Test, TestingModule } from '@nestjs/testing';
import { RescueRequestAdminService } from './rescue-request-admin.service';
import { PrismaService } from '../prisma/prisma.service';

describe('RescueRequestAdminService — dispute field mapping', () => {
  let service: RescueRequestAdminService;
  let prisma: { rescueRequest: { findMany: jest.Mock; count: jest.Mock } };

  beforeEach(async () => {
    prisma = {
      rescueRequest: { findMany: jest.fn(), count: jest.fn().mockResolvedValue(1) },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RescueRequestAdminService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get<RescueRequestAdminService>(RescueRequestAdminService);
  });

  it('list() does not drop dispute fields from the response', async () => {
    prisma.rescueRequest.findMany.mockResolvedValue([{
      id: 'req-1', status: 'IN_DISPUTE', issueType: null, latitude: null, longitude: null,
      depositPaid: true, balancePaid: false, depositRefundStatus: 'NONE',
      customer: { id: 'cust-1', phoneNumber: '+2348012345678' },
      assignedOperator: null,
      disputed: true, disputeRaisedAt: new Date('2026-01-01'), disputeResolvedAt: null,
      createdAt: new Date(), updatedAt: new Date(),
    }]);

    const result = await service.list({});

    expect(result.data[0].disputed).toBe(true);
    expect(result.data[0].disputeRaisedAt).toEqual(new Date('2026-01-01'));
    expect(result.data[0].disputeResolvedAt).toBeUndefined();
  });
});
```

If the constructor needs more providers than `PrismaService`, run `grep -n "constructor" -A 15 src/rescue-request/rescue-request-admin.service.ts` first and add empty-object (`{}`) stubs for each — this test only exercises `list()`'s mapping, so no other provider's methods need real behavior.

- [ ] **Step 5: Run to verify it fails, then implement (Steps 1-3 above are the implementation — if written first, this step just confirms)**

Run: `npx jest rescue-request-admin.service.spec.ts`
Expected: PASS once Steps 1-3 are in place.

- [ ] **Step 6: Run the full suite and type-check**

Run: `npx jest --silent`
Expected: PASS.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/rescue-request/dto/rescue-request-response.dto.ts src/rescue-request/rescue-request-admin.service.ts src/rescue-request/rescue-request-admin.service.spec.ts
git commit -m "fix: stop dropping dispute fields from admin list/detail responses; add new statement/note fields"
```

---

### Task 6: Frontend types and API hook

**Files:**
- Modify: `lrr-web/app/types.ts`
- Modify: `lrr-web/app/hooks/useRescueRequestApi.ts`

**Interfaces:**
- Consumes: the DTO shape from Task 5 and Task 4.
- Produces: `resolveDispute(id: string, resolutionNote: string, balanceAdjustmentPercent?: number): Promise<{ resolved: boolean }>` — consumed by Task 7's UI.

- [ ] **Step 1: Extend the frontend types**

In `lrr-web/app/types.ts`, find:

```ts
  disputed: boolean;
  disputeRaisedAt: string | null;
  disputeResolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
```

Replace with:

```ts
  disputed: boolean;
  disputeRaisedAt: string | null;
  disputeResolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DisputeDetails {
  customerDisputeStatement?: string;
  operatorDisputeStatement?: string;
  disputeResolutionNote?: string;
  disputeOriginalBalanceAmount?: number;
}
```

Find:

```ts
export interface RescueRequestDetail extends RescueRequestListItem {
  description?: string;
  adminNotes?: string;
  vehicleType?: string;
  destination?: string;
  mediaLinks: string[];
  offers?: DispatchOfferAdmin[];
  depositAmount?: number;
  balanceAmount?: number;
  timeline?: {
    status: RescueRequestStatus;
    timestamp: string;
    updatedBy?: string;
  }[];
}
```

Replace with:

```ts
export interface RescueRequestDetail extends RescueRequestListItem, DisputeDetails {
  description?: string;
  adminNotes?: string;
  vehicleType?: string;
  destination?: string;
  mediaLinks: string[];
  offers?: DispatchOfferAdmin[];
  depositAmount?: number;
  balanceAmount?: number;
  timeline?: {
    status: RescueRequestStatus;
    timestamp: string;
    updatedBy?: string;
  }[];
}
```

- [ ] **Step 2: Update the `resolveDispute` hook**

In `lrr-web/app/hooks/useRescueRequestApi.ts`, find:

```ts
  const resolveDispute = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/rescue-requests/${id}/resolve-dispute`, {
        method: "PATCH",
      });
      await fetchList();
      return res;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to resolve dispute";
      setError(msg);
      throw err;
    } finally {
      setLoading(false);
    }
```

Replace with:

```ts
  const resolveDispute = useCallback(async (id: string, resolutionNote: string, balanceAdjustmentPercent?: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/rescue-requests/${id}/resolve-dispute`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolutionNote, balanceAdjustmentPercent }),
      });
      await fetchList();
      return res;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to resolve dispute";
      setError(msg);
      throw err;
    } finally {
      setLoading(false);
    }
```

- [ ] **Step 3: Type-check**

Run (from `lrr-web/`): `npx tsc --noEmit`
Expected: errors at this point are expected and fine — `RescueRequestsTabAdmin.tsx` still calls `resolveDispute(selectedRequest.id)` with the old one-argument signature; Task 7 fixes that call site. If any *other* file errors, fix those now.

- [ ] **Step 4: Commit**

```bash
git add app/types.ts app/hooks/useRescueRequestApi.ts
git commit -m "feat: add dispute statement/note fields and resolutionNote param to the frontend"
```

---

### Task 7: Admin UI — In Dispute status, statements display, resolution form

**Files:**
- Modify: `lrr-web/app/components/tabs/RescueRequestsTabAdmin.tsx`

**Interfaces:**
- Consumes: `RescueRequestDetail`/`DisputeDetails` (Task 6), `resolveDispute(id, resolutionNote, balanceAdjustmentPercent?)` (Task 6).

- [ ] **Step 1: Add the `IN_DISPUTE` status color**

Find:

```ts
const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  PENDING: { bg: "#fff3cd", text: "#856404" },
  WAITING_FOR_DEPOSIT: { bg: "#cfe2ff", text: "#084298" },
  OPERATOR_ASSIGNED: { bg: "#d1ecf1", text: "#0c5460" },
  IN_PROGRESS: { bg: "#cce5ff", text: "#004085" },
  ARRIVED: { bg: "#d4edda", text: "#155724" },
  COMPLETED: { bg: "#d4edda", text: "#155724" },
  CANCELLED: { bg: "#f8d7da", text: "#721c24" },
  STALLED: { bg: "#fff3cd", text: "#856404" },
  DISPATCHING: { bg: "#e2e3e5", text: "#383d41" },
};
```

Replace with:

```ts
const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  PENDING: { bg: "#fff3cd", text: "#856404" },
  WAITING_FOR_DEPOSIT: { bg: "#cfe2ff", text: "#084298" },
  OPERATOR_ASSIGNED: { bg: "#d1ecf1", text: "#0c5460" },
  IN_PROGRESS: { bg: "#cce5ff", text: "#004085" },
  ARRIVED: { bg: "#d4edda", text: "#155724" },
  IN_DISPUTE: { bg: "#f8d7da", text: "#721c24" },
  COMPLETED: { bg: "#d4edda", text: "#155724" },
  CANCELLED: { bg: "#f8d7da", text: "#721c24" },
  STALLED: { bg: "#fff3cd", text: "#856404" },
  DISPATCHING: { bg: "#e2e3e5", text: "#383d41" },
};
```

- [ ] **Step 2: Add resolution-form state**

Find:

```ts
  const [disputeToast, setDisputeToast] = useState<string | null>(null);
```

Replace with:

```ts
  const [disputeToast, setDisputeToast] = useState<string | null>(null);
  const [resolutionNote, setResolutionNote] = useState("");
  const [settlementPercent, setSettlementPercent] = useState("");
```

- [ ] **Step 3: Rewrite `handleResolveDispute`**

Find:

```ts
  const handleResolveDispute = async () => {
    if (!selectedRequest) return;
    setActionLoading(true);
    try {
      await resolveDispute(selectedRequest.id);
      setActionMsg({ text: "Dispute resolved ✓", ok: true });
      setSelectedRequest(prev => prev ? { ...prev, disputeResolvedAt: new Date().toISOString() } : null);
    } catch (e: unknown) {
      setActionMsg({ text: e instanceof Error ? e.message : "Failed to resolve dispute", ok: false });
    } finally { setActionLoading(false); }
  };
```

Replace with:

```ts
  const handleResolveDispute = async () => {
    if (!selectedRequest || !resolutionNote.trim()) return;
    setActionLoading(true);
    try {
      const percent = settlementPercent.trim() ? Number(settlementPercent) : undefined;
      await resolveDispute(selectedRequest.id, resolutionNote.trim(), percent);
      setActionMsg({ text: "Dispute resolved — settlement payment link sent ✓", ok: true });
      setSelectedRequest(prev => prev ? { ...prev, disputeResolvedAt: new Date().toISOString() } : null);
      setResolutionNote("");
      setSettlementPercent("");
    } catch (e: unknown) {
      setActionMsg({ text: e instanceof Error ? e.message : "Failed to resolve dispute", ok: false });
    } finally { setActionLoading(false); }
  };
```

- [ ] **Step 4: Reset the form fields when the modal opens on a different request**

Find:

```ts
  const openModal = useCallback((req: RescueRequestListItem) => {
    setSelectedRequest(req);
    setSelectedDetail(null);
    setSelectedOperatorId(req.assignedOperator?.id ?? "");
    setActionMsg(null);
```

Replace with:

```ts
  const openModal = useCallback((req: RescueRequestListItem) => {
    setSelectedRequest(req);
    setSelectedDetail(null);
    setSelectedOperatorId(req.assignedOperator?.id ?? "");
    setActionMsg(null);
    setResolutionNote("");
    setSettlementPercent("");
```

- [ ] **Step 5: Add the statements display and replace the resolve button with the form**

Find:

```ts
                    {selectedRequest.disputed && !selectedRequest.disputeResolvedAt && (
                      <button onClick={handleResolveDispute} disabled={actionLoading}
                        style={{ padding: "0.55rem 1.1rem", background: "#07152f", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600, fontSize: "0.88rem", display: "inline-flex", alignItems: "center", gap: 6 }}>
                        <CheckCircle2 size={14} /> Resolve Dispute
                      </button>
                    )}
                  </div>
                </div>
              )}
```

Replace with:

```ts
                  </div>
                </div>
              )}

              {selectedRequest.disputed && (
                <div style={{ marginTop: "1.25rem", padding: "1.25rem", background: "#fdf6f6", borderRadius: 10, border: "1px solid #f5c2c2" }}>
                  <h3 style={{ margin: "0 0 0.75rem", fontSize: "0.95rem", color: "#721c24" }}>Dispute</h3>
                  <div style={{ display: "grid", gap: "0.6rem", marginBottom: "1rem" }}>
                    <div>
                      <p style={{ margin: 0, fontSize: "0.78rem", color: "#999", fontWeight: 600, textTransform: "uppercase" }}>Customer said</p>
                      <p style={{ margin: "2px 0 0 0", fontSize: "0.9rem", color: "#333" }}>{selectedDetail?.customerDisputeStatement || "No response yet"}</p>
                    </div>
                    <div>
                      <p style={{ margin: 0, fontSize: "0.78rem", color: "#999", fontWeight: 600, textTransform: "uppercase" }}>Operator said</p>
                      <p style={{ margin: "2px 0 0 0", fontSize: "0.9rem", color: "#333" }}>{selectedDetail?.operatorDisputeStatement || "No response yet"}</p>
                    </div>
                  </div>

                  {selectedRequest.disputeResolvedAt ? (
                    <div>
                      <p style={{ margin: 0, fontSize: "0.78rem", color: "#999", fontWeight: 600, textTransform: "uppercase" }}>Resolution</p>
                      <p style={{ margin: "2px 0 0 0", fontSize: "0.9rem", color: "#333" }}>{selectedDetail?.disputeResolutionNote}</p>
                      {selectedDetail?.disputeOriginalBalanceAmount !== undefined && (
                        <p style={{ margin: "4px 0 0 0", fontSize: "0.85rem", color: "#666" }}>
                          Original balance ₦{(selectedDetail.disputeOriginalBalanceAmount / 100).toLocaleString()} → settled ₦{((selectedDetail.balanceAmount ?? 0) / 100).toLocaleString()}
                        </p>
                      )}
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
                      <textarea
                        placeholder="What happened, and what was decided?"
                        value={resolutionNote}
                        onChange={(e) => setResolutionNote(e.target.value)}
                        rows={3}
                        style={{ padding: "0.6rem", borderRadius: 6, border: "1px solid #dde8f8", fontSize: "0.88rem", fontFamily: "inherit", resize: "vertical" }}
                      />
                      <div style={{ display: "flex", gap: "0.6rem", alignItems: "center" }}>
                        <input
                          type="number"
                          min={1}
                          max={100}
                          placeholder="100"
                          value={settlementPercent}
                          onChange={(e) => setSettlementPercent(e.target.value)}
                          style={{ width: 80, padding: "0.5rem", borderRadius: 6, border: "1px solid #dde8f8", fontSize: "0.88rem" }}
                        />
                        <span style={{ fontSize: "0.85rem", color: "#666" }}>% of the original balance (blank = 100%, no change)</span>
                      </div>
                      <button onClick={handleResolveDispute} disabled={actionLoading || !resolutionNote.trim()}
                        style={{ alignSelf: "flex-start", padding: "0.55rem 1.1rem", background: "#07152f", color: "#fff", border: "none", borderRadius: 6, cursor: actionLoading || !resolutionNote.trim() ? "not-allowed" : "pointer", fontWeight: 600, fontSize: "0.88rem", display: "inline-flex", alignItems: "center", gap: 6 }}>
                        <CheckCircle2 size={14} /> Resolve & Send Payment Link
                      </button>
                    </div>
                  )}
                </div>
              )}
```

- [ ] **Step 6: Type-check**

Run (from `lrr-web/`): `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Manual verification**

Per this repo's conventions, `lrr-web` has no test runner — verify by running the dev server and clicking through: open a request with `disputed: true` and no `disputeResolvedAt`, confirm the note/percent form renders and the button is disabled until a note is typed; open one with `disputeResolvedAt` set, confirm the resolution summary (note + both amounts) renders instead.

- [ ] **Step 8: Commit**

```bash
git add app/components/tabs/RescueRequestsTabAdmin.tsx
git commit -m "feat: add In Dispute status styling, statement display, and resolution form to the admin Requests tab"
```

---

## Self-Review Notes

- **Spec coverage:** IN_DISPUTE status (Task 1, 2), both-sides statement capture with call-in fallback (Task 2), one resolution action with note + settlement percent (Task 4, 7), status stays IN_DISPUTE until payment (Task 3's broadened guard + Task 2's `resolveDispute` never touching status), both original and settled balance stored (Task 2), dispute history visible after Completed (Task 5's DTO fix + Task 7's always-visible dispute block), 1–100 validation (Task 4's DTO + Task 2's service-level check as defense in depth), admin dashboard location — no separate page (Task 7 extends the existing tab). All spec sections have a task.
- **Type consistency:** `resolveDispute(rescueRequestId, resolutionNote, balanceAdjustmentPercent?)` — same order and names used in `DisputeService` (Task 2), `ResolveDisputeDto`/controller (Task 4), the frontend hook and UI (Tasks 6, 7). `sendBalancePaymentLink`'s private→public change was originally drafted under Task 3, but Task 2's own `resolveDispute` rewrite calls it — that would have made Task 2 uncompilable until Task 3 ran. Fixed during self-review: the visibility change now lives in Task 2 (Step 3a, immediately before the code that needs it), and Task 3 no longer touches it. Tasks are now correctly self-contained in numeric order — no cross-task ordering dependency remains.
- **Placeholder scan:** none found — every step has literal code, exact file content, or a concrete shell command.
