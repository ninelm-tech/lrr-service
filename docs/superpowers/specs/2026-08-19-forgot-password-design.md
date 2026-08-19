# Forgot Password — Design

**Goal:** Let a user with a portal login (email/phone + password) reset their password, gated behind the same flag pattern used for existing-customer-becomes-operator signup — but here the flag controls whether the reset is verified at all, not whether the feature works.

**Status:** Approved by user 2026-08-19, semantics corrected 2026-08-19. Shipped with `otpPasswordResetEnabled = false`: passwords reset immediately off identifier + new password alone, **no proof of ownership**. This is a deliberate, explicitly-accepted interim state — flips to a WhatsApp-code-verified flow once Meta approves the OTP Authentication template.

## Background

- Portal login (`AuthService.login`) is email + password only.
- `User.email` and `User.phoneNumber` are both nullable in the schema; only `phoneNumber` is guaranteed present on any account that can receive WhatsApp messages.
- `operator.service.ts` has the flag pattern this feature's *shape* reuses (`private readonly otpUpgradeEnabled = false`), but not its consequence: there, flag-off blocks the gated path entirely. Here, flag-off does the opposite — it's the path that runs *without* verification; flag-on is what requires the code.
- `OtpService` already has the code-generation, hashing, rate-limiting, and `PhoneVerification` row machinery (`sendCode`, `verifyCode`, `findValidTokenRow`) built for the operator-upgrade flow. `sendCode` is deliberately restricted to `role === CUSTOMER` — that restriction is specific to upgrade-eligibility and must not be loosened, since forgot-password needs to work for *any* role.

## Backend (`lrr-service`)

### `OtpService` — one new method

`sendPasswordResetCode(phoneNumber: string): Promise<{ required: boolean }>`

Same shape as `sendCode` (code generation, `PhoneVerification` row, rate-limiting), but with no role restriction — any existing user with a portal password is eligible. Sends `Your LRR password reset code is {code}. It expires in 10 minutes.` via `TwilioService.sendWhatsAppMessage`. The shared rate-limit/generate/send logic is factored into a private `sendCodeToPhone` helper so `sendCode` and `sendPasswordResetCode` don't duplicate it. `verifyCode` and `findValidTokenRow` are reused as-is (no role concept in either).

### `AuthService` — two new methods, one new flag

```ts
// Flip to true once the WhatsApp OTP Authentication template is approved
// by Meta. Until then, requestPasswordReset resets the password directly
// off identifier + newPassword alone — no proof of ownership. That's a
// deliberate, explicitly-accepted interim state: once this flips, the same
// call only sends a code, and the password only changes via
// resetPasswordWithCode after that code is verified.
private readonly otpPasswordResetEnabled = false;
```

