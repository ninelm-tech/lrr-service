import { sanitizeTemplateVariable } from './template-variable.util';

describe('sanitizeTemplateVariable', () => {
  it('passes a clean single-line value through unchanged', () => {
    expect(sanitizeTemplateVariable('Lekki Phase 1')).toBe('Lekki Phase 1');
  });

  it('collapses a line break into a visible separator', () => {
    expect(sanitizeTemplateVariable('Line one\nLine two')).toBe(
      'Line one · Line two',
    );
  });

  it('collapses a CRLF line break the same way', () => {
    expect(sanitizeTemplateVariable('Line one\r\nLine two')).toBe(
      'Line one · Line two',
    );
  });

  it('collapses a blank line (newline, space, newline) to a single separator, not two', () => {
    expect(sanitizeTemplateVariable('a\n \nb')).toBe('a · b');
  });

  it('replaces stray tabs with a single space', () => {
    expect(sanitizeTemplateVariable('a\tb')).toBe('a b');
  });

  it('collapses runs of spaces down to one', () => {
    expect(sanitizeTemplateVariable('a    b')).toBe('a b');
  });

  it('trims leading and trailing whitespace', () => {
    expect(sanitizeTemplateVariable('  padded  ')).toBe('padded');
  });
});
