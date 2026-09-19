# Operator Email-Optional Signup + Termii-Backed OTP Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make operator `email` optional at signup, replace WhatsApp with Termii as the OTP delivery channel, and add phone-based login (password or OTP) so an email-less operator is never locked out.

**Architecture:** Termii becomes a pure SMS-delivery integration (`TermiiService.sendSms`) swapped in under `OtpService`'s already-channel-agnostic interface — no caller of `OtpService` changes. Two dead-end feature flags (`otpUpgradeEnabled`, `otpPasswordResetEnabled`) are removed outright now that Termii unblocks them. `CreateOperatorDto.email` becomes optional; `phoneVerificationToken` becomes mandatory for every operator signup, not just upgrades. Login gains an `identifier` (email-or-phone) + password path and a phone + OTP path, the latter restricted to `OPERATOR` and built on an atomic `updateMany` claim, not a read-then-write.

**Tech Stack:** NestJS, Prisma, Jest, raw `fetch` for the Termii HTTP integration (matching `PaystackService`'s existing convention — no SDK).

**Spec:** `docs/superpowers/specs/2026-09-18-operator-email-optional-otp-login-design.md`

## Global Constraints

- Termii is SMS delivery only — never its OTP product (pinId-based send/verify). `OtpService` keeps 100% ownership of code generation, hashing, and verification. (Spec §1.)
- `sendLoginCode`/`loginWithOtp` are restricted to `role === UserRole.OPERATOR`, re-checked at the point tokens are granted (inside the claiming transaction), not only at send time. (Spec §6.)
- Any code-consumption write (`PhoneVerification.consumedAt`) must be an atomic `updateMany` claim (`WHERE consumedAt: null AND tokenExpiresAt: {gt: now}`, require `count === 1`) — never a `findUnique` check followed by a separate `update`. This applies to `loginWithOtp` (new), `resetPasswordWithCode` (existing, fixed in Task 7), and `OperatorService.create()`'s upgrade and fresh-signup branches (existing/new, fixed in Task 5) — every one of these consumption sites, with no exceptions.
- Any lookup that treats a string as a phone number must normalize it first (`normalizePhone`) — a caller who types a Nigerian number in local format (`0801...`) must match the E.164 form (`+234801...`) it's stored in, the same way `registerCustomer`, `operator.service.ts`, and the OTP login routes already do. This applies to every ambiguous email-or-phone identifier lookup: `AuthService.login` (Task 8) and `requestPasswordReset` (Task 7, fixing a pre-existing 2026-08-19 gap along the way). Guard the normalization call — it throws on a non-phone-shaped string — so a mistyped email doesn't crash the request; treat a throw as "not a phone either" and fall through to the normal not-found handling.
- Any endpoint that reveals account existence by its response shape must not — `sendLoginCode` always returns `{ required: true }` regardless of whether the number is unknown, ineligible, or genuinely sent a code. (Spec §6.)
- Never a combined `prisma.user.findFirst({ where: { OR: [...] } })` lookup by both email and phone — always two separate `findUnique` calls, so the decision never depends on which row Prisma happens to match first. (Established convention, reused throughout the spec.)
- `otpUpgradeEnabled` and `otpPasswordResetEnabled` are removed outright, not flipped to `true` — delete the flag, the field, and the branch it used to gate around. (Spec §5, §6.)
- Config values read via `ConfigService.get<string>('ENV_VAR_NAME')` directly (flat env var names) — LRR does not use `registerAs`/`ConfigModule.forFeature` namespacing anywhere; don't introduce it for Termii. (Confirmed via `TwilioService`'s constructor — this plan's own research, not in the spec.)

---

### Task 1: Termii integration module

**Files:**
- Create: `src/integrations/termii/termii.service.ts`
- Create: `src/integrations/termii/termii.module.ts`
- Create: `src/integrations/termii/termii.service.spec.ts`
- Modify: `src/integrations/integrations.module.ts:1-9`

**Interfaces:**
- Produces: `TermiiService.sendSms(phone: string, message: string): Promise<void>` — throws `InternalServerErrorException` on failure. This is the only method later tasks depend on.

- [ ] **Step 1: Write the failing test**

```ts
// src/integrations/termii/termii.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { InternalServerErrorException } from '@nestjs/common';
import { TermiiService } from './termii.service';

describe('TermiiService', () => {
  async function buildService(config: Record<string, string | undefined>) {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TermiiService,
        { provide: ConfigService, useValue: { get: (key: string) => config[key] } },
      ],
    }).compile();
    return module.get<TermiiService>(TermiiService);
  }

  it('throws on construction when TERMII_API_KEY is missing', async () => {
    await expect(buildService({})).rejects.toThrow(
      'Termii configuration is incomplete',
    );
  });

  describe('sendSms', () => {
    it('posts to /sms/send with the literal message text', async () => {
      const service = await buildService({
        TERMII_API_KEY: 'test-key',
        TERMII_SENDER_ID: 'LRR',
        TERMII_BASE_URL: 'https://v3.api.termii.com/api',
      });
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ message_id: 'msg-1' }),
      });
      global.fetch = fetchMock as any;

      await service.sendSms('+2348012345678', 'Your LRR verification code is 123456.');

      expect(fetchMock).toHaveBeenCalledWith(
        'https://v3.api.termii.com/api/sms/send',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('Your LRR verification code is 123456.'),
        }),
      );
      const [, options] = fetchMock.mock.calls[0];
      const body = JSON.parse(options.body);
      expect(body).toEqual({
        api_key: 'test-key',
        to: '+2348012345678',
        from: 'LRR',
        sms: 'Your LRR verification code is 123456.',
        type: 'plain',
        channel: 'generic',
      });
    });

    it('throws InternalServerErrorException when the HTTP call fails', async () => {
      const service = await buildService({
        TERMII_API_KEY: 'test-key',
        TERMII_SENDER_ID: 'LRR',
      });
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ message: 'Insufficient balance' }),
      }) as any;

      await expect(
        service.sendSms('+2348012345678', 'code'),
      ).rejects.toThrow(InternalServerErrorException);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/integrations/termii/termii.service.spec.ts`
Expected: FAIL — `Cannot find module './termii.service'`

- [ ] **Step 3: Write the implementation**

```ts
// src/integrations/termii/termii.service.ts
import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Sentry from '@sentry/node';

@Injectable()
export class TermiiService {
  private readonly apiKey: string;
  private readonly senderId: string;
  private readonly baseUrl: string;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('TERMII_API_KEY');
    if (!apiKey) {
      throw new Error('Termii configuration is incomplete: missing TERMII_API_KEY');
    }
    this.apiKey = apiKey;
    this.senderId = this.configService.get<string>('TERMII_SENDER_ID') || 'LRR';
    this.baseUrl =
      this.configService.get<string>('TERMII_BASE_URL') ||
      'https://v3.api.termii.com/api';
  }

  /**
   * Plain SMS — Termii's generic send endpoint, not its OTP product. LRR
   * generates and verifies its own codes (see OtpService); this method only
   * delivers whatever text it's given.
   */
  async sendSms(phone: string, message: string): Promise<void> {
    try {
      const response = await fetch(`${this.baseUrl}/sms/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: this.apiKey,
          to: phone,
          from: this.senderId,
          sms: message,
          type: 'plain',
          channel: 'generic',
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        console.error('Termii sendSms failed:', {
          status: response.status,
          message: data.message,
        });
        Sentry.captureMessage('Termii sendSms failed', {
          level: 'error',
          extra: { status: response.status, message: data.message },
        });
        throw new InternalServerErrorException(
          'Failed to send SMS. Please try again.',
        );
      }
      console.log('SMS sent via Termii:', { messageId: data.message_id });
    } catch (error) {
      if (error instanceof InternalServerErrorException) throw error;
      console.error('Termii sendSms error:', error);
      Sentry.captureException(error, { extra: { stage: 'termii-send-sms' } });
      throw new InternalServerErrorException(
        'Failed to send SMS. Please try again.',
      );
    }
  }
}
```

```ts
// src/integrations/termii/termii.module.ts
import { Module } from '@nestjs/common';
import { TermiiService } from './termii.service';

@Module({
  providers: [TermiiService],
  exports: [TermiiService],
})
export class TermiiModule {}
```

Modify `src/integrations/integrations.module.ts` to register it alongside the other integrations (not exported from here either, matching `TwilioModule`'s existing treatment — modules that need `TermiiService` import `TermiiModule` directly, same as `OtpModule` already does for `TwilioModule`):

```ts
import { Module } from '@nestjs/common';
import { TwilioModule } from './twilio/twilio.module';
import { PaystackModule } from './paystack/paystack.module';
import { S3Module } from './s3/s3.module';
import { GeocodingModule } from './geocoding/geocoding.module';
import { TermiiModule } from './termii/termii.module';

@Module({
  imports: [TwilioModule, PaystackModule, S3Module, GeocodingModule, TermiiModule],
  exports: [GeocodingModule],
})
export class IntegrationsModule {}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/integrations/termii/termii.service.spec.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/integrations/termii/ src/integrations/integrations.module.ts
git commit -m "feat: add Termii SMS integration module"
```

---

### Task 2: `OtpService` — swap the delivery channel to Termii

**Files:**
- Modify: `src/otp/otp.module.ts`
- Modify: `src/otp/otp.service.ts:78-116` (the private `sendCodeToPhone` method)
- Modify: `src/otp/otp.service.spec.ts` (swap the `TwilioService` mock for `TermiiService` throughout)

**Interfaces:**
- Consumes: `TermiiService.sendSms(phone: string, message: string): Promise<void>` (Task 1).
- Produces: no change to `OtpService`'s own public surface — this task is a pure dependency swap.

- [ ] **Step 1: Update the failing assertions**

In `src/otp/otp.service.spec.ts`, replace the Twilio mock with a Termii one, and update every assertion that currently checks `twilioService.sendWhatsAppMessage`:

```ts
// Replace the import:
import { TermiiService } from '../integrations/termii/termii.service';

