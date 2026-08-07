export enum WhatsAppFlowState {
  IDLE = 'IDLE',
  WAITING_FOR_LOCATION = 'WAITING_FOR_LOCATION',
  WAITING_FOR_VEHICLE_TYPE = 'WAITING_FOR_VEHICLE_TYPE',
  WAITING_FOR_DESTINATION = 'WAITING_FOR_DESTINATION',
  WAITING_FOR_ISSUE_TYPE = 'WAITING_FOR_ISSUE_TYPE',
  WAITING_FOR_DEPOSIT = 'WAITING_FOR_DEPOSIT',
  REQUEST_CONFIRMED = 'REQUEST_CONFIRMED',

  // ── Operator states ───────────────────────────────────────
  // Set on operator's own session once they accept a job
  OPERATOR_ON_JOB = 'OPERATOR_ON_JOB',
  // Set after operator sends ARRIVED and customer is notified
  OPERATOR_AT_LOCATION = 'OPERATOR_AT_LOCATION',

  // ── Customer payment state ───────────────────────────────
  // Operator found and tentatively assigned; customer has 5 minutes to pay deposit.
  // Car/operator are NOT confirmed until payment lands.
  OPERATOR_FOUND_WAITING_PAYMENT = 'OPERATOR_FOUND_WAITING_PAYMENT',

  // ── Customer completion state ────────────────────────────
  // Set on customer's session after operator marks job DONE;
  // customer must reply CONFIRM to release car + trigger balance payment
  AWAITING_COMPLETION_CONFIRM = 'AWAITING_COMPLETION_CONFIRM',
}

export type IssueType = 'BREAKDOWN' | 'ACCIDENT' | 'FLAT_TYRE' | 'FUEL';

export interface WhatsAppSession {
  /** Always set — every session is owned by a User. */
  userId: string;
  state: WhatsAppFlowState;
  latitude?: number;
  longitude?: number;
  issueType?: IssueType;
  vehicleType?: string;
  destination?: string;
  rescueRequestId?: string;
  depositReference?: string;
  // Dispatch tracking — used during operator offer loop
  dispatchRound?: number;
  offeredOperatorIds?: string[];
  updatedAt: Date;
}
