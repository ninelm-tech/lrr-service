import { ParsedContact } from '../dto/parsed-contact.dto';

const TEL_LINE_PATTERN = /^TEL(;[^:]*)?:/i;
const PLAUSIBLE_PHONE_NUMBER_PATTERN = /^\+\d{8,15}$/;

export function parseVCard(vCardText: string): ParsedContact | undefined {
  const telLine = vCardText
    .split('\n')
    .map((line) => line.trim())
    .find((line) => TEL_LINE_PATTERN.test(line));

  if (telLine === undefined) {
    return undefined;
  }

  const rawValue = telLine.slice(telLine.lastIndexOf(':') + 1);
  const phoneNumber = rawValue.replace(/[^\d+]/g, '');

  if (!PLAUSIBLE_PHONE_NUMBER_PATTERN.test(phoneNumber)) {
    return undefined;
  }

  return { phoneNumber };
}

export function isContactShareWebhook(body: {
  MessageType?: string;
  ChannelMetadata?: string;
}): boolean {
  if (body.MessageType !== 'contacts') {
    return false;
  }

  try {
    const metadata = JSON.parse(body.ChannelMetadata ?? '');
    return metadata?.data?.context?.Origin === 'contact_request';
  } catch {
    return false;
  }
}