// Replace the mock declaration and its construction:
let termiiService: { sendSms: jest.Mock };
// ...
termiiService = { sendSms: jest.fn() };

const module: TestingModule = await Test.createTestingModule({
  providers: [
    OtpService,
    { provide: PrismaService, useValue: prisma },
    { provide: TermiiService, useValue: termiiService },
  ],
}).compile();
```

Replace every `twilioService.sendWhatsAppMessage` reference in the file (9 occurrences: 3 "not.toHaveBeenCalled" checks, 2 "toHaveBeenCalledWith" checks in `sendCode`'s and `sendPasswordResetCode`'s happy-path tests, plus the remaining `not.toHaveBeenCalled` checks in the cooldown/cap-rejection tests) with the equivalent `termiiService.sendSms` call — same arguments shape, since `sendSms(phone, message)` takes the same two positional arguments `sendWhatsAppMessage` did. For example:

```ts
it('sends a code and responds required:true for an existing CUSTOMER number', async () => {
  prisma.user.findUnique.mockResolvedValue({ id: 'u-1', role: UserRole.CUSTOMER });
  prisma.phoneVerification.findMany.mockResolvedValue([]);
  prisma.phoneVerification.create.mockResolvedValue({ id: 'pv-1' });

  const result = await service.sendCode('+2348012345678');

  expect(result).toEqual({ required: true });
  expect(termiiService.sendSms).toHaveBeenCalledWith(
    expect.stringContaining('+2348012345678'),
    expect.stringContaining('verification code'),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/otp/otp.service.spec.ts`
Expected: FAIL — `Nest can't resolve dependencies of the OtpService (?, TwilioService)` (the test module no longer provides `TwilioService` but `OtpService` still imports/injects it), or assertion failures on the renamed mock.

- [ ] **Step 3: Update the implementation**

```ts
// src/otp/otp.service.ts — imports
import { TermiiService } from '../integrations/termii/termii.service';
// remove: import { TwilioService } from '../integrations/twilio/twilio.service';
// remove: import { toWhatsAppAddress } from '../common/phone.util';
```

```ts
// constructor
constructor(
  private readonly prisma: PrismaService,
  private readonly termiiService: TermiiService,
) {}
```

```ts
// sendCodeToPhone — only the delivery line changes
private async sendCodeToPhone(
  phoneNumber: string,
  label: string,
): Promise<void> {
  const recent = await this.prisma.phoneVerification.findMany({
    where: {
      phoneNumber,
      createdAt: { gte: new Date(Date.now() - SEND_WINDOW_MS) },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (
    recent.length > 0 &&
    Date.now() - recent[0].createdAt.getTime() < RESEND_COOLDOWN_MS
  ) {
    throw new BadRequestException(
      'Please wait before requesting another code.',
    );
  }
  if (recent.length >= MAX_SENDS_PER_WINDOW) {
    throw new BadRequestException(
      'Too many code requests — please try again later.',
    );
  }

  const code = generateCode();
  await this.prisma.phoneVerification.create({
    data: {
      phoneNumber,
      codeHash: hash(code),
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    },
  });

  await this.termiiService.sendSms(
    phoneNumber,
    `Your LRR ${label} is ${code}. It expires in 10 minutes.`,
  );
}
```

`src/otp/otp.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { OtpService } from './otp.service';
import { OtpController } from './otp.controller';
import { TermiiModule } from '../integrations/termii/termii.module';

@Module({
  imports: [TermiiModule],
  providers: [OtpService],
  controllers: [OtpController],
  exports: [OtpService],
})
export class OtpModule {}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/otp/otp.service.spec.ts`
Expected: PASS (all existing tests, now against the Termii mock)

- [ ] **Step 5: Commit**

```bash
git add src/otp/otp.module.ts src/otp/otp.service.ts src/otp/otp.service.spec.ts
git commit -m "feat: route OTP delivery through Termii instead of WhatsApp"
```

---

### Task 3: `OtpService.sendCode` — verify a brand-new phone too, not just upgrades

**Files:**
- Modify: `src/otp/otp.service.ts:39-55` (`sendCode`)
- Modify: `src/otp/otp.service.spec.ts:44-51` (the "fresh number" test)

**Interfaces:**
- Consumes: nothing new.
- Produces: `sendCode`'s brand-new-phone case now returns `{ required: true }` and sends a code (previously `{ required: false, available: true }`, no send). The existing-CUSTOMER and existing-non-CUSTOMER cases are unchanged.

- [ ] **Step 1: Write the failing test**

Replace the existing "fresh number" test (it currently asserts the *old* behavior this task removes):

```ts
it('sends a code and responds required:true for a brand-new phone (no account yet)', async () => {
  prisma.user.findUnique.mockResolvedValue(null);
  prisma.phoneVerification.findMany.mockResolvedValue([]);
  prisma.phoneVerification.create.mockResolvedValue({ id: 'pv-1' });

  const result = await service.sendCode('+2348012345678');

  expect(result).toEqual({ required: true });
  expect(termiiService.sendSms).toHaveBeenCalledWith(
    expect.stringContaining('+2348012345678'),
    expect.stringContaining('verification code'),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/otp/otp.service.spec.ts -t "brand-new phone"`
Expected: FAIL — `expect(result).toEqual({ required: true })` receives `{ required: false, available: true }`

- [ ] **Step 3: Write the implementation**

```ts
async sendCode(
  phoneNumber: string,
): Promise<{ required: boolean; available?: boolean }> {
  const existingUser = await this.prisma.user.findUnique({
    where: { phoneNumber },
  });

  if (existingUser && existingUser.role !== UserRole.CUSTOMER) {
    return { required: false, available: false };
  }

  // Brand-new phone (fresh operator signup) or an existing CUSTOMER
  // (upgrade path) — both now verify ownership before proceeding.
  await this.sendCodeToPhone(phoneNumber, 'verification code');
  return { required: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/otp/otp.service.spec.ts`
Expected: PASS (all tests, including the existing-CUSTOMER and existing-non-CUSTOMER cases, unchanged)

- [ ] **Step 5: Commit**

```bash
git add src/otp/otp.service.ts src/otp/otp.service.spec.ts
git commit -m "feat: verify phone ownership for every operator signup, not just upgrades"
```

---

### Task 4: `OtpService.sendLoginCode` — role-gated, enumeration-safe

**Files:**
- Modify: `src/otp/otp.service.ts` (new method, after `sendPasswordResetCode`)
- Modify: `src/otp/otp.service.spec.ts` (new `describe('sendLoginCode', ...)` block)

**Interfaces:**
- Consumes: nothing new.
- Produces: `OtpService.sendLoginCode(phoneNumber: string): Promise<{ required: boolean }>` — Task 9 (`AuthService.loginWithOtp`) calls this. Always resolves `{ required: true }`; only actually sends when the phone belongs to an `OPERATOR`.

- [ ] **Step 1: Write the failing test**

```ts
describe('sendLoginCode', () => {
  it('responds required:true and sends nothing for an unknown phone', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    const result = await service.sendLoginCode('+2348012345678');

    expect(result).toEqual({ required: true });
    expect(termiiService.sendSms).not.toHaveBeenCalled();
  });

  it('responds required:true and sends nothing for a non-OPERATOR account — same response either way', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u-1',
      role: UserRole.CUSTOMER,
    });

    const result = await service.sendLoginCode('+2348012345678');

    expect(result).toEqual({ required: true });
    expect(termiiService.sendSms).not.toHaveBeenCalled();
  });

  it('sends a code for an OPERATOR account', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u-1',
      role: UserRole.OPERATOR,
    });
    prisma.phoneVerification.findMany.mockResolvedValue([]);
    prisma.phoneVerification.create.mockResolvedValue({ id: 'pv-1' });

    const result = await service.sendLoginCode('+2348012345678');

    expect(result).toEqual({ required: true });
    expect(termiiService.sendSms).toHaveBeenCalledWith(
      expect.stringContaining('+2348012345678'),
      expect.stringContaining('login code'),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/otp/otp.service.spec.ts -t "sendLoginCode"`
Expected: FAIL — `service.sendLoginCode is not a function`

- [ ] **Step 3: Write the implementation**

```ts
/**
 * OTP-based login — unlike sendCode (upgrade/signup verification) and
 * sendPasswordResetCode (any role with a portal password), eligibility here
 * is role === OPERATOR only: this route trades a password for a single SMS
 * code, a strictly weaker factor than what CUSTOMER/ADMIN/SUPER_ADMIN
 * accounts assume. The response never reveals whether the number is
 * unknown, ineligible, or genuinely sent — same account-enumeration
 * defense as sendPasswordResetCode's generic messaging, applied to the
 * return value itself since this endpoint has no separate message field.
 */
async sendLoginCode(phoneNumber: string): Promise<{ required: boolean }> {
  const existingUser = await this.prisma.user.findUnique({
    where: { phoneNumber },
  });
  if (existingUser?.role === UserRole.OPERATOR) {
    await this.sendCodeToPhone(phoneNumber, 'login code');
  }
  return { required: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/otp/otp.service.spec.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/otp/otp.service.ts src/otp/otp.service.spec.ts
git commit -m "feat: add role-gated, enumeration-safe OTP login code sending"
```

---

### Task 5: Operator signup — email optional, universal phone verification, remove `otpUpgradeEnabled`

**Files:**
- Modify: `src/operator/dto/create-operator.dto.ts`
- Modify: `src/operator/operator.service.ts:67-76,103-119,129-164,196-260` (flag removal, existing-email lookup, upgrade guard, new fresh-signup token check, transaction branches)
- Modify: `src/operator/operator.service.spec.ts:251-448`

**Interfaces:**
- Consumes: `OtpService.findValidTokenRow` (existing, unchanged signature) — Task 3's widened `sendCode` is what makes a token exist to find for a fresh signup.
- Produces: `OperatorService.create()` now requires `data.phoneVerificationToken` unconditionally and rejects `email`-duplicate checks only when `data.email` is present. No new public methods.

- [ ] **Step 1: Write the failing tests**

Update `baseDto()` (every existing test in this describe block uses it) to reflect the new required field, and rewrite the three tests whose asserted behavior this task changes:

```ts
// operator.service.spec.ts — baseDto now includes a token, since it's required
const baseDto = (): CreateOperatorDto => ({
  email: 'op@example.com',
  password: 'password123',
  name: 'Jane Doe',
  businessName: 'Acme Towing',
  contactName: 'Jane Doe',
  phoneNumber: '+2348012345678',
  businessPhoneNumber: '+2348012345678',
  address: '1 Test Street',
  latitude: 6.5,
  longitude: 3.4,
  truckClasses: [TruckClass.LOW_BED],
  phoneVerificationToken: 'valid-token',
});
```

Also update the file's top-level `prisma` mock type and `beforeEach` initialization — `phoneVerification: { update: jest.Mock }` becomes `phoneVerification: { updateMany: jest.Mock }` (nothing in the rewritten tests below calls `.update` on it anymore; every one of them assigns `.updateMany` directly, the same ad-hoc-cast style the original file already used for `.findUnique`):

```ts
// type declaration
phoneVerification: { updateMany: jest.Mock };
// beforeEach
phoneVerification: { updateMany: jest.fn() },
```

Replace `'fresh number: unchanged normal signup'` — a fresh signup now requires and consumes a token, same as the upgrade path does:

```ts
it('fresh number: requires and atomically claims a phone-verification token, same as the upgrade path', async () => {
  prisma.user.findUnique.mockResolvedValue(null); // existingByPhone, existingByEmail
  prisma.operator.findUnique.mockResolvedValue(null);
  prisma.user.findFirst.mockResolvedValue(null);
  otpService.findValidTokenRow.mockResolvedValue({ id: 'pv-fresh' });
  prisma.$transaction.mockImplementation(async (fn: any) => fn(prisma));
  (prisma.phoneVerification as any).updateMany = jest
    .fn()
    .mockResolvedValue({ count: 1 });
  prisma.user.create.mockResolvedValue({ id: 'u-new' });
  prisma.operator.create.mockResolvedValue({ id: 'op-new' });
  prisma.operatorMember.create.mockResolvedValue({});

  await service.create(baseDto());

  expect(prisma.user.create).toHaveBeenCalled();
  expect(otpService.findValidTokenRow).toHaveBeenCalledWith(
    baseDto().phoneNumber,
    'valid-token',
  );
  expect(prisma.phoneVerification.updateMany).toHaveBeenCalledWith({
    where: { id: 'pv-fresh', consumedAt: null, tokenExpiresAt: { gt: expect.any(Date) } },
    data: { consumedAt: expect.any(Date) },
  });
});

it('fresh number: two concurrent submissions with the same token — the second finds the claim already taken', async () => {
  prisma.user.findUnique.mockResolvedValue(null);
  prisma.operator.findUnique.mockResolvedValue(null);
  prisma.user.findFirst.mockResolvedValue(null);
  otpService.findValidTokenRow.mockResolvedValue({ id: 'pv-fresh' });
  prisma.$transaction.mockImplementation(async (fn: any) => fn(prisma));
  // Simulates the row a first, already-committed concurrent call already claimed.
  (prisma.phoneVerification as any).updateMany = jest
    .fn()
    .mockResolvedValue({ count: 0 });

  await expect(service.create(baseDto())).rejects.toThrow(
    'Verify your phone number first.',
  );
  expect(prisma.user.create).not.toHaveBeenCalled();
});

it('fresh number without a token: rejected before the transaction starts', async () => {
  prisma.user.findUnique.mockResolvedValue(null);
  prisma.operator.findUnique.mockResolvedValue(null);
  prisma.user.findFirst.mockResolvedValue(null);
  const dto = baseDto();
  delete (dto as any).phoneVerificationToken;

  await expect(service.create(dto)).rejects.toThrow(
    'Verify your phone number first.',
  );
  expect(prisma.$transaction).not.toHaveBeenCalled();
});

it('fresh number with an invalid/expired token: rejected before the transaction starts', async () => {
  prisma.user.findUnique.mockResolvedValue(null);
  prisma.operator.findUnique.mockResolvedValue(null);
  prisma.user.findFirst.mockResolvedValue(null);
  otpService.findValidTokenRow.mockResolvedValue(null);

  await expect(service.create(baseDto())).rejects.toThrow(
    'Verify your phone number first.',
  );
  expect(prisma.$transaction).not.toHaveBeenCalled();
});

it('signup with no email: skips the email-duplicate lookup entirely and succeeds', async () => {
  const dto = baseDto();
  delete (dto as any).email;
  prisma.user.findUnique.mockImplementation(({ where }: any) => {
    if (where.email) throw new Error('email lookup must not run when email is absent');
    return Promise.resolve(null); // phone lookup
  });
  prisma.operator.findUnique.mockResolvedValue(null);
  prisma.user.findFirst.mockResolvedValue(null);
  otpService.findValidTokenRow.mockResolvedValue({ id: 'pv-fresh' });
  prisma.$transaction.mockImplementation(async (fn: any) => fn(prisma));
  (prisma.phoneVerification as any).updateMany = jest
    .fn()
    .mockResolvedValue({ count: 1 });
  prisma.user.create.mockResolvedValue({ id: 'u-new' });
  prisma.operator.create.mockResolvedValue({ id: 'op-new' });
  prisma.operatorMember.create.mockResolvedValue({});

  await service.create(dto);

  expect(prisma.user.create).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ email: undefined }) }),
  );
});
```

Delete `'upgrade path disabled by default: existing customer blocked even with a valid token'` — the flag it tests no longer exists.

Replace `'existing customer with a valid token: reuses the User row transactionally, consumes the token'` — the flag line is gone, and consumption is now an atomic claim, not `findUnique` + `update`:

```ts
it('existing customer with a valid token: reuses the User row transactionally, atomically claims the token', async () => {
  const dto = { ...baseDto(), phoneVerificationToken: 'valid-token' };
  prisma.user.findUnique.mockImplementation(({ where }: any) => {
    if (where.phoneNumber)
      return Promise.resolve({
        id: 'existing-customer',
        role: 'CUSTOMER',
        phoneNumber: dto.phoneNumber,
        email: 'old@example.com',
      });
    if (where.email)
      return Promise.resolve({
        id: 'existing-customer',
        role: 'CUSTOMER',
      }); // same account — not a conflict
    return Promise.resolve(null);
  });
  prisma.operator.findUnique.mockResolvedValue(null);
  prisma.user.findFirst.mockResolvedValue(null);
  otpService.findValidTokenRow.mockResolvedValue({
    id: 'pv-1',
  });
  prisma.$transaction.mockImplementation(async (fn: any) => fn(prisma));
  (prisma.phoneVerification as any).updateMany = jest
    .fn()
    .mockResolvedValue({ count: 1 });
  prisma.user.update.mockResolvedValue({
    id: 'existing-customer',
  });
  prisma.operator.create.mockResolvedValue({
    id: 'op-new',
  });
  prisma.operatorMember.create.mockResolvedValue({});

  await service.create(dto);

  expect(prisma.user.create).not.toHaveBeenCalled();
  expect(prisma.user.update).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { id: 'existing-customer' },
      data: expect.objectContaining({ role: 'OPERATOR' }),
    }),
  );
  expect(prisma.phoneVerification.updateMany).toHaveBeenCalledWith({
    where: { id: 'pv-1', consumedAt: null, tokenExpiresAt: { gt: expect.any(Date) } },
    data: { consumedAt: expect.any(Date) },
  });
});

it('existing customer: two concurrent upgrade submissions with the same token — the second finds the claim already taken', async () => {
  const dto = { ...baseDto(), phoneVerificationToken: 'valid-token' };
  prisma.user.findUnique.mockImplementation(({ where }: any) => {
    if (where.phoneNumber)
      return Promise.resolve({
        id: 'existing-customer',
        role: 'CUSTOMER',
        phoneNumber: dto.phoneNumber,
        email: 'old@example.com',
      });
    if (where.email) return Promise.resolve({ id: 'existing-customer', role: 'CUSTOMER' });
    return Promise.resolve(null);
  });
  prisma.operator.findUnique.mockResolvedValue(null);
  prisma.user.findFirst.mockResolvedValue(null);
  otpService.findValidTokenRow.mockResolvedValue({ id: 'pv-1' });
  prisma.$transaction.mockImplementation(async (fn: any) => fn(prisma));
  // Simulates the row a first, already-committed concurrent submission already claimed.
  (prisma.phoneVerification as any).updateMany = jest
    .fn()
    .mockResolvedValue({ count: 0 });

  await expect(service.create(dto)).rejects.toThrow(
    'This number belongs to an existing account — verify your number first.',
  );
  expect(prisma.user.update).not.toHaveBeenCalled();
});
```

Remove `(service as any).otpUpgradeEnabled = true;` from `'existing customer without a valid token: blocked with the specific error, transaction never starts'` — the upgrade path is now always active, nothing to flip; the rest of that test's body (mocking `otpService.findValidTokenRow` to resolve `null` and asserting the pre-transaction rejection) is unchanged, since that check still happens before the transaction and before any `phoneVerification.updateMany` claim is attempted.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/operator/operator.service.spec.ts`
Expected: FAIL — the new/changed tests fail against the current implementation (fresh signup currently succeeds with no token at all); TypeScript also currently fails to compile `baseDto()` once `CreateOperatorDto.phoneVerificationToken` isn't optional yet (Step 3 fixes this in lockstep).

- [ ] **Step 3: Write the implementation**

`src/operator/dto/create-operator.dto.ts` — two field changes:

```ts
@IsEmail()
@IsOptional()
email?: string;
```

```ts
// Was optional, only meaningful for the upgrade path. Now required for
// every signup — see operator.service.ts create().
@IsString()
@IsNotEmpty()
phoneVerificationToken: string;
```

`src/operator/operator.service.ts` — remove the flag:

```ts
// Delete entirely:
// private readonly otpUpgradeEnabled = false;
```

Update the email-duplicate lookup to skip when absent (the comment already anticipating this):

```ts
const existingByPhone = await this.prisma.user.findUnique({
  where: { phoneNumber: personalPhone },
});
const existingByEmail = data.email
  ? await this.prisma.user.findUnique({ where: { email: data.email } })
  : null;

if (existingByEmail && existingByEmail.id !== existingByPhone?.id) {
  logger.warn('operator.create: email already registered', {
    email: data.email,
    existingUserId: existingByEmail.id,
  });
  throw new ConflictException('Email or phone number already registered');
}
```

Update the upgrade-path guard to drop the flag condition:

```ts
let upgradeUserId: string | null = null;
let upgradeTokenRowId: string | null = null;
let freshSignupTokenRowId: string | null = null;

if (existingByPhone) {
  if (existingByPhone.role !== UserRole.CUSTOMER) {
    logger.warn('operator.create: phone already registered to a non-customer account', {
      existingUserId: existingByPhone.id,
      role: existingByPhone.role,
    });
    throw new ConflictException('Email or phone number already registered');
  }

  if (!data.phoneVerificationToken) {
    throw new ConflictException(
      'This number belongs to an existing account — verify your number first.',
    );
  }
  const tokenRow = await this.otpService.findValidTokenRow(
    personalPhone,
    data.phoneVerificationToken,
  );
  if (!tokenRow) {
    throw new ConflictException(
      'This number belongs to an existing account — verify your number first.',
    );
  }
  upgradeUserId = existingByPhone.id;
  upgradeTokenRowId = tokenRow.id;
} else {
  // Fresh signup — verification is now mandatory here too, not just for
  // upgrades. Deliberately BadRequestException (400), not the upgrade
  // branch's ConflictException (409): the upgrade branch's message is
  // shared with the "phone belongs to someone else" conflict above it in
  // the same block; a fresh signup has no such shared context, and
  // "you skipped verification" is a plain bad request, not a conflict.
  if (!data.phoneVerificationToken) {
    throw new BadRequestException('Verify your phone number first.');
  }
  const tokenRow = await this.otpService.findValidTokenRow(
    personalPhone,
    data.phoneVerificationToken,
  );
  if (!tokenRow) {
    throw new BadRequestException('Verify your phone number first.');
  }
  freshSignupTokenRowId = tokenRow.id;
}
```

Update the transaction to claim `freshSignupTokenRowId`/`upgradeTokenRowId` atomically — an `updateMany` whose `WHERE` is the eligibility check, requiring `count === 1`, per the plan's Global Constraints. This replaces the `findUnique`-then-`update` pair the pre-existing upgrade branch used (and the plan's own earlier draft copied into the new fresh-signup branch) — that pair is exactly the race the account-deletion and payment-double-charge work elsewhere in this project already established: two concurrent submissions of the same token can both observe `consumedAt: null` before either commits its write. Two concurrent "existing customer upgrades to operator" submissions with the same token — a double-click, a retry — is a completely realistic way to hit this, not a theoretical one:

```ts
return this.prisma.$transaction(async (tx) => {
  let user;

  if (upgradeUserId) {
    const claimed = await tx.phoneVerification.updateMany({
      where: { id: upgradeTokenRowId!, consumedAt: null, tokenExpiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });
    if (claimed.count !== 1) {
      throw new ConflictException(
        'This number belongs to an existing account — verify your number first.',
      );
    }
    const stillFree = data.email
      ? await tx.user.findUnique({ where: { email: data.email } })
      : null;
    if (stillFree && stillFree.id !== upgradeUserId) {
      throw new ConflictException('Email or phone number already registered');
    }

    user = await tx.user.update({
      where: { id: upgradeUserId },
      data: {
        email: data.email,
        passwordHash,
        name: data.name,
        role: UserRole.OPERATOR,
      },
    });
  } else {
    // Same atomic-claim pattern as the upgrade branch above.
    const claimed = await tx.phoneVerification.updateMany({
      where: { id: freshSignupTokenRowId!, consumedAt: null, tokenExpiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });
    if (claimed.count !== 1) {
      throw new BadRequestException('Verify your phone number first.');
    }

    user = await tx.user.create({
      data: {
        email: data.email,
        passwordHash,
        name: data.name,
        phoneNumber: personalPhone,
        role: UserRole.OPERATOR,
      },
    });
  }

  // ...unchanged: tx.operator.create, tx.operatorMember.create, return...
});
```

The claim now performs the `consumedAt` write itself — there is no longer a separate `tx.phoneVerification.update(...)` call after it in either branch.

Confirm `BadRequestException` is imported in `operator.service.ts` (it already is, used elsewhere in `create()` for the truck-class checks).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/operator/operator.service.spec.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Run the full unit suite and typecheck**

Run: `npx tsc --noEmit && npx jest`
Expected: PASS — no other file constructs a `CreateOperatorDto` literal that's now missing the required `phoneVerificationToken` (confirm via the typecheck; fix any other call site the same way `baseDto()` was fixed if one turns up).

- [ ] **Step 6: Commit**

```bash
git add src/operator/dto/create-operator.dto.ts src/operator/operator.service.ts src/operator/operator.service.spec.ts
git commit -m "feat: make operator email optional and phone verification mandatory for every signup"
```

---

### Task 6: `JwtPayload` / `AuthResponse` — `email` becomes nullable

**Files:**
- Modify: `src/auth/auth.service.ts:16-30,59-66,95-109,121-156,247-261`

**Interfaces:**
- Produces: `JwtPayload.email: string | null`, `AuthResponse.user.email: string | null`, `generateToken(user: { id: string; email: string | null; role: UserRole }): string`. Every later task in this plan that constructs an `AuthResponse` or calls `generateToken` relies on this shape.

- [ ] **Step 1: Confirm the existing tests still describe correct behavior**

No test currently asserts `email` is non-null at the type level (Jest doesn't check TS types at runtime) — `createStaff`'s existing tests pass a real email string either way, so they need no changes. This task is verified by the typecheck in Step 4, not new test cases.

- [ ] **Step 2: (n/a — no new failing test; this is a type-safety change verified by `tsc`)**

- [ ] **Step 3: Write the implementation**

```ts
export interface JwtPayload {
  sub: string;
  email: string | null;
  role: UserRole;
}

export interface AuthResponse {
  accessToken: string;
  user: {
    id: string;
    email: string | null;
    name: string | null;
    role: UserRole;
  };
}
```

```ts
generateToken(user: { id: string; email: string | null; role: UserRole }): string {
  const payload: JwtPayload = {
    sub: user.id,
    email: user.email,
    role: user.role,
  };
  return this.jwtService.sign(payload);
}
```

Remove the four non-null assertions and pass `user.email`/`updated.email` directly (already `string | null` from Prisma):

- `login()`: `email: user.email!` → `email: user.email` (both the `generateToken` call and the returned `user` object, lines ~97 and ~105).
- `createStaff()`: `email: user.email!` → `email: user.email` (line ~152). `data.email` on `CreateStaffDto` stays required (staff accounts keep requiring email — out of scope for this plan; only operators change) — this line only removes the unnecessary assertion on the DB-returned value, not the input requirement.
- `registerCustomer()`: two occurrences (lines ~200, ~257) → `email: updated.email` / `email: user.email`.

Leave `email: user.email ?? phoneNumber` (line ~192, ~249 — the `generateToken` call's own argument) as-is; it already handles null correctly and isn't part of the non-null-assertion cleanup.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc --noEmit && npx jest src/auth/auth.service.spec.ts`
Expected: PASS — `tsc` reports no new errors (confirms nothing outside `auth.service.ts` broke), existing `auth.service.spec.ts` tests unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/auth/auth.service.ts
git commit -m "refactor: make JwtPayload/AuthResponse email nullable, drop non-null assertions"
```

---

### Task 7: Remove `otpPasswordResetEnabled`; fix `resetPasswordWithCode`'s consumption race

**Files:**
- Modify: `src/auth/auth.service.ts:268-349,360-413`
- Modify: `src/auth/auth.service.spec.ts:100-395`

**Interfaces:**
- Consumes: nothing new.
- Produces: `requestPasswordReset` and `resetPasswordWithCode`'s signatures are unchanged; only their internal behavior changes (verified-reset is now the only mode; consumption is atomic).

- [ ] **Step 1: Write the failing tests**

Delete the entire `describe('with the flag off (default) — resets immediately, no verification', ...)` block (lines 108-203) — that behavior no longer exists. Remove `beforeEach(() => { (service as any).otpPasswordResetEnabled = true; ... })` from `describe('with the flag on — sends a code, never resets directly', ...)` (lines 205-283) and rename it to describe the sole remaining behavior:

```ts
describe('requestPasswordReset', () => {
  it('rejects a password shorter than 8 characters', async () => {
    await expect(
      service.requestPasswordReset('ada@example.com', 'short'),
    ).rejects.toThrow('at least 8 characters');
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('resolves by email first, sends the code, ignores newPassword, and reports otpRequired:true', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'u-1',
      email: 'ada@example.com',
      phoneNumber: '+2348012345678',
      passwordHash: 'hashed',
    });

    const result = await service.requestPasswordReset(
      'ada@example.com',
      'newpassword1',
    );

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: 'ada@example.com' },
    });
    expect(otpService.sendPasswordResetCode).toHaveBeenCalledWith(
      '+2348012345678',
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(result).toEqual({
      message:
        "If an account exists, we've sent a reset code to its registered phone number.",
      otpRequired: true,
    });
  });

  it('falls back to phone lookup (already E.164) when the identifier does not match an email', async () => {
    prisma.user.findUnique
      .mockResolvedValueOnce(null) // email lookup misses
      .mockResolvedValueOnce({
        id: 'u-1',
        phoneNumber: '+2348012345678',
        passwordHash: 'hashed',
      });

    await service.requestPasswordReset('+2348012345678', 'newpassword1');

    expect(prisma.user.findUnique).toHaveBeenNthCalledWith(2, {
      where: { phoneNumber: '+2348012345678' },
    });
    expect(otpService.sendPasswordResetCode).toHaveBeenCalledWith(
      '+2348012345678',
    );
  });

  it('normalizes a phone typed in local format (0801...) before the phone lookup', async () => {
    prisma.user.findUnique
      .mockResolvedValueOnce(null) // email lookup misses
      .mockResolvedValueOnce({
        id: 'u-1',
        phoneNumber: '+2348012345678',
        passwordHash: 'hashed',
      });

    await service.requestPasswordReset('08012345678', 'newpassword1');

    expect(prisma.user.findUnique).toHaveBeenNthCalledWith(2, {
      where: { phoneNumber: '+2348012345678' },
    });
    expect(otpService.sendPasswordResetCode).toHaveBeenCalledWith(
      '+2348012345678',
    );
  });

  it('returns the generic message with no crash when the identifier is neither a known email nor a valid phone shape', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(null); // email lookup misses

    const result = await service.requestPasswordReset(
      'not-an-email-or-phone',
      'newpassword1',
    );

    expect(otpService.sendPasswordResetCode).not.toHaveBeenCalled();
    expect(result.otpRequired).toBe(true);
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
  });

  it('returns the same generic message and sends nothing when no account matches', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    const result = await service.requestPasswordReset(
      'nobody@example.com',
      'newpassword1',
    );

    expect(otpService.sendPasswordResetCode).not.toHaveBeenCalled();
    expect(result.message).toContain("we've sent a reset code");
  });

  it('returns the same generic message and sends nothing when the account has no portal password', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'u-1',
      phoneNumber: '+2348012345678',
      passwordHash: null,
    });

    const result = await service.requestPasswordReset(
      'ada@example.com',
      'newpassword1',
    );

    expect(otpService.sendPasswordResetCode).not.toHaveBeenCalled();
    expect(result.message).toContain("we've sent a reset code");
  });
});
```

In `describe('resetPasswordWithCode', ...)`: remove `describe('with the flag on', ...)`'s wrapper and its `beforeEach` flag-set (same treatment), and replace the two `tx.phoneVerification.findUnique`/plain-`update`-based tests with the atomic-claim shape:

```ts
describe('resetPasswordWithCode', () => {
  it('rejects a password shorter than 8 characters', async () => {
    await expect(
      service.resetPasswordWithCode('+2348012345678', '123456', 'short'),
    ).rejects.toThrow('at least 8 characters');
    expect(otpService.verifyCode).not.toHaveBeenCalled();
  });

  it('fails to find a code when none was ever sent', async () => {
    otpService.verifyCode.mockRejectedValue(
      new Error('Code expired or not found — request a new one.'),
    );

    await expect(
      service.resetPasswordWithCode('+2348012345678', '123456', 'newpassword1'),
    ).rejects.toThrow('Code expired or not found');
  });

  it('verifies the code, atomically claims the token, and updates the password', async () => {
    otpService.verifyCode.mockResolvedValue({ token: 'tok-1' });
    otpService.findValidTokenRow.mockResolvedValue({ id: 'pv-1' });
    const tx = {
      phoneVerification: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'u-1', passwordHash: 'old-hash' }),
        update: jest.fn(),
      },
    };
    prisma.$transaction.mockImplementation((cb: any) => cb(tx));

    const result = await service.resetPasswordWithCode(
      '+2348012345678',
      '123456',
      'newpassword1',
    );

    expect(tx.phoneVerification.updateMany).toHaveBeenCalledWith({
      where: { id: 'pv-1', consumedAt: null, tokenExpiresAt: { gt: expect.any(Date) } },
      data: { consumedAt: expect.any(Date) },
    });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'u-1' },
      data: { passwordHash: expect.any(String) },
    });
    expect(result.message).toContain('Password updated');
  });

  it('rejects when the claim matches zero rows — already consumed or expired since verify', async () => {
    otpService.verifyCode.mockResolvedValue({ token: 'tok-1' });
    otpService.findValidTokenRow.mockResolvedValue({ id: 'pv-1' });
    const tx = {
      phoneVerification: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      user: { findUnique: jest.fn(), update: jest.fn() },
    };
    prisma.$transaction.mockImplementation((cb: any) => cb(tx));

    await expect(
      service.resetPasswordWithCode('+2348012345678', '123456', 'newpassword1'),
    ).rejects.toThrow('expired');
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('rejects a second call with the same already-consumed code — the concrete replay this fixes', async () => {
    otpService.verifyCode.mockResolvedValue({ token: 'tok-1' });
    otpService.findValidTokenRow.mockResolvedValue({ id: 'pv-1' });
    const tx = {
      // Simulates the row a first, already-succeeded call already claimed.
      phoneVerification: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      user: { findUnique: jest.fn(), update: jest.fn() },
    };
    prisma.$transaction.mockImplementation((cb: any) => cb(tx));

    await expect(
      service.resetPasswordWithCode('+2348012345678', '123456', 'newpassword1'),
    ).rejects.toThrow('expired');
  });

  it('rejects when no valid token row is found', async () => {
    otpService.verifyCode.mockResolvedValue({ token: 'tok-1' });
    otpService.findValidTokenRow.mockResolvedValue(null);

    await expect(
      service.resetPasswordWithCode('+2348012345678', '123456', 'newpassword1'),
    ).rejects.toThrow('expired');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
```

Update the `prisma` test double's `$transaction`-callback shape assumption stays the same (`tx` is a plain object passed to the mocked callback) — only `phoneVerification` on `tx` changes from `{ findUnique, update }` to `{ updateMany }`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/auth/auth.service.spec.ts`
Expected: FAIL — `requestPasswordReset`'s flag-off tests no longer apply (method not yet changed); `resetPasswordWithCode`'s new atomic-claim tests fail against the current `findUnique`-then-`update` implementation.

- [ ] **Step 3: Write the implementation**

```ts
/**
 * Resolves the account by email first, then phone number — two separate
 * lookups, never a combined OR (same convention as operator.service.ts).
 * The phone lookup normalizes first (same reasoning as AuthService.login,
 * Task 8): this pre-existing method (2026-08-19) had the identical gap —
 * a locally-formatted phone (0801...) never matched the E.164-stored
 * value, silently falling through to "no account" every time. Same file,
 * same bug class as Task 8's fix, folded in here rather than left stale
 * next to the corrected version.
 * The response message never reveals whether an account was found or
 * eligible — only `otpRequired` (always true) tells the caller a code was
 * (maybe) sent; requestPasswordReset never changes a password directly —
 * only resetPasswordWithCode does, after that code is verified.
 */
async requestPasswordReset(
  identifier: string,
  newPassword: string,
): Promise<{ message: string; otpRequired: boolean }> {
  if (newPassword.length < 8) {
    throw new BadRequestException('newPassword must be at least 8 characters.');
  }

  let user = await this.prisma.user.findUnique({ where: { email: identifier } });
  if (!user) {
    try {
      const normalizedPhone = normalizePhone(identifier);
      user = await this.prisma.user.findUnique({ where: { phoneNumber: normalizedPhone } });
    } catch {
      user = null;
    }
  }

  const genericMessage = {
    message:
      "If an account exists, we've sent a reset code to its registered phone number.",
    otpRequired: true,
  };
  if (!user || !user.passwordHash || !user.phoneNumber) {
    return genericMessage;
  }

  await this.otpService.sendPasswordResetCode(user.phoneNumber);
  return genericMessage;
}

/**
 * Verifies the code, then atomically claims its token and updates the
 * password in one transaction. Consumption is the claim itself — an
 * `updateMany` whose WHERE is the eligibility check — not a separate read
 * followed by a write, which would let two concurrent submissions of the
 * same code both pass a "not yet consumed" check before either commits.
 */
async resetPasswordWithCode(
  phoneNumber: string,
  code: string,
  newPassword: string,
): Promise<{ message: string }> {
  if (newPassword.length < 8) {
    throw new BadRequestException('newPassword must be at least 8 characters.');
  }

  const { token } = await this.otpService.verifyCode(phoneNumber, code);
  const tokenRow = await this.otpService.findValidTokenRow(phoneNumber, token);
  if (!tokenRow) {
    throw new BadRequestException('Code expired — request a new one.');
  }
  const passwordHash = await this.hashPassword(newPassword);

  await this.prisma.$transaction(async (tx) => {
    const claimed = await tx.phoneVerification.updateMany({
      where: { id: tokenRow.id, consumedAt: null, tokenExpiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });
    if (claimed.count !== 1) {
      throw new BadRequestException('Code expired — request a new one.');
    }

    const user = await tx.user.findUnique({ where: { phoneNumber } });
    if (!user || !user.passwordHash) {
      throw new BadRequestException('No account found for this number.');
    }

    await tx.user.update({ where: { id: user.id }, data: { passwordHash } });
  });

  logger.info('resetPasswordWithCode: password updated', { phoneNumber });
  return { message: 'Password updated. You can now log in.' };
}
```

Remove `private readonly otpPasswordResetEnabled = false;` and its comment entirely.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/auth/auth.service.spec.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/auth/auth.service.ts src/auth/auth.service.spec.ts
git commit -m "feat: always verify password resets, fix non-atomic code consumption"
```

---

### Task 8: Login accepts email or phone

**Files:**
- Modify: `src/auth/auth.service.ts:16-38,71-110`
- Modify: `src/auth/auth.controller.ts:24-38,52-65` (`LoginDto`, `login()`)
- Modify: `src/auth/auth.service.spec.ts` (new `describe('login', ...)` block — none currently exists)

**Interfaces:**
- Consumes: Task 6's nullable `AuthResponse`/`generateToken`.
- Produces: `AuthService.login(identifier: string, password: string): Promise<AuthResponse>` — Task 11's frontend login form calls this (via `POST /auth/login`, body `{ identifier, password }`).

- [ ] **Step 1: Write the failing test**

Add to `src/auth/auth.service.spec.ts`, after the `describe('createStaff', ...)` block:

```ts
describe('login', () => {
  it('succeeds via email', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'u-1',
      email: 'ada@example.com',
      phoneNumber: null,
      passwordHash: await bcrypt.hash('correct-password', 10),
      name: 'Ada',
      role: 'OPERATOR',
    });

    const result = await service.login('ada@example.com', 'correct-password');

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: 'ada@example.com' },
    });
    expect(result.accessToken).toEqual(expect.any(String));
    expect(result.user).toEqual({
      id: 'u-1',
      email: 'ada@example.com',
      name: 'Ada',
      role: 'OPERATOR',
    });
  });

  it('succeeds via phone when the identifier is not a registered email', async () => {
    prisma.user.findUnique
      .mockResolvedValueOnce(null) // email lookup misses
      .mockResolvedValueOnce({
        id: 'u-1',
        email: null,
        phoneNumber: '+2348012345678',
        passwordHash: await bcrypt.hash('correct-password', 10),
        name: 'Ada',
        role: 'OPERATOR',
      });

    const result = await service.login('+2348012345678', 'correct-password');

    expect(prisma.user.findUnique).toHaveBeenNthCalledWith(2, {
      where: { phoneNumber: '+2348012345678' },
    });
    expect(result.user.email).toBeNull();
  });

  it('succeeds via phone typed in local format (0801...) — the stored value is E.164', async () => {
    prisma.user.findUnique
      .mockResolvedValueOnce(null) // email lookup misses
      .mockResolvedValueOnce({
        id: 'u-1',
        email: null,
        phoneNumber: '+2348012345678',
        passwordHash: await bcrypt.hash('correct-password', 10),
        name: 'Ada',
        role: 'OPERATOR',
      });

    const result = await service.login('08012345678', 'correct-password');

    expect(prisma.user.findUnique).toHaveBeenNthCalledWith(2, {
      where: { phoneNumber: '+2348012345678' },
    });
    expect(result.user.role).toBe('OPERATOR');
  });

  it('rejects cleanly (no crash) when the identifier is neither a known email nor a valid phone shape', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(null); // email lookup misses

    await expect(
      service.login('not-an-email-or-phone', 'whatever'),
    ).rejects.toThrow('Invalid email or password');
    // Only the email lookup ran — normalizePhone threw before a second
    // findUnique could be attempted, and that throw was caught, not
    // left to escape as an unhandled 500.
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
  });

  it('rejects a wrong password on either identifier', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'u-1',
      email: 'ada@example.com',
      passwordHash: await bcrypt.hash('correct-password', 10),
      role: 'OPERATOR',
    });

    await expect(
      service.login('ada@example.com', 'wrong-password'),
    ).rejects.toThrow('Invalid email or password');
  });

  it('rejects when no account matches either lookup', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(
      service.login('nobody@example.com', 'whatever'),
    ).rejects.toThrow('Invalid email or password');
  });
});
```

Add `import * as bcrypt from 'bcrypt';` to the spec file's imports (used to build a real hash for the password-verify assertions — matching how `hashPassword`/`verifyPassword` work in the implementation itself).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/auth/auth.service.spec.ts -t "login"`
Expected: FAIL — `login('ada@example.com', ...)` is currently `login(email, password)` and does look up by email correctly for the first test, but the phone-fallback test fails (`prisma.user.findUnique` only called once today, no phone fallback).

