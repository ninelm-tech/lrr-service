# Operator Email-Optional Signup + Termii-Backed OTP Login — Design

**Goal:** Make `email` optional at operator signup (operators keep forgetting
theirs and getting stuck in password-reset), replace WhatsApp with Termii as
the OTP channel so delivery no longer depends on Meta template approval, and
add phone-based login (password or OTP) so an email-less operator is never
locked out of their account.

**Status:** Approved in chat 2026-09-18. Supersedes the "Out of scope" line
in `2026-08-19-forgot-password-design.md` ("Any change to `AuthService.login`
— email remains required for login itself") — login now also accepts phone.

## Background

- `CreateOperatorDto.email` is `@IsEmail()` with no `@IsOptional()` — required
  today, both backend and in `lrr-web/app/register/page.tsx`'s client check.
  `User.email` itself is already nullable at the schema level (`String?`).
- `AuthService.login(email, password)` is the only login path — looked up by
  `email` alone, and `JwtPayload`/`AuthResponse` both type `email` as a
  required `string`.
- Two existing flags disable OTP-dependent features entirely, both for the
  identical reason: sending a WhatsApp OTP fails on any real number until
  Meta approves the Authentication template, which has been stuck.
  - `OperatorService.otpUpgradeEnabled = false` — disables the existing
    customer-becomes-operator upgrade path (`2026-08-18-existing-customer-
    operator-signup-design.md`).
  - `AuthService.otpPasswordResetEnabled = false` — disables verified
    password reset; `requestPasswordReset` currently changes a password with
    **zero proof of ownership** whenever the flag is off, which is now.
  Moving OTP delivery to Termii (SMS, no template/approval process) removes
  the reason both flags exist — this design removes them outright rather
  than flipping them, since there's no longer a reason for either mode to be
  switchable.
- `OtpService`'s public interface (`sendCode`, `sendPasswordResetCode`,
  `verifyCode`, `findValidTokenRow`) is already channel-agnostic — the
  WhatsApp/Twilio coupling lives in exactly one private method,
  `sendCodeToPhone`, in one line (`twilioService.sendWhatsAppMessage(...)`).
  Swapping the channel touches nothing else.
- `zalyx-ledger-service/src/integrations/termii/termii.service.ts` already
  wraps Termii for a different product, with two distinct methods: `sendOtp`/
  `verifyOtp` use Termii's own OTP product (Termii generates and owns the
  code), and a separate `sendSms` is a plain SMS send. This design ports only
  `sendSms` — see §1 for why the OTP-product method is the wrong fit here,
  not merely more than LRR needs.
- `app/register/page.tsx` already has a complete, generic OTP UI (send code,
  enter code, verify, carry the token into submission as
  `phoneVerificationToken`) built for the upgrade path. It's driven entirely
  by `sendCode`'s `{ required, available }` response — no frontend change is
  needed to extend OTP verification to every signup, only a backend
  eligibility change. `useOtpApi`/`sendCode` has exactly one caller in
  `lrr-web` (this page), so widening its eligibility is contained.
- Paystack/payouts are not a blocker: `PaystackCustomerService.customerFor`
  already synthesizes a placeholder identity email (`{phone}@lrr.ng`) when
  `User.email` is null — built for optional-email customers, reused as-is.
- `AuthService.validateJwtPayload` re-fetches the full user from the DB by
  `payload.sub` on every authenticated request; nothing outside
  `auth.service.ts` reads `req.user.email` or the JWT's `email` field
  directly. `lrr-web`'s `useAuthApi.ts` display-name helper already falls
  back `name → phoneNumber → email → fallback`. Both mean making `email`
  nullable in the token/response shapes is low-risk.

## Backend (`lrr-service`)

### 1. `src/integrations/termii/` (new module)

