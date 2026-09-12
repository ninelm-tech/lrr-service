# Existing-Customer Operator Signup (WhatsApp OTP Verification) — Design

**Date:** 2026-08-18
**Repos:** lrr-service, lrr-web

## Problem

Today, if someone tries to register as an operator using a phone number that already
belongs to an existing `User` (most commonly: they've messaged the SOS bot as a customer
before), `operator.service.ts`'s pre-check finds the collision and hard-blocks the whole
signup with a generic "Email or phone number already registered" error — no path forward.

Previously (per product's recollection) this case was allowed through, and the person could
see their old customer request history under the new account — but with no verification that
they actually owned the number. The ask now: keep allowing this, but require them to prove
ownership of the number first, via a WhatsApp one-time code (this is the only channel that
makes sense here — LRR has no SMS-sending capability, only WhatsApp via Twilio).

**Scope is deliberately narrow:** this applies ONLY when the matched existing account has
role `CUSTOMER`. If the number already belongs to an existing `Operator`/`User` with role
`OPERATOR` or `ADMIN`, registration stays a hard block, same as today — that's a genuine
duplicate-account attempt, not a legitimate ownership case, and OTP verification doesn't
change that.

**The upgrade is one-way and permanent for that identity.** Once a `CUSTOMER` becomes an
`OPERATOR` through this flow, there's no operator→customer switch and no dual-role identity —
`User.role` is a single value, not a set. They keep their old customer history (same `User.id`),
but going forward that identity is an operator, full stop.

## Current state (confirmed via code read)

- No OTP/phone-verification system exists anywhere in `lrr-service` — no `OtpService`, no
  `Otp`/`PhoneVerification` model, no Termii integration. (Initially assumed this existed,
  based on a similar pattern in a different product's codebase — confirmed via grep that it
  does not exist here.)
- `operator.service.ts create()`'s existing-user check (`prisma.user.findFirst({ where: {
  OR: [{ email }, { phoneNumber }] } })`) throws `ConflictException` unconditionally on any
  match — no branch distinguishing "this is the same person legitimately upgrading" from "this
  is a duplicate account attempt." This combined `OR` lookup is also itself a bug once phone
  collisions can trigger the upgrade path: `findFirst` returns whichever row matches first, so
  if the phone belongs to Customer A but the email happens to belong to unrelated User B, the
  upgrade logic could reason about the wrong row entirely.
- A customer `User` row created via the WhatsApp bot (`findOrCreateCustomer`) has only
  `phoneNumber` and `role: CUSTOMER` set — no `email`, no `passwordHash`. Becoming an operator
  means filling those in, not just changing role.
- Their existing `RescueRequest` rows are tied to `User.id`, not to role — reusing the same
  `User` row means history is preserved automatically, nothing to migrate.

## Design

### New: WhatsApp OTP verification

- `PhoneVerification` model: `id`, `phoneNumber`, `codeHash` (never store the raw code),
  `createdAt DateTime @default(now())` (the timestamp source the send-code rate limits below key
  off — cooldown and per-window cap both need to look back over recent rows for this phone),
  `expiresAt`, `verifiedAt`, `attempts`, plus fields for the token issued on successful verify —
  `verificationTokenHash String?`, `tokenExpiresAt DateTime?`, `consumedAt DateTime?`. The token
  itself (a random opaque string, hashed before storage same as the code) is only ever returned
  to the caller once, at verify time; the row is how the server later confirms a presented token
  is valid, unexpired, and — critically — not already `consumedAt`, which is what makes it
  genuinely single-use rather than just short-lived. Code expires in ~10 min; once verified, the
  token expires in ~15 min (`tokenExpiresAt`) and is consumed (see transaction below) the moment
  it's successfully used to complete registration, not merely on issuance.
  Once `attempts` reaches the max (e.g. 5), the row is treated as invalid for any further verify
  calls regardless of `expiresAt` — the attempts count itself is the invalidation signal, no
  separate "locked" flag needed, but this is an explicit rule the verify-code logic enforces, not
  an incidental side effect of some other check.
- Two endpoints:
  - **Send code** — given a phone number, checks whether it belongs to an existing `User`, and
    distinguishes three outcomes rather than a flat required/not-required boolean, so the
    frontend can react correctly before the registrant fills out the rest of the form:
    - No existing user for this number → `{ required: false, available: true }`. Nothing sent,
      normal signup proceeds.
    - Existing user with role `CUSTOMER` → `{ required: true }`. Generates a code, WhatsApps it
      via the existing `TwilioService`/`toWhatsAppAddress` pattern.
    - Existing user with role `OPERATOR`/`ADMIN` → immediate conflict response (e.g.
      `{ required: false, available: false }`), nothing sent. Without this third case, the
      registrant would only find out their number is already an operator/admin account at final
      submit, after filling out the entire business step — a wasted round trip this endpoint can
      prevent up front.

    Rate-limited per phone number (using `createdAt` above): a resend cooldown (e.g. 60s between
    sends) and a cap on total sends within a rolling window (e.g. 5 per hour) — without this, the
    endpoint is an open door to spam a real customer's WhatsApp and burn Twilio spend by
    hammering a known number repeatedly. This is separate from `attempts` on the verify side,
    which only protects against guessing a code that's already been sent.
  - **Verify code** — given phone + code, checks against the latest non-expired
    `PhoneVerification` row for that number (respecting `attempts` — invalidate after too many
    wrong tries), and on success returns a short-lived verification token.
- Both endpoints are public (no auth) — this happens before an account exists — but the rate
  limiting above is the deliberate, minimum viable guard, not a general-purpose OTP platform.

### Registration flow change

- `lrr-web` register form: right after the personal phone number is entered in "About You,"
  call send-code. If `required: false`, nothing changes in the UI — proceeds exactly as today.
  If `required: true`, reveal an inline verify-code prompt that must succeed before the form
  can move to the business step.
- `CreateOperatorDto` gains an optional `phoneVerificationToken`.
- `operator.service.ts create()`: the combined `OR`-based existing-user lookup is replaced with
  two explicit, separate checks so the decision never depends on which row Prisma happens to
  return first:
  - `existingByPhone = prisma.user.findUnique({ where: { phoneNumber } })`
  - `existingByEmail = prisma.user.findUnique({ where: { email } })` — `email` is required on
    `CreateOperatorDto` today (`@IsEmail()`, no `@IsOptional()`), so this is always a real string
    at this point, never `undefined`/`null`. Documenting the invariant explicitly here so it
    stays correct if the DTO's email requirement ever changes — if `email` ever becomes optional,
    this lookup must be skipped when it's absent rather than passed through.

  Reasoned explicitly, in this order:
  1. `existingByEmail` exists and is a different row than `existingByPhone` (or `existingByPhone`
     is null): hard conflict — that email belongs to someone else. Unchanged from today.
  2. `existingByPhone` exists with role `CUSTOMER`: the upgrade path. Require a
     `phoneVerificationToken`, and validate it by hashing the presented token and looking up
     that **exact row** — `verificationTokenHash` matches, `phoneNumber` matches, `tokenExpiresAt`
     in the future, `consumedAt` still null — not "the latest row for this phone," which could
     match a different, unrelated verification attempt for the same number. If invalid or
     missing, block with a clear "verify your number first" error (not the generic conflict
     message — this is a distinct, actionable case). If valid, proceed to the transactional
     upgrade below.
  3. `existingByPhone` exists with role `OPERATOR` or `ADMIN`: hard block, same as today, no OTP
     path.
  4. Neither exists: normal signup, unchanged.

  **The upgrade itself runs inside one `prisma.$transaction`** — re-checking state inside the
  transaction (not just trusting the pre-check above, to close the gap if something changed
  between the check and the write), re-validating the same exact `PhoneVerification` row
  identified above (by token hash, not "latest for phone"), confirming the email is still free,
  updating the existing `User` row (`email`, `passwordHash`, `name`, `role: OPERATOR`), creating
  the `Operator` and `OperatorMember` rows, and marking that same row's `consumedAt` — all
  together, or none of it. Without this, a mid-sequence failure (e.g. `Operator` creation
  fails after `User` has already been flipped to `OPERATOR`) leaves a customer account
  half-converted: role changed, but no operator record and no way back through normal signup.
  Their existing `RescueRequest` history stays attached automatically (same `User.id`) — nothing
  to migrate.
- **No change to the business-phone collision guard** shipped earlier this session. If the
  registrant picks "same as my number above" and that number is the same one they just proved
  ownership of, the existing guard still (correctly) blocks reusing it as the business/dispatch
  line — OTP-proven ownership doesn't override the "no shared number between customer and
  operator roles" rule. The expected path is: verify the personal number, then supply a
  *different* number for the business line.

## Testing

- Backend: unit tests for send-code (all three response shapes — fresh/available, existing
  customer requires verification, existing operator/admin immediate conflict — plus no message
  sent on the fresh/conflict branches, resend-cooldown and per-window-cap rejection), verify-code
  (success, wrong code, expired code, too-many-attempts and confirming the row is rejected on
  subsequent calls once `attempts` hits the max regardless of `expiresAt`, token correctly marked
  usable-once), and `operator.service.ts create()`'s branches — fresh number (unchanged
  behavior); email belongs to a different existing user than the phone match (conflict, not
  misattributed to the phone match); existing customer with valid token (reuses `User`
  transactionally, preserves history, consumes the exact token row); existing customer without/
  invalid/already-consumed/mismatched token (blocked with the specific error, transaction never
  starts); existing operator/admin (hard block, unchanged); a simulated mid-transaction failure
  (e.g. `Operator` creation throwing) rolling back the `User` update rather than leaving role
  flipped with no operator record; and — since persistence alone doesn't guarantee this —an
  explicit test that an upgraded operator's dashboard/API access can still retrieve their
  pre-upgrade `RescueRequest` history, not just that the rows still exist in the DB.
- Frontend: `tsc`/`next build` plus manual click-through, consistent with the rest of this
  session's lrr-web verification (no test suite exists in lrr-web).