- [ ] **Step 3: Write the implementation**

```ts
async login(identifier: string, password: string): Promise<AuthResponse> {
  let user = await this.prisma.user.findUnique({ where: { email: identifier } });
  if (!user) {
    // identifier may be a phone number typed in local format (0801...)
    // rather than the E.164 form phoneNumber is stored in — normalize
    // before the lookup, same as every other phone-accepting entry point
    // (registerCustomer, operator.service.ts, the OTP login routes below).
    // Not every identifier IS a phone number — it could be a mistyped
    // email — so a normalization failure just means "not a phone either";
    // fall through to the same invalid-credentials rejection below rather
    // than letting normalizePhone's thrown Error escape unhandled.
    try {
      const normalizedPhone = normalizePhone(identifier);
      user = await this.prisma.user.findUnique({ where: { phoneNumber: normalizedPhone } });
    } catch {
      user = null;
    }
  }

  if (!user || !user.passwordHash) {
    logger.warn('login: no account for this identifier', { identifier });
    throw new UnauthorizedException('Invalid email or password');
  }

  const isPasswordValid = await this.verifyPassword(password, user.passwordHash);
  if (!isPasswordValid) {
    logger.warn('login: wrong password', { userId: user.id, role: user.role });
    throw new UnauthorizedException('Invalid email or password');
  }

  logger.info('login: success', { userId: user.id, role: user.role });

  const accessToken = this.generateToken({
    id: user.id,
    email: user.email,
    role: user.role,
  });

  return {
    accessToken,
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
  };
}
```

