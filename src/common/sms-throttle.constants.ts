/**
 * Per-IP rate limit shared by the two unauthenticated, SMS-triggering
 * endpoints that accept an arbitrary phone number:
 *   - POST /otp/send-code       (OtpController.sendCode)
 *   - POST /auth/login/otp/send (AuthController.sendLoginCode)
 *
 * Each phone number already has its own cap (OtpService's
 * MAX_SENDS_PER_WINDOW / RESEND_COOLDOWN_MS — 5 sends/hour, 60s cooldown,
 * per number). That doesn't stop a single caller from cycling through many
 * different numbers to rack up billable Termii sends — this closes that
 * gap by capping requests per IP instead of per phone number.
 *
 * Deliberately generous relative to the per-number cap: this isn't meant to
 * replace it, just bound mass-triggering across numbers.
 */
export const SMS_TRIGGER_THROTTLE_LIMIT = 5;
export const SMS_TRIGGER_THROTTLE_TTL_MS = 10 * 60 * 1000; // 10 minutes
