# Dispute Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist dispute state on `RescueRequest`, alert a configurable staff WhatsApp number when one's raised, and surface red/green dispute status plus a resolve action in the admin dashboard.

**Architecture:** Two boolean/timestamp fields on `RescueRequest` (`disputed`, `disputeRaisedAt`, `disputeResolvedAt`) drive a three-state UI (normal / red-unresolved / green-resolved) with no new table. The existing WhatsApp `DISPUTE` handler and a new admin-only resolve endpoint both live in `rescue-request.service.ts`, reusing already-injected `TwilioService`/`PlatformConfigService`. The dashboard gets a new polling loop (none exists in this file today) to detect fresh disputes and toast them.

**Tech Stack:** NestJS + Prisma (lrr-service), Next.js + inline-style React (lrr-web). No new dependencies.

## Global Constraints

- Dispute state is orthogonal to `RescueRequestStatus` — flags on `RescueRequest`, not a new status value or table (per spec).
- `disputeAlertPhoneNumber` on `PlatformConfig` is optional/nullable; missing means the staff alert step is skipped, never an error.
- All three raise-branches (first raise / repeat-while-unresolved / reopen-after-resolved) and all three resolve-branches (never-disputed / already-resolved / real-resolve) must be handled explicitly — see spec `docs/superpowers/specs/2026-08-18-dispute-handling-design.md`.
- WhatsApp sends (staff alert on raise, both notifications on resolve) are best-effort: log-and-continue on failure, never throw back to the caller.
- Resolve endpoint is admin-only: `@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)`, same pattern as `rescue-request.controller.ts`'s other admin mutations.
- Resolution message wording is deliberately non-instructive (no "you may proceed") per spec.

---

### Task 1: Schema — dispute fields + config field

**Files:**
- Modify: `prisma/schema.prisma` (`RescueRequest` model, lines 179-218; `PlatformConfig` model, lines 220-231)
- Create: a new Prisma migration (via CLI, not hand-written)

**Interfaces:**
- Produces: `RescueRequest.disputed: boolean`, `RescueRequest.disputeRaisedAt: Date | null`, `RescueRequest.disputeResolvedAt: Date | null`, `PlatformConfig.disputeAlertPhoneNumber: string | null` — consumed by Tasks 2-6.

- [ ] **Step 1: Add the three dispute fields to `RescueRequest`**

In `prisma/schema.prisma`, inside `model RescueRequest { ... }`, add after the `balanceReference` line (around line 200):

```prisma
  disputed           Boolean             @default(false)
  disputeRaisedAt    DateTime?
  disputeResolvedAt  DateTime?
```

- [ ] **Step 2: Add `disputeAlertPhoneNumber` to `PlatformConfig`**

In `model PlatformConfig { ... }`, add after `dispatchWindowMinutes`:

```prisma
  // WhatsApp number staff disputes are alerted to. Optional — unset means
  // the staff alert step is skipped, not an error.
  disputeAlertPhoneNumber String?
```

- [ ] **Step 3: Generate and apply the migration**

Run: `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION=yes npx prisma migrate dev --name add_dispute_fields`

Expected: a new migration folder under `prisma/migrations/`, "Your database is now in sync with your schema."

- [ ] **Step 4: Regenerate the Prisma client**

Run: `npx prisma generate`

Expected: "Generated Prisma Client" with no errors.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(schema): add dispute fields to RescueRequest and PlatformConfig"
```

---

### Task 2: Backend — `PlatformConfig` support for `disputeAlertPhoneNumber`

**Files:**
- Modify: `src/platform-config/dto/update-platform-config.dto.ts`
- Modify: `src/platform-config/platform-config.service.ts`
- Test: `src/platform-config/platform-config.service.spec.ts` (create if it doesn't exist — check first)

**Interfaces:**
- Consumes: Task 1's `PlatformConfig.disputeAlertPhoneNumber` field.
- Produces: `PlatformConfigValues.disputeAlertPhoneNumber: string | null`, readable via `platformConfigService.getConfig()` — consumed by Task 3 (staff alert) and the frontend Task 5.

- [ ] **Step 1: Check for an existing spec file**

Run: `ls src/platform-config/platform-config.service.spec.ts 2>&1`

If it doesn't exist, Step 2 creates it fresh; if it does, add to it.

- [ ] **Step 2: Write the failing test**

In `src/platform-config/platform-config.service.spec.ts`:

```ts
import { Test, TestingModule } from '@nestjs/testing';
import { PlatformConfigService } from './platform-config.service';
import { PrismaService } from '../prisma/prisma.service';