`src/auth/auth.controller.ts`:

```ts
export class LoginDto {
  identifier: string; // email or phone number
  password: string;
}
```

```ts
@Post('login')
async login(@Body() dto: LoginDto) {
  return this.authService.login(dto.identifier, dto.password);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/auth/auth.service.spec.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/auth/auth.service.ts src/auth/auth.controller.ts src/auth/auth.service.spec.ts
git commit -m "feat: accept email or phone as the login identifier"
```

---

### Task 9: Phone + OTP login (`OPERATOR`-only, atomic claim)

**Files:**
- Create: `src/auth/dto/login-otp.dto.ts`
- Modify: `src/auth/auth.service.ts` (new `sendLoginCode`, `loginWithOtp`)
- Modify: `src/auth/auth.controller.ts` (two new routes)
- Modify: `src/auth/auth.service.spec.ts` (new `describe` blocks)

**Interfaces:**
- Consumes: `OtpService.sendLoginCode` (Task 4), `OtpService.verifyCode`/`findValidTokenRow` (existing), Task 6's nullable `AuthResponse`.
- Produces: `POST /auth/login/otp/send`, `POST /auth/login/otp/verify` — Task 11's frontend OTP login tab calls these.

- [ ] **Step 1: Write the failing test**

Add `sendLoginCode` to the spec file's `otpService` mock declaration (`otpService = { sendPasswordResetCode: jest.fn(), verifyCode: jest.fn(), findValidTokenRow: jest.fn(), sendLoginCode: jest.fn() };`), then add:

