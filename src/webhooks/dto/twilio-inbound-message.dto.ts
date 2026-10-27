/**
 * The parts of a Twilio inbound WhatsApp message payload that the
 * WAITING_FOR_CONTACT_INFO handler (WhatsAppCustomerFlowService) reads to
 * detect and process a native "share contact" reply to the
 * request_contact_info prompt.
 *
 * Deliberately partial and deliberately optional, same reasoning as
 * TwilioStatusCallbackBody: this is untrusted input arriving over HTTP, and
 * only a MessageType === 'contacts' delivery with the right ChannelMetadata
 * actually carries a MediaUrl0/MediaContentType0 pointing at a vCard — see
 * isContactShareWebhook.
 */
export interface TwilioInboundMessageBody {
  MessageType?: string;
  MediaUrl0?: string;
  MediaContentType0?: string;
  ChannelMetadata?: string;
}
