/**
 * Human support line — distinct from the platform's own WhatsApp bot
 * number. Used wherever a WhatsApp flow has to hand a customer off to a
 * person (e.g. cancellation once self-cancel is blocked by policy).
 *
 * wa.me deep links need the full international number with no '+', spaces,
 * or leading 0 — WhatsApp auto-linkifies this in outgoing message text, so
 * tapping it opens a chat with support directly.
 */
export const SUPPORT_WHATSAPP_NUMBER = '2348057700002';
export const SUPPORT_WHATSAPP_LINK = `https://wa.me/${SUPPORT_WHATSAPP_NUMBER}`;