**`requestPasswordReset(identifier: string, newPassword: string): Promise<{ message: string; otpRequired: boolean }>`**
1. Reject `newPassword.length < 8` (manual check — no global `ValidationPipe`, same pattern as elsewhere in this codebase).
2. Resolve the account: try `prisma.user.findUnique({ where: { email: identifier } })`, then (if not found) `findUnique({ where: { phoneNumber: identifier } })` — two separate lookups, never a combined `OR` (same convention as `operator.service.ts`).
3. **If `!otpPasswordResetEnabled`:** if a user was found and has a `passwordHash`, hash `newPassword` and update it right here — no code, no verification. Log a `logger.warn` noting the unverified reset. Always return `{ message: 'Password updated. You can now log in.', otpRequired: false }` regardless of whether a user was actually found (keeps the response shape uniform even though, unlike the flag-on branch, this path's *side effect* does differ by whether an account existed).
4. **If `otpPasswordResetEnabled`:** `newPassword` is ignored. If no user, no `passwordHash`, or no `phoneNumber`, return the generic `{ message: "If an account exists, we've sent a reset code to its registered phone number.", otpRequired: true }` and do nothing. Otherwise call `otpService.sendPasswordResetCode(user.phoneNumber)` and return the same generic message.

**`resetPasswordWithCode(phoneNumber: string, code: string, newPassword: string): Promise<{ message: string }>`**
Only meaningful once the flag is on — `requestPasswordReset` never sends a code while it's off, so any code a caller guesses here fails `verifyCode`'s "not found" check. No flag gate needed on this method itself.
1. Reject `newPassword.length < 8`.
2. `const { token } = await otpService.verifyCode(phoneNumber, code)` — throws on expired/wrong/exhausted code (existing behavior, reused verbatim).
3. `const tokenRow = await otpService.findValidTokenRow(phoneNumber, token)` — pre-check outside the transaction.
4. Inside `prisma.$transaction`: re-fetch the token row by id via `tx.phoneVerification.findUnique` and re-validate `consumedAt`/`tokenExpiresAt` (closes the gap between step 3 and this write — same pattern as the operator-upgrade transaction). Mark it `consumedAt: new Date()`. Look up the `User` by `phoneNumber`; if no `passwordHash`, throw. Hash `newPassword` and update `passwordHash`.
5. Return `{ message: 'Password updated. You can now log in.' }`.

### DTOs (`src/auth/dto/`)

`forgot-password.dto.ts`:
```ts
export class ForgotPasswordDto {
  @IsString() @IsNotEmpty()
  identifier: string; // email or phone number

  @IsString() @MinLength(8)
  newPassword: string; // applied immediately if OTP is off; ignored (code sent instead) if on
}
```

`reset-password.dto.ts`:
```ts
export class ResetPasswordDto {
  @IsString()
  phoneNumber: string;

  @IsString() @Length(6, 6)
  code: string;

  @IsString() @MinLength(8)
  newPassword: string;
}
```

### `AuthController` — two new routes, no guard (unauthenticated by definition)

```ts
@Post('forgot-password')
async forgotPassword(@Body() dto: ForgotPasswordDto) {
  return this.authService.requestPasswordReset(dto.identifier, dto.newPassword);
}

@Post('reset-password')
async resetPassword(@Body() dto: ResetPasswordDto) {
  return this.authService.resetPasswordWithCode(dto.phoneNumber, dto.code, dto.newPassword);
}
```

## Frontend (`lrr-web`)

- `LoginModal`: "Forgot password?" link under the password field, opening `ForgotPasswordModal`.
- `ForgotPasswordModal` — up to two steps:
  1. **Identify**: email/phone + new password → `forgotPassword(identifier, newPassword)`. If the response's `otpRequired` is `false`, the modal jumps straight to "done" (password already changed). If `true`, it shows the returned generic message and advances to step 2 — the `newPassword` already entered is carried over in component state, not asked for again.
  2. **Reset** (only reached when `otpRequired`): phone number + code → `resetPassword(phoneNumber, code, newPassword)`. On success, "done".
- `useAuthApi` gains `forgotPassword(identifier, newPassword)` and `resetPassword(phoneNumber, code, newPassword)`.

## Testing

- `auth.service.spec.ts`: `requestPasswordReset` — password-length guard; flag-off branch (updates directly, found/not-found/no-password cases, always `otpRequired: false`); flag-on branch (sends code, never touches the password directly, generic responses, email-then-phone fallback). `resetPasswordWithCode` — password-length guard, "no code was ever sent while flag was off" case, and the full flag-on happy/edge paths (token consumption, replay rejection, missing token row).
- `otp.service.spec.ts`: `sendPasswordResetCode` — works for any role (not just `CUSTOMER`), same rate-limit tests as `sendCode`.
- No new e2e/frontend test infra exists in this codebase — frontend changes verified via `tsc` + a manual dev-server smoke check, not automated.

## Out of scope

- Turning `otpPasswordResetEnabled` on — happens once Meta approves the Authentication template.
- Rate-limiting by IP (only by phone number, via existing `PhoneVerification` machinery).
- Any change to `AuthService.login` — email remains required for login itself; this feature only widens the *lookup* on the forgot-password entry point to accept phone too.