```ts
describe('sendLoginCode', () => {
  it('delegates to OtpService.sendLoginCode', async () => {
    otpService.sendLoginCode.mockResolvedValue({ required: true });

    const result = await service.sendLoginCode('+2348012345678');

    expect(otpService.sendLoginCode).toHaveBeenCalledWith('+2348012345678');
    expect(result).toEqual({ required: true });
  });
});

describe('loginWithOtp', () => {
  it('verifies the code, atomically claims it, and issues a token for an OPERATOR', async () => {
    otpService.verifyCode.mockResolvedValue({ token: 'tok-1' });
    otpService.findValidTokenRow.mockResolvedValue({ id: 'pv-1' });
    const tx = {
      phoneVerification: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'u-1',
          email: null,
          phoneNumber: '+2348012345678',
          name: 'Jane',
          role: 'OPERATOR',
        }),
      },
    };
    prisma.$transaction.mockImplementation((cb: any) => cb(tx));

    const result = await service.loginWithOtp('+2348012345678', '123456');

    expect(otpService.verifyCode).toHaveBeenCalledWith('+2348012345678', '123456');
    expect(tx.phoneVerification.updateMany).toHaveBeenCalledWith({
      where: { id: 'pv-1', consumedAt: null, tokenExpiresAt: { gt: expect.any(Date) } },
      data: { consumedAt: expect.any(Date) },
    });
    expect(result.accessToken).toEqual(expect.any(String));
    expect(result.user.role).toBe('OPERATOR');
  });

  it('rejects a CUSTOMER account even with a valid, unconsumed code', async () => {
    otpService.verifyCode.mockResolvedValue({ token: 'tok-1' });
    otpService.findValidTokenRow.mockResolvedValue({ id: 'pv-1' });
    const tx = {
      phoneVerification: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'u-1',
          role: 'CUSTOMER',
        }),
      },
    };
    prisma.$transaction.mockImplementation((cb: any) => cb(tx));

    await expect(
      service.loginWithOtp('+2348012345678', '123456'),
    ).rejects.toThrow('No account found for this number.');
  });

  it('rejects when the claim matches zero rows', async () => {
    otpService.verifyCode.mockResolvedValue({ token: 'tok-1' });
    otpService.findValidTokenRow.mockResolvedValue({ id: 'pv-1' });
    const tx = {
      phoneVerification: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      user: { findUnique: jest.fn() },
    };
    prisma.$transaction.mockImplementation((cb: any) => cb(tx));

    await expect(
      service.loginWithOtp('+2348012345678', '123456'),
    ).rejects.toThrow('Code expired — request a new one.');
    expect(tx.user.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a second call with the same already-consumed code', async () => {
    otpService.verifyCode.mockResolvedValue({ token: 'tok-1' });
    otpService.findValidTokenRow.mockResolvedValue({ id: 'pv-1' });
    const tx = {
      phoneVerification: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      user: { findUnique: jest.fn() },
    };
    prisma.$transaction.mockImplementation((cb: any) => cb(tx));

    await expect(
      service.loginWithOtp('+2348012345678', '123456'),
    ).rejects.toThrow('Code expired — request a new one.');
  });

  it('rejects when no valid token row is found', async () => {
    otpService.verifyCode.mockResolvedValue({ token: 'tok-1' });
    otpService.findValidTokenRow.mockResolvedValue(null);

    await expect(
      service.loginWithOtp('+2348012345678', '123456'),
    ).rejects.toThrow('Code expired — request a new one.');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/auth/auth.service.spec.ts -t "loginWithOtp|sendLoginCode"`