**Termii is delivery only — LRR keeps owning code generation, hashing, and
verification exactly as it does today.** Zalyx's `TermiiService.sendOtp`/
`verifyOtp` use Termii's own OTP *product*: Termii generates the code
server-side, hands back a `pinId`, and verification happens against Termii's
system, not ours. That model is incompatible with `OtpService`, which
already generates its own code and verifies it by comparing hashes against
`PhoneVerification.codeHash` — bolting Termii's pinId flow on top would mean
the SMS carries *Termii's* random digits while `OtpService.verifyCode`
checks the hash of the code *we* generated; they would never match. So this
module ports Zalyx's other Termii method instead — `sendSms`, its plain SMS
endpoint, no pinId, no server-side code generation:

```ts
// termii.service.ts
@Injectable()
export class TermiiService {
  private readonly apiKey: string;
  private readonly senderId: string;
  private readonly baseUrl: string;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('termii.apiKey');
    if (!apiKey) throw new Error('Termii configuration is incomplete: missing API key');
    this.apiKey = apiKey;
    this.senderId = this.configService.get<string>('termii.senderId') || 'LRR';
    this.baseUrl = this.configService.get<string>('termii.baseUrl') || 'https://v3.api.termii.com/api';
  }

  /** Plain SMS — POST /sms/send, literal `message` text, no OTP product involved. */
  async sendSms(phone: string, message: string): Promise<void> { /* mirrors Zalyx's TermiiService.sendSms */ }
}
```

No `pinStore`, no `verifyOtp` — there is nothing for this module to verify;
verification stays entirely inside `OtpService`, unchanged.

### 2. `OtpService` — swap the channel, nothing else

`src/otp/otp.module.ts` imports `TermiiModule` instead of `TwilioModule`.
`sendCodeToPhone`'s one line changes from
`twilioService.sendWhatsAppMessage(...)` to
`termiiService.sendSms(phoneNumber, \`Your LRR ${label} is ${code}...\`)` —
LRR's own generated `code` is the literal text sent, so it's the same code
`verifyCode` checks against. Every other line in `OtpService` — code
generation, hashing, rate limiting, `PhoneVerification` rows, `verifyCode`,
`findValidTokenRow` — is unchanged, now truthfully so. `sendPasswordResetCode`
and the upgrade-path `sendCode` both get Termii for free.

### 3. Universal phone verification at operator signup

`sendCode`'s eligibility currently only sends for an **existing CUSTOMER**
phone (the upgrade case) — a brand-new phone returns `{ required: false,
available: true }` with no code sent. Widen it so a brand-new phone also
verifies, since phone is about to become a login credential either way:

```ts
async sendCode(phoneNumber: string): Promise<{ required: boolean; available?: boolean }> {
  const existingUser = await this.prisma.user.findUnique({ where: { phoneNumber } });
  if (existingUser && existingUser.role !== UserRole.CUSTOMER) {
    return { required: false, available: false }; // already taken by a non-customer — unchanged
  }
  // Brand-new phone OR an existing CUSTOMER upgrading — both now verify.
  await this.sendCodeToPhone(phoneNumber, 'verification code');
  return { required: true };
}
```

`operator.service.ts create()` currently only checks `phoneVerificationToken`
inside the `if (existingByPhone)` (upgrade) branch. Add the identical
check-and-consume to the plain-create branch too:

```ts
// Before the $transaction, alongside the existing upgrade-path token check:
if (!upgradeUserId) {
  if (!data.phoneVerificationToken) {
    throw new BadRequestException('Verify your phone number first.');
  }
  const tokenRow = await this.otpService.findValidTokenRow(personalPhone, data.phoneVerificationToken);
  if (!tokenRow) {
    throw new BadRequestException('Verify your phone number first.');
  }
  freshSignupTokenRowId = tokenRow.id; // consumed inside the transaction, same re-check pattern as upgradeTokenRowId
}
```
Deliberately `BadRequestException` (400) here, not the upgrade branch's
`ConflictException` (409) — the upgrade branch reuses that type because its
message is shared with the "phone already belongs to someone else" conflict
just above it in the same block; a fresh signup has no such shared context,
and "you skipped verification" is a plain bad request, not a conflict. Not
an inconsistency to reconcile.

Inside the transaction's `else` branch (plain create), re-check and consume
`freshSignupTokenRowId` exactly the way the upgrade branch already re-checks
and consumes `upgradeTokenRowId` — same TOCTOU-closing pattern, same
`consumedAt` write.