describe('PlatformConfigService', () => {
  let service: PlatformConfigService;
  let prisma: { platformConfig: { findFirst: jest.Mock; update: jest.Mock } };

  beforeEach(async () => {
    prisma = {
      platformConfig: { findFirst: jest.fn(), update: jest.fn() },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlatformConfigService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get<PlatformConfigService>(PlatformConfigService);
  });

  describe('getConfig', () => {
    it('includes disputeAlertPhoneNumber, null when unset', async () => {
      prisma.platformConfig.findFirst.mockResolvedValue({
        id: 'cfg-1',
        serviceFeePercent: { toNumber: () => 10 },
        depositPercent: { toNumber: () => 10 },
        dispatchWindowMinutes: 10,
        disputeAlertPhoneNumber: null,
      });

      const result = await service.getConfig();

      expect(result.disputeAlertPhoneNumber).toBeNull();
    });
  });

  describe('updateConfig', () => {
    it('persists a new disputeAlertPhoneNumber', async () => {
      prisma.platformConfig.findFirst.mockResolvedValue({ id: 'cfg-1' });
      prisma.platformConfig.update.mockResolvedValue({
        id: 'cfg-1',
        serviceFeePercent: { toNumber: () => 10 },
        depositPercent: { toNumber: () => 10 },
        dispatchWindowMinutes: 10,
        disputeAlertPhoneNumber: '+2348012345678',
      });

      const result = await service.updateConfig({ disputeAlertPhoneNumber: '+2348012345678' });

      expect(prisma.platformConfig.update).toHaveBeenCalledWith({
        where: { id: 'cfg-1' },
        data: { disputeAlertPhoneNumber: '+2348012345678' },
      });
      expect(result.disputeAlertPhoneNumber).toBe('+2348012345678');
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest platform-config.service -v`
Expected: FAIL — `disputeAlertPhoneNumber` doesn't exist on the DTO/service yet.

- [ ] **Step 4: Add the field to the DTO**

In `src/platform-config/dto/update-platform-config.dto.ts`, add `IsString` to the existing `class-validator` import and add the field:

```ts
import { IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
```

```ts
  @IsString()
  @IsOptional()
  disputeAlertPhoneNumber?: string;
```

- [ ] **Step 5: Update the service**

In `src/platform-config/platform-config.service.ts`:

Widen the `PlatformConfigValues` interface:
```ts
export interface PlatformConfigValues {
  serviceFeePercent: number;
  depositPercent: number;
  dispatchWindowMinutes: number;
  disputeAlertPhoneNumber: string | null;
}
```

In `getConfig()`, add to the returned object:
```ts
      disputeAlertPhoneNumber: row!.disputeAlertPhoneNumber,
```

In `updateConfig()`, widen the `data` object's type (it's currently `Record<string, number>`, which can't hold a string field) and add the assignment:
```ts
    const data: Record<string, number | string> = {};
    if (dto.serviceFeePercent !== undefined) data.serviceFeePercent = dto.serviceFeePercent;
    if (dto.depositPercent !== undefined) data.depositPercent = dto.depositPercent;
    if (dto.dispatchWindowMinutes !== undefined) data.dispatchWindowMinutes = dto.dispatchWindowMinutes;
    if (dto.disputeAlertPhoneNumber !== undefined) data.disputeAlertPhoneNumber = dto.disputeAlertPhoneNumber;
```

And in the final returned object:
```ts
      disputeAlertPhoneNumber: updated.disputeAlertPhoneNumber,
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx jest platform-config.service -v`
Expected: PASS.

- [ ] **Step 7: Run full backend suite and typecheck**

Run: `npx tsc --noEmit && npx jest`
Expected: no type errors, all suites pass.

- [ ] **Step 8: Commit**

```bash
git add src/platform-config/
git commit -m "feat(platform-config): add disputeAlertPhoneNumber field"
```

---

### Task 3: Backend — raising a dispute (three-branch, idempotent, staff alert)

**Files:**
- Modify: `src/rescue-request/rescue-request.service.ts` (the `DISPUTE` branch, currently lines 149-157, inside `handleIncomingWhatsAppMessage`)
- Test: `src/rescue-request/rescue-request.service.spec.ts`

**Interfaces:**
- Consumes: `this.platformConfigService.getConfig()` (Task 2), `this.twilioService.sendWhatsAppMessage(to, message)`, `this.prisma.rescueRequest.update/findUnique`, `toWhatsAppAddress` from `../common/phone.util`, `this.formatJobRef(id)`.
- Produces: a private helper `raiseDispute(rescueRequestId, customerPhoneNumber)` — consumed by nothing else in this plan, but named so Task 4 (resolve) can follow the same file-region convention.

- [ ] **Step 1: Write the failing tests**

In `src/rescue-request/rescue-request.service.spec.ts`, find the existing `describe` block(s) covering `handleIncomingWhatsAppMessage`'s `AWAITING_COMPLETION_CONFIRM` state (search for `'dispute'` — the current dead-stub test, if any, needs updating too). Add:

```ts
describe('DISPUTE handling', () => {
  const rescueRequestId = 'req-1';
  const customerPhone = '+2348012345678';

  beforeEach(() => {
    (sessionStore.getOrCreate as jest.Mock).mockResolvedValue({
      userId: 'user-1',
      state: 'AWAITING_COMPLETION_CONFIRM',
      rescueRequestId,
    });
    (prisma.operator.findUnique as jest.Mock).mockResolvedValue(null);
  });

  it('first raise: sets disputed + disputeRaisedAt, sends customer ack, alerts staff when configured', async () => {
    prisma.rescueRequest.findUnique.mockResolvedValue({
      id: rescueRequestId, disputed: false, disputeResolvedAt: null,
      status: 'ARRIVED', assignedOperator: { businessName: 'Swift Towing' },
      balanceAmount: 22500, depositAmount: 2500, customer: { phoneNumber: customerPhone },
    });
    platformConfigService.getConfig.mockResolvedValue({ disputeAlertPhoneNumber: '+2348099999999' });

    await service.handleIncomingWhatsAppMessage({ From: `whatsapp:${customerPhone}`, Body: 'dispute' });

    expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
      where: { id: rescueRequestId },
      data: { disputed: true, disputeRaisedAt: expect.any(Date) },
    });
    expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
      expect.stringContaining(customerPhone),
      expect.stringContaining('dispute'),
    );
    expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
      'whatsapp:+2348099999999',
      expect.stringContaining('Swift Towing'),
    );
  });

  it('skips the staff alert cleanly when disputeAlertPhoneNumber is unset', async () => {
    prisma.rescueRequest.findUnique.mockResolvedValue({
      id: rescueRequestId, disputed: false, disputeResolvedAt: null,
      status: 'ARRIVED', assignedOperator: null, balanceAmount: 22500, depositAmount: null,
      customer: { phoneNumber: customerPhone },
    });
    platformConfigService.getConfig.mockResolvedValue({ disputeAlertPhoneNumber: null });

    await service.handleIncomingWhatsAppMessage({ From: `whatsapp:${customerPhone}`, Body: 'dispute' });

    expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledTimes(1); // customer ack only
  });

  it('repeat while unresolved: no DB write, no re-alert, distinct reply', async () => {
    prisma.rescueRequest.findUnique.mockResolvedValue({
      id: rescueRequestId, disputed: true, disputeResolvedAt: null,
      status: 'ARRIVED', assignedOperator: null, balanceAmount: null, depositAmount: null,
      customer: { phoneNumber: customerPhone },
    });

    await service.handleIncomingWhatsAppMessage({ From: `whatsapp:${customerPhone}`, Body: 'dispute' });

    expect(prisma.rescueRequest.update).not.toHaveBeenCalled();
    expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
      expect.stringContaining(customerPhone),
      expect.stringContaining('already flagged'),
    );
  });

  it('reopen after resolution: clears disputeResolvedAt, refreshes disputeRaisedAt, re-alerts staff', async () => {
    prisma.rescueRequest.findUnique.mockResolvedValue({
      id: rescueRequestId, disputed: true, disputeResolvedAt: new Date('2026-01-01'),
      status: 'ARRIVED', assignedOperator: null, balanceAmount: null, depositAmount: null,
      customer: { phoneNumber: customerPhone },
    });
    platformConfigService.getConfig.mockResolvedValue({ disputeAlertPhoneNumber: '+2348099999999' });

    await service.handleIncomingWhatsAppMessage({ From: `whatsapp:${customerPhone}`, Body: 'dispute' });

    expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
      where: { id: rescueRequestId },
      data: { disputed: true, disputeRaisedAt: expect.any(Date), disputeResolvedAt: null },
    });
    expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
      expect.stringContaining(customerPhone),
      expect.stringContaining('reopened'),
    );
  });
});
```

Adjust the mock shapes above to whatever the existing spec file's `beforeEach` already sets up for `prisma`, `twilioService`, `platformConfigService`, `sessionStore` — this file has ~10 separate `TestingModule` blocks per earlier session work; add this `describe` inside whichever block already provides `handleIncomingWhatsAppMessage`'s dependencies (`prisma.rescueRequest.findUnique/update`, `twilioService.sendWhatsAppMessage`, `platformConfigService.getConfig`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest rescue-request.service -t "DISPUTE handling" -v`
Expected: FAIL — current code doesn't distinguish these cases.

