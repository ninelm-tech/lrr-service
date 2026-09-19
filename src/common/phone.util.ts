/**
 * Normalises a Nigerian phone number to E.164 (+234XXXXXXXXXX).
 *
 * Call this ONLY at registration time (web form → API).
 * Twilio inbound messages already arrive as "+234..." so the WhatsApp
 * message handler should never need this — it just strips "whatsapp:".
 *
 * Handles:
 *   "08012345678"    → "+2348012345678"  (local format)
 *   "8012345678"     → "+2348012345678"  (10-digit, no leading 0)
 *   "2348012345678"  → "+2348012345678"  (missing +)
 *   "+2348012345678" → "+2348012345678"  (already correct — no-op)
 *
 * Throws if the result is not a valid Nigerian number (+234 + 10 digits).
 */
export function normalizePhone(raw: string): string {
  if (!raw) throw new Error('Phone number is required');

  let phone = raw.trim();
  const hasPlus = phone.startsWith('+');
  phone = phone.replace(/\D/g, ''); // keep digits only

  if (phone.startsWith('234')) {
    phone = '+' + phone; // 2348012345678 → +2348012345678
  } else if (phone.startsWith('0')) {
    phone = '+234' + phone.slice(1); // 08012345678 → +2348012345678
  } else if (phone.length === 10) {
    phone = '+234' + phone; // 8012345678 → +2348012345678
  } else if (hasPlus) {
    phone = '+' + phone;
  } else {
    phone = '+234' + phone;
  }

  if (!/^\+234\d{10}$/.test(phone)) {
    throw new Error(`Invalid Nigerian phone number: "${raw}" → "${phone}"`);
  }

  return phone;
}

/**
 * Formats a +234... number for Twilio's WhatsApp API.
 * Assumes the input is already valid E.164 — no normalization performed.
 * "+2348012345678" → "whatsapp:+2348012345678"
 */
export function toWhatsAppAddress(phone: string): string {
  return `whatsapp:${phone}`;
}
