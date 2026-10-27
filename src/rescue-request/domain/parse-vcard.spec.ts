import { parseVCard, isContactShareWebhook } from './parse-vcard';

describe('parseVCard', () => {
  it('extracts the phone number from a TEL line', () => {
    const vcard =
      'BEGIN:VCARD\nVERSION:3.0\nFN:Jane Doe\nTEL;type=CELL;waid=15550100001:+15550100001\nEND:VCARD';
    expect(parseVCard(vcard)).toEqual({ phoneNumber: '+15550100001' });
  });

  it('returns undefined when there is no TEL line at all', () => {
    const vcard = 'BEGIN:VCARD\nFN:Jane Doe\nEMAIL:jane@example.com\nEND:VCARD';
    expect(parseVCard(vcard)).toBeUndefined();
  });

  it('returns undefined when the TEL value is not a plausible phone number', () => {
    const vcard = 'BEGIN:VCARD\nTEL:not-a-number\nEND:VCARD';
    expect(parseVCard(vcard)).toBeUndefined();
  });

  it('returns undefined for a bare national-format number with no country code', () => {
    const vcard = 'BEGIN:VCARD\nTEL:08031234567\nEND:VCARD';
    expect(parseVCard(vcard)).toBeUndefined();
  });

  it('takes the first TEL line when there are several', () => {
    const vcard =
      'BEGIN:VCARD\nTEL;type=CELL:+15550100001\nTEL;type=HOME:+15550100002\nEND:VCARD';
    expect(parseVCard(vcard)?.phoneNumber).toBe('+15550100001');
  });

  it('strips formatting characters but keeps the leading +', () => {
    const vcard = 'BEGIN:VCARD\nTEL:+1 (555) 010-0001\nEND:VCARD';
    expect(parseVCard(vcard)?.phoneNumber).toBe('+15550100001');
  });
});

describe('isContactShareWebhook', () => {
  it('is true for a contacts message tied to our request', () => {
    expect(
      isContactShareWebhook({
        MessageType: 'contacts',
        ChannelMetadata: JSON.stringify({
          data: { context: { Origin: 'contact_request' } },
        }),
      }),
    ).toBe(true);
  });

  it('is false when MessageType is not contacts', () => {
    expect(
      isContactShareWebhook({ MessageType: 'text', ChannelMetadata: '{}' }),
    ).toBe(false);
  });

  it('is false when ChannelMetadata is missing or unparseable', () => {
    expect(isContactShareWebhook({ MessageType: 'contacts' })).toBe(false);
    expect(
      isContactShareWebhook({
        MessageType: 'contacts',
        ChannelMetadata: 'not json',
      }),
    ).toBe(false);
  });
});
