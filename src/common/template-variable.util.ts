/**
 * WhatsApp rejects template *parameters* (not static body text) containing
 * newlines, tabs, or more than four consecutive spaces; Twilio surfaces
 * this as error 21656 — see https://www.twilio.com/docs/errors/21656.
 * Several of our values (distance+ETA, address+map link, media links, a
 * customer-typed destination) are naturally multi-line, so collapse them
 * onto a single line for the template branch only. The freeform fallback
 * keeps real line breaks.
 */
export function sanitizeTemplateVariable(value: string): string {
  return (
    value
      .trim()
      // Line breaks → one visible separator. The repeated group (not a bare
      // [\r\n]+) matters: a blank line is "\n \n" — a space sitting BETWEEN
      // two newlines, not adjacent to either in one run — and a regex that
      // only matched one contiguous [\r\n]+ span per replace would emit two
      // separators for it ("a · · b") instead of one.
      .replace(/[\t ]*(?:[\r\n][\t ]*)+/g, ' · ')
      .replace(/\t+/g, ' ') // stray tabs
      .replace(/ {2,}/g, ' ') // runs of spaces (4+ consecutive is rejected)
      .trim()
  );
}
