/**
 * A dispatch offer that has been written to the database but not yet sent.
 *
 * `prepareNextRound` returns these so its caller can commit the offer rows
 * inside its own transaction and send the WhatsApp messages only afterwards
 * — offers are exactly-once, messages are best-effort.
 */
export interface PendingOffer {
  operatorId: string;
  operatorPhone: string;
  jobRef: string;
  vehicle: string;
  destination: string;
  /** '' or 'Distance: X km\n' — trailing newline included. */
  distanceLine: string;
  /**
   * '' or 'Issue: X\n' — trailing newline included, informational only
   * (never used to filter or route dispatch). Freeform-send only for now —
   * see the comment on sendDispatchOfferMessage's templateVariables map.
   */
  issueLine: string;
  location: string;
  /** '' or the '\n\n📎 Photos/Video/Audio:\n...' block. */
  mediaSection: string;
  /** '' or 'Est. ETA: ~N min based on your registered location.\n'. */
  etaLine: string;
  window: string;
}
