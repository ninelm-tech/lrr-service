export interface ParsedWhatsAppSender {
  phoneNumber: string | null;
  externalUserId: string | null;
}

const WHATSAPP_PREFIX = /^whatsapp:/i;
const BSUID_SHAPE = /^[A-Za-z]{2}\.[A-Za-z0-9]+$/;

function stripWhatsAppPrefix(value: string): string {
  return value.replace(WHATSAPP_PREFIX, '');
}

export function parseWhatsAppSender(
  from: string,
  externalUserId?: string,
): ParsedWhatsAppSender {
  const strippedFrom = stripWhatsAppPrefix(from);
  const strippedExternalUserId = externalUserId
    ? stripWhatsAppPrefix(externalUserId)
    : undefined;

  if (strippedFrom.startsWith('+')) {
    return {
      phoneNumber: strippedFrom,
      externalUserId: strippedExternalUserId ?? null,
    };
  }

  if (strippedExternalUserId && BSUID_SHAPE.test(strippedExternalUserId)) {
    return { phoneNumber: null, externalUserId: strippedExternalUserId };
  }

  if (BSUID_SHAPE.test(strippedFrom)) {
    return { phoneNumber: null, externalUserId: strippedFrom };
  }

  return { phoneNumber: null, externalUserId: null };
}
