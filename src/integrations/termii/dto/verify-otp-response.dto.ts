/**
 * Shape of Termii's `/sms/otp/verify` response — only the fields
 * TermiiService actually reads. `verified` is deliberately loose: Termii's
 * docs show the string 'True', but a valid code was observed being accepted
 * (HTTP 200) and then rejected by an exact-string check, so it can also be a
 * real boolean; failures use strings like 'Expired'. TermiiService
 * normalizes it before returning to callers.
 */
export interface TermiiVerifyOtpResponse {
  verified?: string | boolean;
  message?: string;
}