### 4. `CreateOperatorDto`

```ts
export class CreateOperatorDto {
  @IsEmail()
  @IsOptional()
  email?: string;

  @IsString() @IsNotEmpty()
  password: string; // unchanged — always required, the fallback if OTP delivery ever fails

  // ...unchanged fields (name, businessName, contactName, phoneNumber,
  // businessPhoneNumber, address, latitude, longitude, serviceRadius,
  // truckClasses)...

  @IsString() @IsNotEmpty() // was @IsOptional() — now required for every signup, not just upgrades
  phoneVerificationToken: string;
}
```

`operator.service.ts`'s existing email-duplicate lookup already has a
comment anticipating this: skip the `findUnique({ where: { email } })` call
(and the conflict check that follows it) when `data.email` is undefined.

### 5. Remove `otpUpgradeEnabled` and `otpPasswordResetEnabled`

Both flags and their `false` branches are deleted outright, not flipped:

- `OperatorService`: remove `otpUpgradeEnabled` and the
  `!this.otpUpgradeEnabled` condition in the upgrade-path guard — an
  existing CUSTOMER's phone now always attempts the upgrade path (still
  gated on a valid `phoneVerificationToken`, same as today).
- `AuthService.requestPasswordReset`: remove `otpPasswordResetEnabled` and
  the flag-off branch entirely (step 3 in the 2026-08-19 spec). The method
  becomes unconditionally the flag-on behavior (step 4): resolve the
  account, send a code via `sendPasswordResetCode` if found (generic
  response either way), and `resetPasswordWithCode` is the only way a
  password actually changes. `resetPasswordWithCode` itself is unchanged —
  it was already written to only make sense once a code exists.
- `lrr-web`'s `ForgotPasswordModal` already branches on `otpRequired` and
  already has the full step-2 (enter code) UI built for exactly this case
  (from the 2026-08-19 work) — since `otpRequired` is now always `true`, no
  frontend change is needed there; the modal simply always takes the branch
  it was already built for.

### 6. Login — accept phone or email, password or OTP

`LoginDto`:
```ts
export class LoginDto {
  identifier: string; // email or phone number
  password: string;
}
```

`AuthService.login(identifier, password)` — two separate lookups (never a
combined `OR`, matching the convention used everywhere else in this file):
```ts
async login(identifier: string, password: string): Promise<AuthResponse> {
  const user =
    (await this.prisma.user.findUnique({ where: { email: identifier } })) ??
    (await this.prisma.user.findUnique({ where: { phoneNumber: identifier } }));
  if (!user || !user.passwordHash) throw new UnauthorizedException('Invalid credentials');
  // ...password verify + token generation, unchanged from today...
}
```

New: phone + OTP login, restricted to `OPERATOR` — this route trades a
password for a single SMS code, which is a strictly weaker factor (SIM-swap/
port risk) than what CUSTOMER/ADMIN/SUPER_ADMIN accounts assume today. It
must not become an alternate, weaker login path into a staff or admin
account. (This is also why it's role-gated rather than merely undocumented:
"out of scope for customers" in the Out-of-scope section means nothing if
the code itself grants it anyway.)

`OtpService` — one new method. Unlike `sendPasswordResetCode` (deliberately
role-agnostic — password reset must work for any role), eligibility here is
`role === OPERATOR` only. The response is identical regardless of whether
the number is unknown, ineligible, or genuinely sent — same
account-enumeration defense `requestPasswordReset` already uses, applied
here too (this spec's first draft missed it: an unknown-vs-known-number
response difference is exactly the kind of oracle that shouldn't exist on
an unauthenticated endpoint):
```ts
async sendLoginCode(phoneNumber: string): Promise<{ required: boolean }> {
  const existingUser = await this.prisma.user.findUnique({ where: { phoneNumber } });
  if (existingUser?.role === UserRole.OPERATOR) {
    await this.sendCodeToPhone(phoneNumber, 'login code');
  }
  return { required: true }; // always — ineligible/unknown numbers are indistinguishable from outside
}
```

