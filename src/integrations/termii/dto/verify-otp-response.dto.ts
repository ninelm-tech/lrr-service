/**
 * Shape of Termii's `/sms/otp/verify` response — only the fields
 * TermiiService actually reads. `verified` is Termii's own string enum
 * ('True' | 'Expired' | 'False'), not a real boolean — TermiiService
 * normalizes it before returning to callers.
 */
export interface TermiiVerifyOtpResponse {
  verified?: string;
  message?: string;
}