- [ ] **Step 3: Implement — replace the DISPUTE branch**

In `src/rescue-request/rescue-request.service.ts`, replace lines 149-157:

```ts
      if (message === 'dispute') {
        // Notify admin and hold the request — do not auto-complete
        await this.alertAdminNoOperator(session.rescueRequestId ?? '', 0, 0, -1); // reuse alert channel
        await this.twilioService.sendWhatsAppMessage(
          phoneNumber,
          `⚠️ Your dispute has been logged. Our team will contact you within 30 minutes.\n\nDo NOT release the vehicle until you hear from us.`,
        );
        return this.xmlOk();
      }
```

with:

```ts
      if (message === 'dispute') {
        if (session.rescueRequestId) {
          await this.raiseDispute(session.rescueRequestId, phoneNumber);
        }
        return this.xmlOk();
      }
```

Then add the new private method — a good spot is right before `alertAdminNoOperator` (search for that method name; it stays, unused by this path now, for its original zero-candidates use case):

```ts
  /**
   * Handles a customer's WhatsApp DISPUTE reply. Three explicit cases so
   * repeat messages can't corrupt state: first raise, no-op while already
   * open (prevents duplicate staff pings / disputeRaisedAt drift), and
   * reopen if the customer disputes again after resolution.
   */
  private async raiseDispute(rescueRequestId: string, customerPhoneNumber: string) {
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
        ? { disputed: true, disputeRaisedAt: new Date(), disputeResolvedAt: null }
        : { disputed: true, disputeRaisedAt: new Date() },
    });

    await this.twilioService.sendWhatsAppMessage(
      toWhatsAppAddress(customerPhoneNumber),
      isReopen
        ? `⚠️ Your dispute has been reopened. Our team is on it.\n\nDo NOT release the vehicle until you hear from us.`
        : `⚠️ Your dispute has been logged. Our team will contact you within 30 minutes.\n\nDo NOT release the vehicle until you hear from us.`,
    );

    await this.sendStaffDisputeAlert(rescueRequest);
  }

  /** Best-effort — a failed staff alert never blocks the customer-facing flow. */
  private async sendStaffDisputeAlert(rescueRequest: any) {
    try {
      const config = await this.platformConfigService.getConfig();
      if (!config.disputeAlertPhoneNumber) return;

      const amount = rescueRequest.balanceAmount ?? rescueRequest.depositAmount;
      const amountLine = amount ? `\nAmount: ₦${(amount / 100).toLocaleString()}` : '';
      const operatorLine = rescueRequest.assignedOperator
        ? `\nOperator: ${rescueRequest.assignedOperator.businessName}`
        : '';
      const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3001';

      await this.twilioService.sendWhatsAppMessage(
        toWhatsAppAddress(config.disputeAlertPhoneNumber),
        `🚨 *Dispute raised* — ${this.formatJobRef(rescueRequest.id)}\n\nStatus: ${rescueRequest.status}${operatorLine}${amountLine}\n\n${frontendUrl}/requests?highlight=${rescueRequest.id}`,
      );
    } catch (error) {
      console.error('Failed to send dispute staff alert:', error);
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest rescue-request.service -t "DISPUTE handling" -v`
Expected: PASS.