`AuthService.loginWithOtp(phoneNumber, code)` — consumption is the claim,
not a read followed by a separate write. A `findUnique` check with an
`update` after it — even inside a `$transaction` — lets two concurrent
requests both observe `consumedAt: null` before either commits, and both
mint a token off the same code (this spec's first draft had exactly that
bug, copied from `resetPasswordWithCode`'s existing shape — see the note
below, that one has it too). The fix is "the guard is the query": an
`updateMany` whose `WHERE` is the eligibility check, so only one concurrent
caller's claim can match:
```ts
async loginWithOtp(phoneNumber: string, code: string): Promise<AuthResponse> {
  const { token } = await this.otpService.verifyCode(phoneNumber, code);
  const tokenRow = await this.otpService.findValidTokenRow(phoneNumber, token);
  if (!tokenRow) throw new UnauthorizedException('Code expired — request a new one.');

  return this.prisma.$transaction(async (tx) => {
    const claimed = await tx.phoneVerification.updateMany({
      where: { id: tokenRow.id, consumedAt: null, tokenExpiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });
    if (claimed.count !== 1) {
      throw new UnauthorizedException('Code expired — request a new one.');
    }

    // Re-checked here, not just at send time: this is the point that
    // actually grants access, and the only check that matters is the one
    // made at the moment of granting it.
    const user = await tx.user.findUnique({ where: { phoneNumber } });
    if (!user || user.role !== UserRole.OPERATOR) {
      throw new UnauthorizedException('No account found for this number.');
    }

    const accessToken = this.generateToken({ id: user.id, email: user.email, role: user.role });
    return { accessToken, user: { id: user.id, email: user.email, name: user.name, role: user.role } };
  });
}
```

**Pre-existing bug found while writing this, same file, same shape:**
`resetPasswordWithCode` (shipped 2026-08-19) has the identical read-then-write
consumption race — `findUnique` checking `consumedAt`, then a separate
`update`, inside a `$transaction` that doesn't make the pair atomic. Two
concurrent password-reset submissions with the same code can both pass the
check and both reset the password (harmless-ish today only because the flag
that gates this path being reachable was off — see §5; once removed, this
path is live). In scope for this change: switch it to the same
`updateMany`-claim pattern above, since it's the same file, the same root
cause, and leaving the buggy version as "the pattern this design mirrors"
while writing a corrected copy next to it would be worse than fixing both.

### 7. `JwtPayload` / `AuthResponse` — `email` becomes nullable

```ts
export interface JwtPayload {
  sub: string;
  email: string | null; // was string — see Background for why this is low-risk
  role: UserRole;
}
export interface AuthResponse {
  accessToken: string;
  user: { id: string; email: string | null; name: string | null; role: UserRole };
}
```

`generateToken`'s signature drops the non-null assertions it's given today
(`user.email!` at the four call sites in `auth.service.ts`) — callers pass
`user.email` (already `string | null` from Prisma) directly.

### 8. New DTOs / routes

```ts
// src/auth/dto/login-otp.dto.ts
export class SendLoginCodeDto { @IsString() @IsNotEmpty() phoneNumber: string; }
export class VerifyLoginCodeDto {
  @IsString() @IsNotEmpty() phoneNumber: string;
  @IsString() @Length(6, 6) code: string;
}
```

```ts
// auth.controller.ts
@Post('login/otp/send')
async sendLoginCode(@Body() dto: SendLoginCodeDto) {
  return this.authService.sendLoginCode(normalizePhone(dto.phoneNumber));
}

@Post('login/otp/verify')
async loginWithOtp(@Body() dto: VerifyLoginCodeDto) {
  return this.authService.loginWithOtp(normalizePhone(dto.phoneNumber), dto.code);
}
```

`LoginDto.email` is renamed to `identifier` — check for any other reader of
the old shape before renaming (grep confirmed `auth.controller.ts`'s
`login()` is its only consumer). Its call site updates in step:
```ts
async login(@Body() dto: LoginDto) {
  return this.authService.login(dto.identifier, dto.password);
}
```

## Frontend (`lrr-web`)

