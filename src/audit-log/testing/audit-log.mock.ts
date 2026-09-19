/**
 * A test double for AuditLogService, for unit specs whose subject calls
 * record()/review() but whose assertions are about something else.
 */
export interface AuditLogServiceMock {
  record: jest.Mock;
  review: jest.Mock;
}

export function createAuditLogServiceMock(
  overrides: Partial<AuditLogServiceMock> = {},
): AuditLogServiceMock {
  return {
    record: jest.fn().mockResolvedValue(undefined),
    review: jest.fn((id: string, reviewedBy: string) =>
      Promise.resolve({
        id,
        reviewedBy,
        reviewedAt: new Date(),
      }),
    ),
    ...overrides,
  };
}
