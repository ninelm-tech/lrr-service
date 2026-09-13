import { Prisma } from '@prisma/client';

export interface RecordAuditLogInput {
  /** A plain string, not an enum — a new category is a new string at the
   * call site, never a migration. */
  category: string;
  message: string;
  /** Structured context (ids, amounts, changed fields) — never secrets or
   * full payment card/bank details. */
  details?: Prisma.InputJsonValue;
  /** The user who did it. Omit for a system-detected anomaly — nobody
   * "did" those. */
  actorId?: string;
}
