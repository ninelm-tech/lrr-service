/**
 * The result of successfully parsing a phone number out of a vCard
 * (.vcf) file shared natively via WhatsApp's "share contact" feature.
 *
 * See `parseVCard` in `../domain/parse-vcard`.
 */
export interface ParsedContact {
  phoneNumber: string;
}
