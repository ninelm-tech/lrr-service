/**
 * How long after an operator marks a job DONE we wait for the customer to
 * confirm before alerting staff. Never an auto-complete — see
 * WhatsAppOperatorFlowService.handleOperatorJobDone.
 */
export const STALLED_CONFIRMATION_MS = 30 * 60 * 1000;