- [ ] **Step 5: Run full backend suite and typecheck**

Run: `npx tsc --noEmit && npx jest`
Expected: no type errors, all suites pass (including any pre-existing dispute-related test that needs its assertions updated to match the new branching — fix any such test rather than deleting it).

- [ ] **Step 6: Commit**

```bash
git add src/rescue-request/rescue-request.service.ts src/rescue-request/rescue-request.service.spec.ts
git commit -m "feat(dispute): persist dispute state, alert staff, handle repeat/reopen idempotently"
```

---

### Task 4: Backend — resolve-dispute endpoint (idempotent, notifies both parties)

**Files:**
- Modify: `src/rescue-request/rescue-request.controller.ts`
- Modify: `src/rescue-request/rescue-request.service.ts`
- Test: `src/rescue-request/rescue-request.service.spec.ts`, `src/rescue-request/rescue-request.controller.spec.ts` (if it exists — check first)

**Interfaces:**
- Consumes: `this.prisma.rescueRequest.findUnique/update`, `this.twilioService.sendWhatsAppMessage`, `this.formatJobRef`, `toWhatsAppAddress`.
- Produces: `RescueRequestService.resolveDispute(rescueRequestId: string): Promise<{ resolved: boolean }>`, route `PATCH /rescue-requests/:id/resolve-dispute` — consumed by Task 6 (frontend).

