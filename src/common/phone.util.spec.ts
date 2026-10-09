import { BadRequestException } from '@nestjs/common';
import { normalizePhone } from './phone.util';

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
