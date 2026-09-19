/**
 * Shape of Termii's `/sms/send` response — only the fields TermiiService
 * actually reads. `message_id` is present on success, `message` carries the
 * provider's explanation on both success and failure (e.g. "Insufficient
 * balance").
 */
export interface TermiiSendSmsResponse {
  message_id?: string;
  message?: string;
}
