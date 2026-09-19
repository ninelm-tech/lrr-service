import { IssueType, RescueRequestStatus } from '@prisma/client';

export function formatIssueType(issueType: IssueType): string {
  return issueType
    .replace('_', ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function formatStatus(status: RescueRequestStatus): string {
  return status
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * A short, stable tag an operator can use to tell concurrent jobs apart
 * across WhatsApp messages — otherwise "reply with your price" for three
 * simultaneous dispatches reads as one indistinguishable stream. Not
 * cryptographically anything, just the tail of the request's cuid,
 * uppercased for readability (e.g. "Job #A1B2C3").
 */
export function formatJobRef(rescueRequestId: string): string {
  return `Job #${rescueRequestId.slice(-6).toUpperCase()}`;
}

/**
 * Builds the "Photos/Video/Audio" section appended to the operator offer
 * message. Best-effort: if API_BASE_URL isn't configured, the section is
 * simply omitted — this must never block the dispatch offer itself.
 */
export function buildMediaLinksSection(
  mediaItems: Array<{ id: string }>,
): string {
  if (mediaItems.length === 0) return '';

  const apiBaseUrl = process.env.API_BASE_URL;
  if (!apiBaseUrl) return '';

  const links = mediaItems
    .map((item) => `${apiBaseUrl}/api/v1/media/${item.id}`)
    .join('\n');

  return `\n\n📎 Photos/Video/Audio:\n${links}`;
}