- [ ] **Step 1: Write the failing tests**

In `src/rescue-request/rescue-request.service.spec.ts`, in the same/adjacent describe block as Task 3:

```ts
describe('resolveDispute', () => {
  const rescueRequestId = 'req-1';

  it('rejects when the request was never disputed', async () => {
    prisma.rescueRequest.findUnique.mockResolvedValue({ id: rescueRequestId, disputed: false, disputeResolvedAt: null });

    await expect(service.resolveDispute(rescueRequestId)).rejects.toThrow('never been disputed');
    expect(prisma.rescueRequest.update).not.toHaveBeenCalled();
  });

  it('is a no-op when already resolved — no DB write, no re-notification', async () => {
    prisma.rescueRequest.findUnique.mockResolvedValue({
      id: rescueRequestId, disputed: true, disputeResolvedAt: new Date('2026-01-01'),
      customer: { phoneNumber: '+2348012345678' }, assignedOperator: null,
    });

    const result = await service.resolveDispute(rescueRequestId);

    expect(result).toEqual({ resolved: true });
    expect(prisma.rescueRequest.update).not.toHaveBeenCalled();
    expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it('resolves, notifies customer and assigned operator, best-effort on Twilio failure', async () => {
    prisma.rescueRequest.findUnique.mockResolvedValue({
      id: rescueRequestId, disputed: true, disputeResolvedAt: null,
      customer: { phoneNumber: '+2348012345678' },
      assignedOperator: { phoneNumber: '+2348099999999' },
    });
    prisma.rescueRequest.update.mockResolvedValue({});
    twilioService.sendWhatsAppMessage.mockRejectedValueOnce(new Error('Twilio down'));

    const result = await expect(service.resolveDispute(rescueRequestId)).resolves.toEqual({ resolved: true });

    expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
      where: { id: rescueRequestId },
      data: { disputeResolvedAt: expect.any(Date) },
    });
    expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledTimes(2); // customer + operator, even though first rejected
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest rescue-request.service -t resolveDispute -v`
Expected: FAIL — `resolveDispute` doesn't exist yet.

