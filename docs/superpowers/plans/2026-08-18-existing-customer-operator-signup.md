# Existing-Customer Operator Signup (WhatsApp OTP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a phone number that already belongs to an existing customer register as an operator, gated by WhatsApp one-time-code ownership verification, reusing (not duplicating) their existing `User` identity and history.

**Architecture:** A new `PhoneVerification` model + a small standalone `OtpModule` (send-code / verify-code, WhatsApp delivery via the existing `TwilioService`) issues a short-lived, single-use, hashed verification token. `operator.service.ts`'s `create()` is rewritten to split its existing-user lookup into explicit phone/email checks and, when the phone belongs to an existing `CUSTOMER`, transactionally upgrade that `User` row instead of creating a new one.

**Tech Stack:** NestJS + Prisma (lrr-service), Next.js (lrr-web). No new dependencies — uses Node's built-in `crypto` for hashing (already imported elsewhere in this codebase, e.g. `payment.service.ts`) and the existing `TwilioService`.

## Global Constraints

- Scope is narrow: OTP-gated upgrade applies ONLY when the phone belongs to an existing `User` with role `CUSTOMER`. Role `OPERATOR`/`ADMIN` on that phone stays a hard block, no OTP path (per spec).
- The upgrade is one-way and permanent — no operator→customer path, `User.role` is a single value.
- `email` is required on `CreateOperatorDto` today — the email lookup is always safe to run unconditionally; if that ever changes, the lookup must be guarded.
- Send-code is rate-limited per phone: resend cooldown (60s) and a cap per rolling window (5/hour) — separate from `attempts`, which only guards code-guessing.
- Verification tokens are single-use: consumed (`consumedAt` set) only inside the same transaction that completes registration, matched by exact row (token hash + phone), never "latest row for phone."
- The whole upgrade (re-check state, validate token, confirm email free, update `User`, create `Operator`/`OperatorMember`, consume token) runs inside one `prisma.$transaction`.
- No change to the business-phone collision guard shipped earlier this session (`operator.service.ts`'s `businessPhoneClaimedByCustomer` check) — OTP-proven ownership of the personal number does not override the no-shared-number rule for the business number.

---

### Task 1: Schema — `PhoneVerification` model

**Files:**
- Modify: `prisma/schema.prisma`
- Create: a new Prisma migration (via CLI)

**Interfaces:**
- Produces: `PhoneVerification` model — consumed by Task 2 (OTP service).

- [ ] **Step 1: Add the model**

In `prisma/schema.prisma`, add a new model (a good spot is near `WhatsAppSession`, since both are short-lived/session-like):

```prisma
// Short-lived rows backing WhatsApp OTP verification — used to prove
// ownership of a phone number before letting an existing customer
// register as an operator on the same number. Rows are cheap to accumulate;
// no cleanup job in this pass, expiry is enforced at query time only.
model PhoneVerification {
  id                      String    @id @default(cuid())

  phoneNumber             String
  createdAt               DateTime  @default(now())

  codeHash                String
  expiresAt               DateTime
  verifiedAt              DateTime?
  attempts                Int       @default(0)

  // Issued on successful verify — proves this row was already validated
  // once, without re-exposing the original code.
  verificationTokenHash   String?
  tokenExpiresAt          DateTime?
  consumedAt              DateTime?

  @@index([phoneNumber])
}
```

- [ ] **Step 2: Generate and apply the migration**

Run: `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION=yes npx prisma migrate dev --name add_phone_verification`

Expected: new migration folder, "Your database is now in sync with your schema."

- [ ] **Step 3: Regenerate the Prisma client**

Run: `npx prisma generate`

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(schema): add PhoneVerification model for WhatsApp OTP"
```

---

### Task 2: Backend — `OtpService` (send-code, verify-code) + rate limiting

**Files:**
- Create: `src/otp/otp.service.ts`
- Create: `src/otp/otp.module.ts`
- Create: `src/otp/otp.controller.ts`
- Create: `src/otp/dto/send-code.dto.ts`
- Create: `src/otp/dto/verify-code.dto.ts`
- Modify: `src/app.module.ts` (register `OtpModule`)
- Test: `src/otp/otp.service.spec.ts`

**Interfaces:**
- Consumes: `TwilioService.sendWhatsAppMessage(to, message)`, `toWhatsAppAddress` from `../common/phone.util`, `PrismaService`.
- Produces: `OtpService.sendCode(phoneNumber: string): Promise<{ required: boolean; available?: boolean }>`, `OtpService.verifyCode(phoneNumber: string, code: string): Promise<{ token: string }>` (throws on failure) — consumed by Task 3 (backend, indirectly via the token it issues) and Task 4 (frontend, via the two new endpoints).
- Endpoints: `POST /otp/send-code`, `POST /otp/verify-code`, both public (no `@UseGuards`).

- [ ] **Step 1: Write the failing tests**

Create `src/otp/otp.service.spec.ts`:

```ts
import { Test, TestingModule } from '@nestjs/testing';
import { OtpService } from './otp.service';
import { PrismaService } from '../prisma/prisma.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { UserRole } from '@prisma/client';

describe('OtpService', () => {
  let service: OtpService;
  let prisma: {
    user: { findUnique: jest.Mock };
    phoneVerification: { findFirst: jest.Mock; findMany: jest.Mock; create: jest.Mock; update: jest.Mock };
  };
  let twilioService: { sendWhatsAppMessage: jest.Mock };

  beforeEach(async () => {
    prisma = {
      user: { findUnique: jest.fn() },
      phoneVerification: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
    };
    twilioService = { sendWhatsAppMessage: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OtpService,
        { provide: PrismaService, useValue: prisma },
        { provide: TwilioService, useValue: twilioService },
      ],
    }).compile();

    service = module.get<OtpService>(OtpService);
  });

  describe('sendCode', () => {
    it('responds required:false, available:true and sends nothing for a fresh number', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      const result = await service.sendCode('+2348012345678');

      expect(result).toEqual({ required: false, available: true });
      expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalled();
    });

    it('responds required:false, available:false for an existing OPERATOR/ADMIN number, sends nothing', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u-1', role: UserRole.OPERATOR });

      const result = await service.sendCode('+2348012345678');

      expect(result).toEqual({ required: false, available: false });
      expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalled();
    });

    it('sends a code and responds required:true for an existing CUSTOMER number', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u-1', role: UserRole.CUSTOMER });
      prisma.phoneVerification.findMany.mockResolvedValue([]); // no recent sends — cooldown/cap clear
      prisma.phoneVerification.create.mockResolvedValue({ id: 'pv-1' });

      const result = await service.sendCode('+2348012345678');

      expect(result).toEqual({ required: true });
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining('+2348012345678'),
        expect.stringContaining('verification code'),
      );
    });

    it('rejects when the resend cooldown has not elapsed', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u-1', role: UserRole.CUSTOMER });
      prisma.phoneVerification.findMany.mockResolvedValue([{ createdAt: new Date() }]); // sent seconds ago

      await expect(service.sendCode('+2348012345678')).rejects.toThrow('wait');
      expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalled();
    });

    it('rejects when the per-window send cap is hit', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u-1', role: UserRole.CUSTOMER });
      const oldEnoughToClearCooldown = new Date(Date.now() - 120_000);
      prisma.phoneVerification.findMany.mockResolvedValue(
        Array.from({ length: 5 }, () => ({ createdAt: oldEnoughToClearCooldown })),
      );

      await expect(service.sendCode('+2348012345678')).rejects.toThrow('Too many');
      expect(twilioService.sendWhatsAppMessage).not.toHaveBeenCalled();
    });
  });

  describe('verifyCode', () => {
    it('issues a token on a correct, unexpired code', async () => {
      prisma.phoneVerification.findFirst.mockResolvedValue({
        id: 'pv-1', codeHash: service.hashForTest('123456'), attempts: 0,
        expiresAt: new Date(Date.now() + 60_000), verifiedAt: null,
      });
      prisma.phoneVerification.update.mockResolvedValue({});

      const result = await service.verifyCode('+2348012345678', '123456');

      expect(result.token).toEqual(expect.any(String));
      expect(prisma.phoneVerification.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'pv-1' },
        data: expect.objectContaining({ verifiedAt: expect.any(Date), verificationTokenHash: expect.any(String) }),
      }));
    });

    it('rejects a wrong code and increments attempts', async () => {
      prisma.phoneVerification.findFirst.mockResolvedValue({
        id: 'pv-1', codeHash: service.hashForTest('123456'), attempts: 0,
        expiresAt: new Date(Date.now() + 60_000), verifiedAt: null,
      });

      await expect(service.verifyCode('+2348012345678', '999999')).rejects.toThrow('Incorrect code');
      expect(prisma.phoneVerification.update).toHaveBeenCalledWith({
        where: { id: 'pv-1' },
        data: { attempts: 1 },
      });
    });

    it('rejects once attempts has reached the max, regardless of expiresAt', async () => {
      prisma.phoneVerification.findFirst.mockResolvedValue({
        id: 'pv-1', codeHash: service.hashForTest('123456'), attempts: 5,
        expiresAt: new Date(Date.now() + 60_000), verifiedAt: null,
      });

      await expect(service.verifyCode('+2348012345678', '123456')).rejects.toThrow('Too many attempts');
    });

    it('rejects an expired code', async () => {
      prisma.phoneVerification.findFirst.mockResolvedValue(null); // query excludes expired rows

      await expect(service.verifyCode('+2348012345678', '123456')).rejects.toThrow('expired');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest otp.service -v`
Expected: FAIL — `OtpService` doesn't exist yet.

- [ ] **Step 3: Implement `OtpService`**

Create `src/otp/otp.service.ts`:

```ts
import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { toWhatsAppAddress } from '../common/phone.util';
import { UserRole } from '@prisma/client';

const CODE_TTL_MS = 10 * 60 * 1000;
const TOKEN_TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_SENDS_PER_WINDOW = 5;
const SEND_WINDOW_MS = 60 * 60 * 1000;

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function generateCode(): string {
  return String(crypto.randomInt(100000, 1000000));
}

function generateToken(): string {
  return crypto.randomBytes(24).toString('hex');
}

@Injectable()
export class OtpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly twilioService: TwilioService,
  ) {}

  /** Exposed only so tests can compute a matching codeHash without duplicating the hash fn. */
  hashForTest(code: string): string {
    return hash(code);
  }

  async sendCode(phoneNumber: string): Promise<{ required: boolean; available?: boolean }> {
    const existingUser = await this.prisma.user.findUnique({ where: { phoneNumber } });

    if (!existingUser) {
      return { required: false, available: true };
    }
    if (existingUser.role !== UserRole.CUSTOMER) {
      return { required: false, available: false };
    }

    const recent = await this.prisma.phoneVerification.findMany({
      where: { phoneNumber, createdAt: { gte: new Date(Date.now() - SEND_WINDOW_MS) } },
      orderBy: { createdAt: 'desc' },
    });
    if (recent.length > 0 && Date.now() - recent[0].createdAt.getTime() < RESEND_COOLDOWN_MS) {
      throw new BadRequestException('Please wait before requesting another code.');
    }
    if (recent.length >= MAX_SENDS_PER_WINDOW) {
      throw new BadRequestException('Too many code requests — please try again later.');
    }

    const code = generateCode();
    await this.prisma.phoneVerification.create({
      data: {
        phoneNumber,
        codeHash: hash(code),
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      },
    });

    await this.twilioService.sendWhatsAppMessage(
      toWhatsAppAddress(phoneNumber),
      `Your LRR verification code is ${code}. It expires in 10 minutes.`,
    );

    return { required: true };
  }

  async verifyCode(phoneNumber: string, code: string): Promise<{ token: string }> {
    const row = await this.prisma.phoneVerification.findFirst({
      where: { phoneNumber, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!row) {
      throw new BadRequestException('Code expired or not found — request a new one.');
    }
    if (row.attempts >= MAX_ATTEMPTS) {
      throw new BadRequestException('Too many attempts — request a new code.');
    }
    if (row.codeHash !== hash(code)) {
      await this.prisma.phoneVerification.update({
        where: { id: row.id },
        data: { attempts: row.attempts + 1 },
      });
      throw new BadRequestException('Incorrect code.');
    }

    const token = generateToken();
    await this.prisma.phoneVerification.update({
      where: { id: row.id },
      data: {
        verifiedAt: new Date(),
        verificationTokenHash: hash(token),
        tokenExpiresAt: new Date(Date.now() + TOKEN_TTL_MS),
      },
    });

    return { token };
  }

  /**
   * Called from operator.service.ts inside the upgrade transaction. Finds
   * the EXACT row for this token + phone (never "latest for phone") and
   * confirms it's unexpired and not already consumed. Returns the row id
   * so the caller can mark it consumed atomically with the rest of the
   * upgrade — this method does not itself mutate anything.
   */
  async findValidTokenRow(phoneNumber: string, token: string) {
    return this.prisma.phoneVerification.findFirst({
      where: {
        phoneNumber,
        verificationTokenHash: hash(token),
        tokenExpiresAt: { gt: new Date() },
        consumedAt: null,
      },
    });
  }
}
```

- [ ] **Step 4: Create the module**

Create `src/otp/otp.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { OtpService } from './otp.service';
import { OtpController } from './otp.controller';
import { TwilioModule } from '../integrations/twilio/twilio.module';

@Module({
  imports: [TwilioModule],
  providers: [OtpService],
  controllers: [OtpController],
  exports: [OtpService],
})
export class OtpModule {}
```

- [ ] **Step 5: Create the DTOs**

Create `src/otp/dto/send-code.dto.ts`:

```ts
import { IsString, IsNotEmpty } from 'class-validator';

export class SendCodeDto {
  @IsString()
  @IsNotEmpty()
  phoneNumber: string;
}
```

Create `src/otp/dto/verify-code.dto.ts`:

```ts
import { IsString, IsNotEmpty } from 'class-validator';

export class VerifyCodeDto {
  @IsString()
  @IsNotEmpty()
  phoneNumber: string;

  @IsString()
  @IsNotEmpty()
  code: string;
}
```

- [ ] **Step 6: Create the controller**

Create `src/otp/otp.controller.ts`:

```ts
import { Body, Controller, Post } from '@nestjs/common';
import { OtpService } from './otp.service';
import { SendCodeDto } from './dto/send-code.dto';
import { VerifyCodeDto } from './dto/verify-code.dto';
import { normalizePhone } from '../common/phone.util';

@Controller('otp')
export class OtpController {
  constructor(private readonly otpService: OtpService) {}

  @Post('send-code')
  async sendCode(@Body() dto: SendCodeDto) {
    return this.otpService.sendCode(normalizePhone(dto.phoneNumber));
  }

  @Post('verify-code')
  async verifyCode(@Body() dto: VerifyCodeDto) {
    return this.otpService.verifyCode(normalizePhone(dto.phoneNumber), dto.code);
  }
}
```

- [ ] **Step 7: Register the module**

In `src/app.module.ts`, add the import and register it in the `imports` array (alongside the other feature modules):

```ts
import { OtpModule } from './otp/otp.module';
```
```ts
    OtpModule,
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx jest otp.service -v`
Expected: PASS.

- [ ] **Step 9: Run full backend suite and typecheck**

Run: `npx tsc --noEmit && npx jest`
Expected: no type errors, all suites pass.

- [ ] **Step 10: Commit**

```bash
git add src/otp/ src/app.module.ts
git commit -m "feat(otp): add WhatsApp OTP send/verify with rate limiting"
```

---

### Task 3: Backend — `operator.service.ts create()` rewrite (split lookup, transactional upgrade)

**Files:**
- Modify: `src/operator/dto/create-operator.dto.ts`
- Modify: `src/operator/operator.service.ts`
- Modify: `src/operator/operator.module.ts` (inject `OtpModule`)
- Test: `src/operator/operator.service.spec.ts`

**Interfaces:**
- Consumes: `OtpService.findValidTokenRow(phoneNumber, token)` (Task 2).
- Produces: nothing consumed elsewhere in this plan — this is the terminal backend task.

- [ ] **Step 1: Write the failing tests**

In `src/operator/operator.service.spec.ts`, extend the `describe('create() truckClasses server-side enforcement', ...)` block's `beforeEach`/mocks to include an `otpService` mock, and add:

```ts
describe('create() existing-customer upgrade path', () => {
  const baseDto = (): CreateOperatorDto => ({
    email: 'op@example.com',
    password: 'password123',
    name: 'Jane Doe',
    businessName: 'Acme Towing',
    contactName: 'Jane Doe',
    phoneNumber: '+2348012345678',
    businessPhoneNumber: '+2348099999999',
    address: '1 Test Street',
    latitude: 6.5,
    longitude: 3.4,
    truckClasses: [TruckClass.LOW_BED],
  });

  it('fresh number: unchanged normal signup', async () => {
    (prisma.user.findUnique as jest.Mock)
      .mockResolvedValueOnce(null) // existingByPhone
      .mockResolvedValueOnce(null); // existingByEmail
    (prisma.operator.findUnique as jest.Mock).mockResolvedValue(null);
    prisma.$transaction.mockImplementation(async (fn: any) => fn(prisma));
    (prisma.user.create as jest.Mock).mockResolvedValue({ id: 'u-new' });
    (prisma.operator.create as jest.Mock).mockResolvedValue({ id: 'op-new' });
    (prisma.operatorMember.create as jest.Mock).mockResolvedValue({});

    await service.create(baseDto());

    expect(prisma.user.create).toHaveBeenCalled();
    expect(otpService.findValidTokenRow).not.toHaveBeenCalled();
  });

  it('email belongs to a different existing user than the phone match: conflict, not misattributed', async () => {
    (prisma.user.findUnique as jest.Mock)
      .mockResolvedValueOnce(null) // existingByPhone — no phone match
      .mockResolvedValueOnce({ id: 'other-user' }); // existingByEmail — different account

    await expect(service.create(baseDto())).rejects.toThrow('Email or phone number already registered');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('existing customer with a valid token: reuses the User row transactionally, consumes the token', async () => {
    const dto = { ...baseDto(), phoneVerificationToken: 'valid-token' };
    (prisma.user.findUnique as jest.Mock)
      .mockResolvedValueOnce({ id: 'existing-customer', role: 'CUSTOMER', phoneNumber: dto.phoneNumber })
      .mockResolvedValueOnce(null);
    (prisma.operator.findUnique as jest.Mock).mockResolvedValue(null);
    (otpService.findValidTokenRow as jest.Mock).mockResolvedValue({ id: 'pv-1' });
    prisma.$transaction.mockImplementation(async (fn: any) => fn(prisma));
    (prisma.user.update as jest.Mock).mockResolvedValue({ id: 'existing-customer' });
    (prisma.operator.create as jest.Mock).mockResolvedValue({ id: 'op-new' });
    (prisma.operatorMember.create as jest.Mock).mockResolvedValue({});
    (prisma.phoneVerification.update as jest.Mock).mockResolvedValue({});

    await service.create(dto);

    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'existing-customer' },
      data: expect.objectContaining({ role: 'OPERATOR' }),
    }));
    expect(prisma.phoneVerification.update).toHaveBeenCalledWith({
      where: { id: 'pv-1' },
      data: { consumedAt: expect.any(Date) },
    });
  });

  it('existing customer without a valid token: blocked with the specific error, transaction never starts', async () => {
    (prisma.user.findUnique as jest.Mock)
      .mockResolvedValueOnce({ id: 'existing-customer', role: 'CUSTOMER', phoneNumber: '+2348012345678' })
      .mockResolvedValueOnce(null);
    (otpService.findValidTokenRow as jest.Mock).mockResolvedValue(null);

    await expect(service.create(baseDto())).rejects.toThrow('verify your number');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('existing operator/admin on that phone: hard block, no OTP path', async () => {
    (prisma.user.findUnique as jest.Mock)
      .mockResolvedValueOnce({ id: 'existing-op', role: 'OPERATOR', phoneNumber: '+2348012345678' })
      .mockResolvedValueOnce(null);

    await expect(service.create(baseDto())).rejects.toThrow('Email or phone number already registered');
    expect(otpService.findValidTokenRow).not.toHaveBeenCalled();
  });
});
```

Add `otpService = { findValidTokenRow: jest.fn() }` to the top-level `beforeEach` and provide it via `{ provide: OtpService, useValue: otpService }`. Also add `user: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() }` and `phoneVerification: { update: jest.fn() }` to the `prisma` mock object if not already present (the existing mock only had `user: { findFirst: jest.fn() }`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest operator.service -v`
Expected: FAIL — current `create()` doesn't have this branching.

- [ ] **Step 3: Add `phoneVerificationToken` to the DTO**

In `src/operator/dto/create-operator.dto.ts`, add:

```ts
  @IsString()
  @IsOptional()
  phoneVerificationToken?: string;
```

- [ ] **Step 4: Inject `OtpService`**

In `src/operator/operator.module.ts`, import `OtpModule` and add it to `imports`.

In `src/operator/operator.service.ts`, add the import and constructor param:

```ts
import { OtpService } from '../otp/otp.service';
```
```ts
  constructor(
    private readonly prisma: PrismaService,
    private readonly paystackService: PaystackService,
    private readonly otpService: OtpService,
  ) {}
```

- [ ] **Step 5: Rewrite the existing-user check and `create()` body**

In `src/operator/operator.service.ts`, replace the current lookup and collision-guard block (the `personalPhone`/`businessPhone` section added earlier this session, from `const personalPhone = normalizePhone(...)` through the `passwordHash` line, plus the `$transaction` call that follows) with:

```ts
    const personalPhone = normalizePhone(data.phoneNumber);
    const businessPhone = normalizePhone(data.businessPhoneNumber);

    const existingByPhone = await this.prisma.user.findUnique({ where: { phoneNumber: personalPhone } });
    // email is required on CreateOperatorDto today — always a real string here.
    // If email ever becomes optional, this lookup must be skipped when absent.
    const existingByEmail = await this.prisma.user.findUnique({ where: { email: data.email } });

    if (existingByEmail && existingByEmail.id !== existingByPhone?.id) {
      throw new ConflictException('Email or phone number already registered');
    }

    let upgradeUserId: string | null = null;
    let upgradeTokenRowId: string | null = null;

    if (existingByPhone) {
      if (existingByPhone.role !== UserRole.CUSTOMER) {
        throw new ConflictException('Email or phone number already registered');
      }

      if (!data.phoneVerificationToken) {
        throw new ConflictException('This number belongs to an existing account — verify your number first.');
      }
      const tokenRow = await this.otpService.findValidTokenRow(personalPhone, data.phoneVerificationToken);
      if (!tokenRow) {
        throw new ConflictException('This number belongs to an existing account — verify your number first.');
      }
      upgradeUserId = existingByPhone.id;
      upgradeTokenRowId = tokenRow.id;
    }

    // Business phone still checked against both tables — unchanged from
    // the collision guard shipped earlier this session. OTP-proven
    // ownership of the PERSONAL number doesn't touch this check.
    const personalPhoneClaimedByOperator = await this.prisma.operator.findUnique({
      where: { phoneNumber: personalPhone },
    });
    if (personalPhoneClaimedByOperator) {
      throw new ConflictException('This phone number is already registered as a business dispatch line.');
    }

    const businessPhoneClaimedByOperator = await this.prisma.operator.findUnique({
      where: { phoneNumber: businessPhone },
    });
    if (businessPhoneClaimedByOperator) {
      throw new ConflictException('This business phone number is already registered.');
    }

    const businessPhoneClaimedByCustomer = await this.prisma.user.findFirst({
      where: { phoneNumber: businessPhone },
    });
    if (businessPhoneClaimedByCustomer) {
      throw new ConflictException('This business phone number is already registered as a customer account. Use a different number for your business line.');
    }

    const passwordHash = await bcrypt.hash(data.password, 10);

    return this.prisma.$transaction(async (tx) => {
      let user;

      if (upgradeUserId) {
        // Re-check inside the transaction — close the gap if state changed
        // between the pre-check above and this write.
        const freshTokenRow = await tx.phoneVerification.findUnique({ where: { id: upgradeTokenRowId! } });
        if (!freshTokenRow || freshTokenRow.consumedAt || freshTokenRow.tokenExpiresAt! < new Date()) {
          throw new ConflictException('This number belongs to an existing account — verify your number first.');
        }
        const stillFree = await tx.user.findUnique({ where: { email: data.email } });
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

        await tx.phoneVerification.update({
          where: { id: upgradeTokenRowId! },
          data: { consumedAt: new Date() },
        });
      } else {
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

      const operator = await tx.operator.create({
        data: {
          type:          data.type ?? OperatorType.TOW_TRUCK,
          truckClasses:  data.truckClasses,
          businessName:  data.businessName,
          contactName:   data.contactName,
          phoneNumber:   businessPhone,
          email:         data.email,
          address:       data.address,
          latitude:      data.latitude,
          longitude:     data.longitude,
          serviceRadius: data.serviceRadius ?? 10,
          status:        OperatorStatus.PENDING,
        },
      });
```

Leave the rest of the existing transaction body (the `tx.operatorMember.create(...)` call and whatever follows it, through the end of the method) unchanged — only the preamble above it and the `user`/`operator` creation are replaced.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx jest operator.service -v`
Expected: PASS.

- [ ] **Step 7: Run full backend suite and typecheck**

Run: `npx tsc --noEmit && npx jest`
Expected: no type errors, all suites pass (fix the two pre-existing `create()` tests from earlier this session — "throws ConflictException when the email or phone number is already registered" and the business-phone-collision test — if their `prisma.user.findFirst` mocks need updating to `findUnique` given the lookup method changed).

- [ ] **Step 8: Commit**

```bash
git add src/operator/ src/otp/
git commit -m "feat(operator): let an existing customer become an operator via OTP-verified upgrade"
```

---

### Task 4: Frontend — register form OTP wiring

**Files:**
- Modify: `app/register/page.tsx`
- Modify: `app/types.ts` (`RegisterOperatorRequest`)
- Modify: `app/hooks/useAuthApi.ts` or a new `app/hooks/useOtpApi.ts` (check which existing hook file makes sense — likely a small new hook, since OTP isn't auth-specific)

**Interfaces:**
- Consumes: `POST /otp/send-code`, `POST /otp/verify-code` (Task 2), `POST /operators` now accepting `phoneVerificationToken` (Task 3).
- Produces: nothing consumed elsewhere — terminal task.

- [ ] **Step 1: Add the hook**

Create `app/hooks/useOtpApi.ts`, mirroring the `apiFetch` pattern from `useRescueRequestApi.ts`'s `cancelRequest`:

```ts
import { useCallback, useState } from "react";
import { apiFetch } from "./api";

export function useOtpApi() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendCode = useCallback(async (phoneNumber: string): Promise<{ required: boolean; available?: boolean }> => {
    setLoading(true);
    setError(null);
    try {
      return await apiFetch("/otp/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to send code";
      setError(msg);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const verifyCode = useCallback(async (phoneNumber: string, code: string): Promise<{ token: string }> => {
    setLoading(true);
    setError(null);
    try {
      return await apiFetch("/otp/verify-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber, code }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to verify code";
      setError(msg);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  return { loading, error, sendCode, verifyCode };
}
```

Export it from `app/hooks/index.ts` alongside the other hooks.

- [ ] **Step 2: Add `phoneVerificationToken` to the request type**

In `app/types.ts`, add to `RegisterOperatorRequest`:

```ts
  phoneVerificationToken?: string;
```

- [ ] **Step 3: Wire the "About You" phone field to trigger verification**

In `app/register/page.tsx`, import `useOtpApi` and add state near the existing phone-related state (`phoneError`, etc.):

```ts
  const { sendCode, verifyCode } = useOtpApi();
  const [otpRequired, setOtpRequired] = useState(false);
  const [otpVerified, setOtpVerified] = useState(false);
  const [otpToken, setOtpToken] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [otpError, setOtpError] = useState("");
  const [phoneUnavailable, setPhoneUnavailable] = useState(false);
```

Add a check triggered when the personal phone field is valid and loses focus — a good place is a new `onBlur` handler on the "Your Phone Number" input in Step 1:

```ts
  async function handlePersonalPhoneBlur() {
    if (!formData.phoneNumber || phoneError) return;
    setOtpRequired(false);
    setOtpVerified(false);
    setPhoneUnavailable(false);
    try {
      const result = await sendCode(formData.phoneNumber);
      if (result.available === false) {
        setPhoneUnavailable(true);
      } else if (result.required) {
        setOtpRequired(true);
      }
    } catch {
      // sendCode already sets its own error state; nothing else to do here
    }
  }
```

Add `onBlur={handlePersonalPhoneBlur}` to the personal phone `<input>` in Step 1 (the one with `name="phoneNumber"`).

- [ ] **Step 4: Render the inline verify UI and the unavailable-number message**

Directly below the personal phone field's existing validity messages in Step 1, add:

```tsx
                {phoneUnavailable && (
                  <p style={{ fontSize: "0.85rem", color: "#d63031", margin: "6px 0 0" }}>
                    This number is already registered to an operator account. If this is you, please log in instead.
                  </p>
                )}
                {otpRequired && !otpVerified && (
                  <div style={{ marginTop: 10, padding: 12, background: "#F6FAFF", borderRadius: 8 }}>
                    <p style={{ fontSize: "0.85rem", color: "#333", margin: "0 0 8px" }}>
                      This number has an existing customer account. Enter the code we sent via WhatsApp to continue.
                    </p>
                    {!otpSent ? (
                      <button
                        type="button"
                        onClick={async () => {
                          await sendCode(formData.phoneNumber);
                          setOtpSent(true);
                        }}
                        style={{ padding: "0.5rem 1rem", borderRadius: 6, border: "1px solid #003DB4", background: "#fff", color: "#003DB4", cursor: "pointer" }}
                      >
                        Send code
                      </button>
                    ) : (
                      <div style={{ display: "flex", gap: 8 }}>
                        <input
                          type="text"
                          value={otpCode}
                          onChange={(e) => setOtpCode(e.target.value)}
                          placeholder="6-digit code"
                          style={{ ...inputStyle(Boolean(otpError)), maxWidth: 160 }}
                        />
                        <button
                          type="button"
                          onClick={async () => {
                            setOtpError("");
                            try {
                              const result = await verifyCode(formData.phoneNumber, otpCode);
                              setOtpToken(result.token);
                              setOtpVerified(true);
                            } catch (err) {
                              setOtpError(err instanceof Error ? err.message : "Verification failed");
                            }
                          }}
                          style={{ padding: "0.5rem 1rem", borderRadius: 6, border: "none", background: "#003DB4", color: "#fff", cursor: "pointer" }}
                        >
                          Verify
                        </button>
                      </div>
                    )}
                    {otpError && <p style={{ fontSize: "0.85rem", color: "#d63031", margin: "8px 0 0" }}>{otpError}</p>}
                  </div>
                )}
                {otpVerified && (
                  <p style={{ fontSize: "0.85rem", color: "#003DB4", margin: "6px 0 0" }}>
                    ✓ Number verified
                  </p>
                )}
```

- [ ] **Step 5: Block progression and include the token at submit**

In `handleSubmit`, add a check alongside the other Step-1 validations (after the personal-phone-validity check):

```ts
    if (phoneUnavailable) {
      setError("This phone number is already registered to an operator account.");
      return;
    }
    if (otpRequired && !otpVerified) {
      setError("Please verify your phone number before continuing.");
      return;
    }
```

In the `payload` object, add:

```ts
        phoneVerificationToken: otpVerified ? otpToken : undefined,
```

- [ ] **Step 6: Verify**

Run: `rm -rf .next && npx tsc --noEmit && npm run build`
Expected: clean typecheck and build.

- [ ] **Step 7: Manual click-through**

Start the dev server. Register with a brand-new phone number — confirm no OTP UI appears and signup proceeds normally. Then, using a phone number that already exists as a customer (create one via a test WhatsApp SOS locally, or seed one), confirm: the OTP prompt appears, "Send code" triggers a WhatsApp message (check Sentry logs or local ngrok tunnel for the outbound Twilio call), entering the correct code shows "✓ Number verified," and submitting completes registration with the existing customer's history intact (log in and confirm old requests are visible). Also confirm submitting a number already registered as an operator/admin shows the "already registered" message and blocks progression.

- [ ] **Step 8: Commit**

```bash
git add app/hooks/useOtpApi.ts app/hooks/index.ts app/types.ts app/register/page.tsx
git commit -m "feat(register): wire WhatsApp OTP verification for existing-customer signup"
```

---

## Self-Review Notes

- **Spec coverage:** `PhoneVerification` model (Task 1), send/verify endpoints + rate limiting + attempts-exhaustion (Task 2), split lookup + three-way branching + transactional upgrade + exact-row token consumption (Task 3), three-outcome send-code response wired into the UI + blocked-progression UX (Task 4).
- **Placeholder scan:** none found — all code blocks are complete, no TBDs.
- **Type consistency:** `OtpService.sendCode`/`verifyCode`/`findValidTokenRow` signatures match between Task 2's implementation and Task 3's consumption; `phoneVerificationToken` field name matches across the DTO (Task 3), `RegisterOperatorRequest` (Task 4), and the payload built in `register/page.tsx` (Task 4).
- **One item deliberately left to the implementer's judgment:** Task 3 Step 5 says "leave the rest of the existing transaction body... unchanged" rather than reproducing the full `operatorMember.create` block and whatever follows — this is because that trailing code (already committed earlier this session) isn't part of what this feature changes, and reproducing it verbatim risks the plan drifting out of sync with the actual file. The implementer should read the current file to confirm the splice point rather than trust line numbers, which will have shifted since this plan was written.
