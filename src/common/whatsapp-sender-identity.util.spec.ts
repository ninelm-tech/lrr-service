import { parseWhatsAppSender } from './whatsapp-sender-identity.util';

describe('parseWhatsAppSender', () => {
  it('returns the real phone number and the BSUID when both are present', () => {
    const result = parseWhatsAppSender(
      'whatsapp:+2348012345678',
      'whatsapp:CA.1234567890123456',
    );
    expect(result).toEqual({
      phoneNumber: '+2348012345678',
      externalUserId: 'CA.1234567890123456',
    });
  });

  it('returns only the BSUID when the sender has no visible phone number', () => {
    const result = parseWhatsAppSender('whatsapp:CA.1234567890123456');
    expect(result).toEqual({
      phoneNumber: null,
      externalUserId: 'CA.1234567890123456',
    });
  });

  it('returns only the phone number when no ExternalUserId is given', () => {
    const result = parseWhatsAppSender('whatsapp:+15550100003');
    expect(result).toEqual({
      phoneNumber: '+15550100003',
      externalUserId: null,
    });
  });

  it('treats a value matching neither shape as unresolvable, never as a phone number', () => {
    const result = parseWhatsAppSender('whatsapp:not-a-real-value');
    expect(result.phoneNumber).toBeNull();
  });
});