- [ ] **Step 3: Implement `resolveDispute`**

Add to `rescue-request.service.ts`, near `raiseDispute`:

```ts
  async resolveDispute(rescueRequestId: string): Promise<{ resolved: boolean }> {
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

    await this.prisma.rescueRequest.update({
      where: { id: rescueRequestId },
      data: { disputeResolvedAt: new Date() },
    });

    const jobRef = this.formatJobRef(rescueRequestId);
    const message = `The dispute on request ${jobRef} has been marked as resolved. Our team has completed the dispute review.`;

    try {
      if (rescueRequest.customer?.phoneNumber) {
        await this.twilioService.sendWhatsAppMessage(toWhatsAppAddress(rescueRequest.customer.phoneNumber), message);
      }
    } catch (error) {
      console.error('Failed to notify customer of dispute resolution:', error);
    }

    try {
      if (rescueRequest.assignedOperator?.phoneNumber) {
        await this.twilioService.sendWhatsAppMessage(toWhatsAppAddress(rescueRequest.assignedOperator.phoneNumber), message);
      }
    } catch (error) {
      console.error('Failed to notify operator of dispute resolution:', error);
    }

    return { resolved: true };
  }
```

Check the top of the file for existing imports of `NotFoundException`/`BadRequestException` from `@nestjs/common` — add them to the existing import line if not already present.

- [ ] **Step 4: Add the controller route**

In `src/rescue-request/rescue-request.controller.ts`, add after the `cancel` method (before the closing `}` of the class):

```ts
  /** Mark a disputed request resolved. Idempotent — safe to call more than once. */
  @Patch(':id/resolve-dispute')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async resolveDispute(@Param('id') id: string) {
    return this.rescueRequestService.resolveDispute(id);
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest rescue-request.service -t resolveDispute -v`
Expected: PASS.

- [ ] **Step 6: Run full backend suite and typecheck**

Run: `npx tsc --noEmit && npx jest`
Expected: no type errors, all suites pass.

- [ ] **Step 7: Commit**

```bash
git add src/rescue-request/rescue-request.controller.ts src/rescue-request/rescue-request.service.ts src/rescue-request/rescue-request.service.spec.ts
git commit -m "feat(dispute): add idempotent resolve-dispute endpoint, notifies both parties"
```

---

### Task 5: Frontend — Platform Settings field for `disputeAlertPhoneNumber`

**Files:**
- Modify: `app/hooks/useSettingsApi.ts`
- Modify: `app/components/tabs/PlatformSettingsTab.tsx`

**Interfaces:**
- Consumes: `GET`/`PATCH /admin/settings` (Task 2, already returns/accepts `disputeAlertPhoneNumber`).
- Produces: nothing consumed elsewhere in this plan — standalone settings UI.

- [ ] **Step 1: Add the field to the `PlatformSettings` interface**

In `app/hooks/useSettingsApi.ts`, update the interface (lines 4-8):

```ts
export interface PlatformSettings {
  serviceFeePercent: number;
  depositPercent: number;
  dispatchWindowMinutes: number;
  disputeAlertPhoneNumber: string | null;
}
```

No other change needed in this file — `fetchSettings`/`updateSettings` are generic over the interface.

- [ ] **Step 2: Add the form field**

In `app/components/tabs/PlatformSettingsTab.tsx`:

Add state (mirror line 10):
```ts
  const [disputeAlertPhoneNumber, setDisputeAlertPhoneNumber] = useState("");
```

Sync in the settings-loaded `useEffect` (mirror line 22):
```ts
      setDisputeAlertPhoneNumber(settings.disputeAlertPhoneNumber ?? "");
```

Include in the save payload (mirror line 32, inside `updateSettings({...})`):
```ts
      disputeAlertPhoneNumber: disputeAlertPhoneNumber || null,
```