Expected: FAIL — `service.sendLoginCode is not a function`, `service.loginWithOtp is not a function`

- [ ] **Step 3: Write the implementation**

```ts
// src/auth/dto/login-otp.dto.ts
import { IsNotEmpty, IsString, Length } from 'class-validator';

export class SendLoginCodeDto {
  @IsString()
  @IsNotEmpty()
  phoneNumber: string;
}

export class VerifyLoginCodeDto {
  @IsString()
  @IsNotEmpty()
  phoneNumber: string;

  @IsString()
  @Length(6, 6)
  code: string;
}
```

`src/auth/auth.service.ts`:

```ts
async sendLoginCode(phoneNumber: string): Promise<{ required: boolean }> {
  return this.otpService.sendLoginCode(phoneNumber);
}

/**
 * Phone + OTP login, restricted to OPERATOR (see OtpService.sendLoginCode's
 * doc comment for why). Consumption is the claim, not a read-then-write —
 * see resetPasswordWithCode for the same pattern and why it matters. The
 * role is re-checked here, at the point access is actually granted, not
 * only relied on at send time.
 */
async loginWithOtp(phoneNumber: string, code: string): Promise<AuthResponse> {
  const { token } = await this.otpService.verifyCode(phoneNumber, code);
  const tokenRow = await this.otpService.findValidTokenRow(phoneNumber, token);
  if (!tokenRow) {
    throw new UnauthorizedException('Code expired — request a new one.');
  }

  return this.prisma.$transaction(async (tx) => {
    const claimed = await tx.phoneVerification.updateMany({
      where: { id: tokenRow.id, consumedAt: null, tokenExpiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });
    if (claimed.count !== 1) {
      throw new UnauthorizedException('Code expired — request a new one.');
    }

    const user = await tx.user.findUnique({ where: { phoneNumber } });
    if (!user || user.role !== UserRole.OPERATOR) {
      throw new UnauthorizedException('No account found for this number.');
    }

    const accessToken = this.generateToken({
      id: user.id,
      email: user.email,
      role: user.role,
    });
    return {
      accessToken,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    };
  });
}
```

