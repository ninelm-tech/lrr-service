/**
 * The parts of a Twilio status-callback payload we actually read.
 *
 * Deliberately partial and deliberately optional, same reasoning as
 * PaystackWebhookBody: this is untrusted input arriving over HTTP. The
 * signature (verified in WebhooksController before this is ever read)
 * proves it came from Twilio, not that any particular field is present.
 */
export interface TwilioStatusCallbackBody {
  MessageSid?: string;
  /** e.g. 'queued', 'sent', 'delivered', 'read', 'undelivered', 'failed'. */
  MessageStatus?: string;
  /** Present only on undelivered/failed — e.g. 63024. */
  ErrorCode?: string;
}