Add the input block after the `dispatchWindowMinutes` block (mirror lines 73-89):
```tsx
        <div>
          <label style={{ display: "block", fontSize: "0.95rem", fontWeight: 600, marginBottom: 8 }}>
            Dispute alert number
          </label>
          <input
            type="tel"
            placeholder="e.g. +2348012345678"
            value={disputeAlertPhoneNumber}
            onChange={(e) => setDisputeAlertPhoneNumber(e.target.value)}
            style={{ width: "100%", padding: "0.75rem", border: "1.5px solid #dde8f8", borderRadius: 8 }}
          />
          <p style={{ margin: "6px 0 0", fontSize: "0.82rem", color: "#8892a6" }}>
            WhatsApp number alerted the moment a customer raises a dispute. Leave blank to disable staff alerts.
          </p>
        </div>
```

- [ ] **Step 3: Verify**

Run: `rm -rf .next && npx tsc --noEmit && npm run build`
Expected: clean typecheck and build.

- [ ] **Step 4: Manual click-through**

Start the dev server (`npm run dev`), log in as SUPER_ADMIN, open Platform Settings, confirm the new field loads (blank if unset), enter a number, save, reload, confirm it persisted.

- [ ] **Step 5: Commit**

```bash
git add app/hooks/useSettingsApi.ts app/components/tabs/PlatformSettingsTab.tsx
git commit -m "feat(settings): add dispute alert phone number field"
```

---

### Task 6: Frontend — dashboard badge, resolve button, polling toast

**Files:**
- Modify: `app/types.ts` (`RescueRequestListItem`)
- Modify: `app/hooks/useRescueRequestApi.ts`
- Modify: `app/components/tabs/RescueRequestsTabAdmin.tsx`

**Interfaces:**
- Consumes: Task 4's `PATCH /rescue-requests/:id/resolve-dispute`.
- Produces: nothing consumed elsewhere — this is the final task.

- [ ] **Step 1: Add dispute fields to the list item type**

In `app/types.ts`, add to `RescueRequestListItem` (lines 138-150):

```ts
  disputed: boolean;
  disputeRaisedAt: string | null;
  disputeResolvedAt: string | null;
```

- [ ] **Step 2: Add `resolveDispute` to the hook**

In `app/hooks/useRescueRequestApi.ts`, add a function mirroring `cancelRequest` (lines 152-170):

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
  }, [fetchList]);
```

Add `resolveDispute` to the hook's returned object (find the "Write" section, alongside `cancelRequest`, `updateStatus`, `assignOperator`).

- [ ] **Step 3: Add the badge, button, and polling toast to the tab**

In `app/components/tabs/RescueRequestsTabAdmin.tsx`:

Import the new action from the hook where `fetchList`/other actions are destructured, and add local state near the top of the component (alongside existing `actionMsg` state around line 35):

```ts
  const [disputeToast, setDisputeToast] = useState<string | null>(null);
  const knownUnresolvedDisputes = useRef<Set<string>>(new Set());
  const isFirstPoll = useRef(true);
```

Replace the mount-only `useEffect` (lines 101-103) with a polling version — 15s interval, matching the pattern used in `DispatchBoardTab.tsx`:

```ts
  useEffect(() => {
    fetchList({ page: 1, limit: 20 });
    const interval = setInterval(() => fetchList({ page: 1, limit: 20 }), 15_000);
    return () => clearInterval(interval);
  }, [fetchList]);
```

Add a second effect that reacts to `requests` changing, to detect newly-unresolved disputes — transition into `disputed && !disputeResolvedAt`, not "disputed now vs. before" (a reopen never flips `disputed` back to `false`, so that framing would miss it):

```ts
  useEffect(() => {
    const currentlyUnresolved = new Set(
      requests.filter((r) => r.disputed && !r.disputeResolvedAt).map((r) => r.id)
    );

    if (isFirstPoll.current) {
      // Baseline only — no toasts for pre-existing disputes on first load.
      isFirstPoll.current = false;
      knownUnresolvedDisputes.current = currentlyUnresolved;
      return;
    }

    const newlyUnresolved = [...currentlyUnresolved].filter(
      (id) => !knownUnresolvedDisputes.current.has(id)
    );
    if (newlyUnresolved.length > 0) {
      setDisputeToast(`⚠️ ${newlyUnresolved.length} new dispute${newlyUnresolved.length === 1 ? '' : 's'} raised`);
      setTimeout(() => setDisputeToast(null), 6000);
    }
    knownUnresolvedDisputes.current = currentlyUnresolved;
  }, [requests]);
