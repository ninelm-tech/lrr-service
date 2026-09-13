/**
 * A test double for AuditLogService, for unit specs whose subject calls
 * record() but whose assertions are about something else.
 */
export interface AuditLogServiceMock {
  record: jest.Mock;
}

export function createAuditLogServiceMock(
  overrides: Partial<AuditLogServiceMock> = {},
): AuditLogServiceMock {
  return {
    record: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}
