import { BadRequestException } from '@nestjs/common';
import { normalizePhone, toWhatsAppDestination } from './phone.util';

describe('normalizePhone', () => {
  it('normalizes a local-format number', () => {
    expect(normalizePhone('08012345678')).toBe('+2348012345678');
  });

  it('normalizes a 10-digit number with no leading zero', () => {
    expect(normalizePhone('8012345678')).toBe('+2348012345678');
  });

  it('normalizes a number missing the +', () => {
    expect(normalizePhone('2348012345678')).toBe('+2348012345678');
  });

  it('leaves an already-correct E.164 number unchanged', () => {
    expect(normalizePhone('+2348012345678')).toBe('+2348012345678');
  });

  it('throws BadRequestException, not a plain Error, for a non-Nigerian number', () => {
    // A plain Error here is what made this surface as a bare 500 instead of
    // a clean 400 — NestJS's default filter only maps HttpException
    // subclasses to the right status code.
    expect(() => normalizePhone('19054628168')).toThrow(BadRequestException);
  });

  it('includes the original input in the error message', () => {
    expect(() => normalizePhone('19054628168')).toThrow(/19054628168/);
  });

  it('throws BadRequestException for an empty string', () => {
    expect(() => normalizePhone('')).toThrow(BadRequestException);
  });
});

describe('toWhatsAppDestination', () => {
  it('prefers the phone number when present', () => {
    expect(
      toWhatsAppDestination({
        phoneNumber: '+2348012345678',
        whatsappExternalUserId: 'CA.123',
      }),
    ).toBe('whatsapp:+2348012345678');
  });

  it('falls back to the BSUID when there is no phone number', () => {
    expect(
      toWhatsAppDestination({
        phoneNumber: null,
        whatsappExternalUserId: 'CA.123',
      }),
    ).toBe('whatsapp:CA.123');
  });

  it('throws when neither a phone number nor a BSUID is present, rather than producing "whatsapp:null" (multi-llm review finding, hotfix 2026-10-25)', () => {
    expect(() =>
      toWhatsAppDestination({
        phoneNumber: null,
        whatsappExternalUserId: null,
      }),
    ).toThrow();
  });
});