```

Render the toast near the top of the component's JSX return (a simple fixed-position pill, since no shared toast provider exists in this codebase):

```tsx
      {disputeToast && (
        <div style={{
          position: "fixed", top: 20, right: 20, zIndex: 1000,
          background: "#f8d7da", color: "#721c24",
          padding: "0.9rem 1.4rem", borderRadius: 8,
          fontWeight: 600, boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
        }}>
          {disputeToast}
        </div>
      )}
```

Add the dispute badge next to the existing status badge in the row (after the closing `</span>` of the status badge, inside the same `<td>`, around line 339):

```tsx
          {request.disputed && (
            <span
              style={{
                display: "inline-block",
                marginLeft: 8,
                padding: "0.4rem 0.8rem",
                background: request.disputeResolvedAt ? "#d4edda" : "#f8d7da",
                color: request.disputeResolvedAt ? "#155724" : "#721c24",
                borderRadius: 4,
                fontSize: "0.85rem",
                fontWeight: 600,
              }}
            >
              {request.disputeResolvedAt ? "Dispute Resolved" : "Disputed"}
            </span>
          )}
```

Add the "Resolve Dispute" button in the row's action cell (wherever the existing per-row action buttons live — search for where `cancelRequest`/`updateStatus` are called from JSX), guarded to only unresolved disputes:

```tsx
          {request.disputed && !request.disputeResolvedAt && (
            <button
              onClick={async () => {
                try {
                  await resolveDispute(request.id);
                  setActionMsg({ text: "Dispute resolved ✓", ok: true });
                } catch (e) {
                  setActionMsg({ text: e instanceof Error ? e.message : "Failed to resolve dispute", ok: false });
                }
              }}
              style={{
                padding: "0.4rem 0.8rem", background: "#07152f", color: "#fff",
                border: "none", borderRadius: 6, cursor: "pointer", fontSize: "0.85rem",
              }}
            >
              Resolve Dispute
            </button>
          )}
```

This tab is already admin-only (check how the tab is gated in its parent — if role-gating happens at the page/nav level rather than per-button, no additional guard is needed here since only admins reach this component at all; if it's not already page-gated, confirm before assuming).

- [ ] **Step 4: Verify**

Run: `rm -rf .next && npx tsc --noEmit && npm run build`
Expected: clean typecheck and build.

- [ ] **Step 5: Manual click-through**

Start the dev server, open the Requests tab as an admin. Trigger a dispute (WhatsApp `DISPUTE` reply on a test request in `AWAITING_COMPLETION_CONFIRM`), confirm: the row shows a red "Disputed" badge within one poll cycle (~15s) without a manual refresh, a toast pops for the new dispute, clicking "Resolve Dispute" flips it to a green "Dispute Resolved" badge and removes the button, and reloading the tab does NOT re-toast the now-resolved (or any pre-existing) dispute.

- [ ] **Step 6: Commit**

```bash
git add app/types.ts app/hooks/useRescueRequestApi.ts app/components/tabs/RescueRequestsTabAdmin.tsx
git commit -m "feat(dispute): dashboard badge, resolve button, polling toast for new disputes"
```

---

## Self-Review Notes

- **Spec coverage:** all sections of `2026-08-18-dispute-handling-design.md` map to a task — data model (Task 1), staff alert content/config (Tasks 2-3), three-branch raise + idempotent resolve (Tasks 3-4), dashboard badges/button/toast/baseline (Task 6).
- **Deviation from spec's dashboard assumption:** the spec's "extending the 15s pattern from `DispatchBoardTab.tsx`" implied polling already existed in `RescueRequestsTabAdmin.tsx` — confirmed during research it does not (mount-only `useEffect`). Task 6 adds polling from scratch; noting this since it's more surface area than the spec implied, though the resulting behavior matches what was designed.
- **Type consistency:** `resolveDispute` name matches across Task 4 (backend method), the controller route naming (`resolve-dispute`), and Task 6 (frontend hook function and call site).