`src/auth/auth.controller.ts`:

```ts
import { SendLoginCodeDto, VerifyLoginCodeDto } from './dto/login-otp.dto';
// ...
@Post('login/otp/send')
async sendLoginCode(@Body() dto: SendLoginCodeDto) {
  return this.authService.sendLoginCode(normalizePhone(dto.phoneNumber));
}

@Post('login/otp/verify')
async loginWithOtp(@Body() dto: VerifyLoginCodeDto) {
  return this.authService.loginWithOtp(normalizePhone(dto.phoneNumber), dto.code);
}
```

Confirm `normalizePhone` is already imported in `auth.controller.ts` — it isn't today (only used in `auth.service.ts`); add `import { normalizePhone } from '../common/phone.util';`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsc --noEmit && npx jest src/auth/auth.service.spec.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/auth/dto/login-otp.dto.ts src/auth/auth.service.ts src/auth/auth.controller.ts src/auth/auth.service.spec.ts
git commit -m "feat: add OPERATOR-only phone+OTP login with atomic code consumption"
```

---

### Task 10: Run the full backend suite before moving to the frontend

**Files:** none (verification-only task)

- [ ] **Step 1: Full typecheck, lint, and test suite**

Run: `npx tsc --noEmit && npx eslint "{src,apps,libs,test}/**/*.ts" && npx jest --ci`
Expected: PASS. If lint's `--max-warnings` ratchet is exceeded, follow the `merge-to-staging` skill's guidance (`.claude/skills/merge-to-staging/SKILL.md` at the `repos/` root): find exactly which warnings are new versus pre-existing before touching anything, fix at the source, never raise the ceiling.

- [ ] **Step 2: Integration suite, against a real Postgres**

Bring up the throwaway test database and run the integration suite (per this repo's `docker-compose.test.yml` and `test:integration` script):

```bash
docker compose -f docker-compose.test.yml up -d
# poll until healthy, then:
DATABASE_URL="postgresql://lrr:lrr@localhost:5433/lrr_test" npx jest --config ./test/integration/jest-integration.json --runInBand
docker compose -f docker-compose.test.yml down
```

Expected: PASS. No integration spec in this repo currently exercises `OperatorService.create()`, `AuthService.login`, or the OTP flows directly (confirm via `grep -rl "operator.service\|auth.service\|otp.service" test/integration/` before assuming — if one does exist and asserts old behavior, e.g. a fresh signup succeeding without a `phoneVerificationToken`, fix it the same way Task 5's unit tests were fixed, not by reverting the feature).

- [ ] **Step 3: No commit** — this task only verifies; nothing here changes files unless Step 2 turns up a stale integration test, in which case fix it and commit that fix alone with a message describing what was stale (mirroring how the `payment-verify` reconciler fix handled its own stale integration test earlier this project).

---

### Task 11: Frontend — `app/register/page.tsx` email optional

**Files:**
- Modify: `lrr-web/app/register/page.tsx:233-236,576` (client validation, step-3 copy)
- Modify: `lrr-web/app/types.ts:63-78` (`RegisterOperatorRequest.email`)

**Interfaces:**
- Consumes: Task 5's backend change (email optional, phone verification mandatory — the OTP block on this page already handles the latter with no changes needed, per the spec's Background).

- [ ] **Step 1: (No automated frontend test infra exists in this codebase — verified manually in Step 3, per the established convention from the 2026-08-19 forgot-password work.)**

- [ ] **Step 2: Make the change**

`app/types.ts`:

```ts
export interface RegisterOperatorRequest {
  name: string;
  businessName: string;
  contactName: string;
  phoneNumber: string;
  businessPhoneNumber: string;
  email?: string;
  password: string;
  type: OperatorType;
  address: string;
  latitude: number;
  longitude: number;
  truckClasses: TruckClass[];
  serviceRadius: number;
  phoneVerificationToken: string; // was optional — see Task 5, now mandatory for every signup
}
```

`app/register/page.tsx` — drop the hard email requirement (line 233-236):

```ts
if (!formData.password) {
  setError("Please fill in your password");
  return;
}
```

Update the payload construction (line ~257) so `email` is only sent when present, and `phoneVerificationToken` is no longer conditionally `undefined` (it's mandatory now — the existing OTP block already blocks form submission via `if (otpRequired && !otpVerified) return;` earlier in the same handler, so by the time this payload is built, `otpVerified` is guaranteed true whenever `otpRequired` was true, and per Task 3's backend change `otpRequired` is now always true for a fresh phone):

```ts
const payload: RegisterOperatorRequest = {
  name: formData.contactName,
  businessName: formData.businessName,
  contactName: formData.contactName,
  phoneNumber: formData.phoneNumber,
  businessPhoneNumber: formData.businessPhoneNumber,
  type: formData.operatorType,
  email: formData.email || undefined,
  password: formData.password,
  address: address,
  latitude: latLng.lat,
  longitude: latLng.lng,
  truckClasses: formData.truckClasses,
  serviceRadius: Number(formData.serviceRadius),
  phoneVerificationToken: otpToken,
};
```

Update step 3's copy (around line 576) — find the `<Step n={3} ... subtitle="You'll use this email and password to log in to your dashboard.">` and change the subtitle to:

```
subtitle="You'll use this to log in — add an email too if you'd like a backup way in."
```

Also find and remove the `required` attribute on the email `<input type="email" name="email" ...>` a few lines below (if present) so the browser doesn't block submission on an empty email field.

- [ ] **Step 3: Manual verification**

Run: `npx tsc --noEmit` (in `lrr-web`), then start the dev server and walk through operator registration with the email field left blank — confirm the OTP step still appears and blocks submission until verified, and that submission succeeds with the payload's `email` field simply absent.

- [ ] **Step 4: Commit**

```bash
git add app/register/page.tsx app/types.ts
git commit -m "feat: make email optional on operator registration"
```

---

### Task 12: Frontend — phone/email + OTP login

**Files:**
- Modify: `lrr-web/app/hooks/useAuthApi.ts:71-95` (`login`, plus two new functions)
- Modify: `lrr-web/app/components/LoginModal.tsx`

**Interfaces:**
- Consumes: Task 8's `POST /auth/login` (body `{ identifier, password }`), Task 9's `POST /auth/login/otp/send` and `POST /auth/login/otp/verify`.

- [ ] **Step 1: (No automated frontend test infra — verified manually in Step 3.)**

- [ ] **Step 2: Make the change**

`app/hooks/useAuthApi.ts` — rename `login`'s first parameter and add two new functions alongside it:

```ts
const login = useCallback(async (identifier: string, password: string) => {
  setLoading(true);
  setError(null);
  try {
    const data = await apiFetch("/auth/login", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ identifier, password }),
    });
    if (data.accessToken && data.user) {
      writeSession(
        data.accessToken,
        data.user.role,
        resolveDisplayName(data.user, data.user.role === "CUSTOMER" ? "Customer" : "User"),
      );
    }
    return data as { accessToken: string; user: User };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Login failed";
    setError(msg);
    throw err;
  } finally {
    setLoading(false);
  }
}, []);

