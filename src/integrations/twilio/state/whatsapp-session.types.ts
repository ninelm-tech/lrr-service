export enum WhatsAppFlowState {
  IDLE = 'IDLE',
  WAITING_FOR_LOCATION = 'WAITING_FOR_LOCATION',
  WAITING_FOR_ISSUE_TYPE = 'WAITING_FOR_ISSUE_TYPE',
  REQUEST_CONFIRMED = 'REQUEST_CONFIRMED',
}

export type IssueType = 'BREAKDOWN' | 'ACCIDENT' | 'FLAT_TYRE' | 'FUEL';

export interface WhatsAppSession {
  phoneNumber: string;
  state: WhatsAppFlowState;
  latitude?: number;
  longitude?: number;
  issueType?: IssueType;
  updatedAt: Date;
}