- `app/register/page.tsx`: drop the hard `if (!formData.email || !formData.password)` client check — only `password` stays required. The existing OTP block (already generic, driven by `sendCode`'s `required` flag) needs no changes; it now simply fires for every signup instead of only upgrades. Step 3's copy ("You'll use this email and password to log in") needs a small rewrite since email is now optional — e.g. "You'll use this to log in — add an email too if you'd like a backup way in."
- `LoginModal.tsx`: today's single email+password form becomes two tabs/modes — **Password** (identifier input relabeled "Email or phone", same password field, posts to `/auth/login`) and **OTP** (phone input → send code → code input → posts to `/auth/login/otp/send` then `/auth/login/otp/verify`). Both end the same way today's login does: store the token, redirect.
- `useAuthApi.ts`: `login(identifier, password)` (param renamed from `email`), plus `sendLoginCode(phoneNumber)` and `loginWithOtp(phoneNumber, code)`.
- `ForgotPasswordModal`: no changes (see Background/§5) — already built for the now-permanent verified path.

## Testing

- `otp.service.spec.ts`: `sendCode` — brand-new phone now sends and returns `required: true` (was `available: true`, no send); existing-CUSTOMER phone unchanged; existing-non-CUSTOMER phone still blocked. New `sendLoginCode` — sends for any existing user regardless of role/password, generic no-op for unknown phone.
- `operator.service.spec.ts`: `create()` — plain signup now requires and consumes a `phoneVerificationToken` the same way the upgrade path does (missing token, invalid token, expired token, replay-after-consumption all rejected); `otpUpgradeEnabled`'s removal means the upgrade branch's tests drop their flag-off case and keep the flag-on cases as the only behavior. Email-optional: `create()` with `email` omitted succeeds and skips the duplicate-email lookup entirely (assert `prisma.user.findUnique` is never called with an `email` where-clause).
- `auth.service.spec.ts`: `login` — succeeds via email, succeeds via phone, fails on either with wrong password. `requestPasswordReset` — the flag-off branch's tests are deleted; only the (now sole) verified-code branch remains, plus a new case asserting the consume step uses `updateMany` with `consumedAt: null` in its `where` (not a plain `update`) and rejects when `count !== 1`. New `loginWithOtp` — happy path for an OPERATOR; rejects a CUSTOMER/ADMIN/SUPER_ADMIN account even with a valid code (the role re-check at the grant point, not just at send); expired/wrong code; same atomic-claim assertion as above, plus an explicit "second call with the same already-consumed code fails" case (the concrete replay this fixes). New `sendLoginCode` — identical `{ required: true }` response for an unknown phone, a CUSTOMER phone, and an OPERATOR phone (only the last actually sends — assert on the Termii/OtpService send call, not on the response shape).
- `termii.service.ts` gets its own spec mirroring Zalyx's `termii.service.spec.ts` shape (mocked `fetch`, send/verify success and failure).
- No e2e/frontend test infra exists in this codebase (established in the 2026-08-19 spec) — frontend changes verified via `tsc` + manual dev-server smoke check.

## Out of scope

- `addMember` (inviting an existing user as staff to an operator) — takes an
  existing `userId`, never creates a new account, untouched by this design.
- Customer/admin/staff OTP login — `email` is already optional for
  customers; this design deliberately restricts `sendLoginCode`/
  `loginWithOtp` to `OPERATOR` (see §6) rather than leaving it open to every
  role. Widening it to customers later is a real, separate decision (not a
  removed restriction) — customers primarily interact via the WhatsApp bot
  rather than the dashboard, and ADMIN/SUPER_ADMIN should not gain a
  password-less login path at all without that being its own explicit call.
- Any multi-country OTP routing (WhatsApp-first-with-SMS-fallback) — LRR is
  NG-only; Termii is the sole channel, not one of several.
- Rate-limiting by IP — unchanged, still by phone number only via the
  existing `PhoneVerification` machinery.
- Actually provisioning Termii credentials/sender ID — an ops task, not
  code; `TermiiService` throws clearly on startup if `termii.apiKey` is
  missing from config, same pattern as Zalyx's version.