const sendLoginCode = useCallback(async (phoneNumber: string) => {
  setError(null);
  try {
    return await apiFetch("/auth/login/otp/send", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ phoneNumber }),
    }) as { required: boolean };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to send code";
    setError(msg);
    throw err;
  }
}, []);

const loginWithOtp = useCallback(async (phoneNumber: string, code: string) => {
  setLoading(true);
  setError(null);
  try {
    const data = await apiFetch("/auth/login/otp/verify", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ phoneNumber, code }),
    });
    if (data.accessToken && data.user) {
      writeSession(
        data.accessToken,
        data.user.role,
        resolveDisplayName(data.user, "User"),
      );
    }
    return data as { accessToken: string; user: User };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Invalid or expired code";
    setError(msg);
    throw err;
  } finally {
    setLoading(false);
  }
}, []);
```

Add `sendLoginCode` and `loginWithOtp` to the hook's returned object (alongside the existing `login`).

`app/components/LoginModal.tsx` — add a mode toggle between the existing password form and a new OTP flow, reusing the file's existing inline-style variables (`dm`, `fraunces`, the input/button style objects already defined inline in the file):

```tsx
const { login, sendLoginCode, loginWithOtp } = useAuthApi();
const [mode, setMode] = useState<"password" | "otp">("password");
const [phone, setPhone] = useState("");
const [otpCode, setOtpCode] = useState("");
const [otpSent, setOtpSent] = useState(false);
```

Reset the OTP-specific state alongside the existing `error` reset in the modal-open effect:

```ts
useEffect(() => {
  if (open) {
    setError("");
    setMode("password");
    setOtpSent(false);
    setOtpCode("");
    setPhone("");
    setTimeout(() => emailRef.current?.focus(), 80);
  }
}, [open]);
```

Add a mode-toggle control above the form, and branch the form body:

```tsx
<div style={{ display: "flex", gap: 8, marginBottom: "0.5rem" }}>
  <button
    type="button"
    onClick={() => setMode("password")}
    style={{
      flex: 1, padding: "0.5rem", borderRadius: 8, border: "1px solid #e2e8f0",
      background: mode === "password" ? "#003DB4" : "#f7f9fc",
      color: mode === "password" ? "#fff" : "#07152f",
      fontFamily: dm, fontWeight: 600, fontSize: "0.85rem", cursor: "pointer",
    }}
  >
    Password
  </button>
  <button
    type="button"
    onClick={() => setMode("otp")}
    style={{
      flex: 1, padding: "0.5rem", borderRadius: 8, border: "1px solid #e2e8f0",
      background: mode === "otp" ? "#003DB4" : "#f7f9fc",
      color: mode === "otp" ? "#fff" : "#07152f",
      fontFamily: dm, fontWeight: 600, fontSize: "0.85rem", cursor: "pointer",
    }}
  >
    Phone code
  </button>
</div>
```

Password-mode form (existing form, relabel the email input rather than rewriting it):

```tsx
<input
  ref={emailRef}
  type="text"
  placeholder="Email or phone"
  value={email}
  onChange={e => setEmail(e.target.value)}
  required
  style={{ /* ...unchanged existing style object... */ }}
/>
```

`handleSubmit` calls `login(email, password)` already — the identifier rename is purely on the backend/hook side, no change needed at this call site beyond what the hook already does.

OTP-mode form, rendered when `mode === "otp"` instead of the password form:

```tsx
{mode === "otp" && (
  <div style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
    <input
      type="tel"
      placeholder="Phone number"
      value={phone}
      onChange={e => setPhone(e.target.value)}
      disabled={otpSent}
      style={{ /* same input style object as the password/email input above */ }}
    />
    {!otpSent ? (
      <button
        type="button"
        onClick={async () => {
          setError("");
          try {
            await sendLoginCode(phone);
            setOtpSent(true);
          } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to send code");
          }
        }}
        style={{ /* same primary-button style object used for the Sign in button */ }}
      >
        Send code
      </button>
    ) : (
      <>
        <input
          type="text"
          placeholder="6-digit code"
          value={otpCode}
          onChange={e => setOtpCode(e.target.value)}
          maxLength={6}
          style={{ /* same input style object */ }}
        />
        {error && <p style={{ margin: 0, color: "#e53e3e", fontSize: "0.88rem" }}>{error}</p>}
        <button
          type="button"
          disabled={loading}
          onClick={async () => {
            setLoading(true);
            setError("");
            try {
              await loginWithOtp(phone, otpCode);
              const destination = next || "/dashboard";
              onClose();
              router.push(destination);
            } catch (err) {
              setError(err instanceof Error ? err.message : "Invalid or expired code");
            } finally {
              setLoading(false);
            }
          }}
          style={{ /* same primary-button style object used for the Sign in button */ }}
        >
          {loading ? "Verifying…" : "Verify & sign in"}
        </button>
      </>
    )}
  </div>
)}
```

- [ ] **Step 3: Manual verification**

Run: `npx tsc --noEmit` (in `lrr-web`), then in the dev server: log in with email+password (existing path, must still work unchanged), log in with phone+password for an operator that has one set, and walk the phone+OTP path end to end (send code, receive the SMS via Termii in a non-production environment or a logged/dev fallback, enter it, confirm redirect to `/dashboard`).

- [ ] **Step 4: Commit**

```bash
git add app/hooks/useAuthApi.ts app/components/LoginModal.tsx
git commit -m "feat: add phone/email and OTP login modes to the login modal"
```

---

## Self-Review

**Spec coverage:** §1 (Termii module) → Task 1. §2 (channel swap) → Task 2. §3 (universal signup verification) → Task 3, Task 5. §4 (`CreateOperatorDto`) → Task 5. §5 (flag removal) → Task 5 (`otpUpgradeEnabled`), Task 7 (`otpPasswordResetEnabled`). §6 (login — identifier/password, OTP, atomicity, role-gating, enumeration) → Task 4, Task 8, Task 9. §7 (nullable email) → Task 6. §8 (DTOs/routes) → Task 9. Frontend section → Task 11, Task 12. Testing section's per-file breakdown → covered across the matching backend tasks; the "no e2e infra" note → Tasks 11-12's manual-verification steps.

**Placeholder scan:** no TBD/TODO markers; every step carries complete code, not a description of code. (Two `// ...unchanged body...` placeholders were found in an earlier draft of Task 7's tests during this same review pass and replaced with their real bodies — see the local-format test added right next to them.)

**Type consistency:** `TermiiService.sendSms(phone: string, message: string): Promise<void>` — same signature used in Task 1's test and Task 2's call site. `OtpService.sendLoginCode(phoneNumber: string): Promise<{ required: boolean }>` — same in Task 4 and consumed identically in Task 9. `AuthResponse`/`JwtPayload`'s `email: string | null` (Task 6) is used consistently in Task 8 and Task 9's `loginWithOtp`/`login` return shapes — no call site reintroduces a non-null assertion. `CreateOperatorDto.phoneVerificationToken: string` (required, Task 5) matches `RegisterOperatorRequest.phoneVerificationToken: string` (required, Task 11) — frontend and backend agree.

**Consistency pass on the two review findings:** the atomic-claim pattern is now identical in all three places it's used — `resetPasswordWithCode` (Task 7), `loginWithOtp` (Task 9), and both branches of `OperatorService.create()` (Task 5) all `updateMany` on `{ id, consumedAt: null, tokenExpiresAt: { gt: now } }` and check `count === 1`/`count !== 1`, with no leftover separate `.update()` call after it anywhere. The normalize-then-fall-through-on-throw pattern is now identical in the two places it's needed — `AuthService.login` (Task 8) and `requestPasswordReset` (Task 7) — both try `normalizePhone(identifier)` only after the email lookup misses, and both treat a throw as "not a phone either," never letting it escape as an unhandled error. Task 9's OTP routes needed no change — they already normalized at the controller boundary, which is what first made the gap in `login`/`requestPasswordReset` visible as an inconsistency rather than a uniform gap.
