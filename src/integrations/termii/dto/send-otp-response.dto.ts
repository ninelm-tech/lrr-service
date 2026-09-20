/**
 * Shape of Termii's `/sms/otp/send` response — only the fields TermiiService
 * actually reads. `pinId` is present on success and is required to verify
 * this code later; `message` carries the provider's explanation on failure.
 */
export interface TermiiSendOtpResponse {
  pinId?: string;
  message?: string;
}
