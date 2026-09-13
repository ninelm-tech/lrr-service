/**
 * One unit of due work. A check matches only rows whose work is still
 * outstanding, claims them with a conditional update, and returns how many
 * it acted on. Acting must move the row out of its own match, so running a
 * check twice is harmless.
 */
export interface ReconcilerCheck {
  /** Used in logs and Sentry context — a bare stack trace from inside the loop identifies nothing. */
  readonly name: string;
  run(now: Date): Promise<number>;
}

export const RECONCILER_CHECKS = Symbol('RECONCILER_CHECKS');
