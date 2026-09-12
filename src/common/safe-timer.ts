import * as Sentry from '@sentry/node';

/**
 * setTimeout for a callback that returns a promise.
 *
 * `setTimeout(async () => …)` hands Node a promise nobody holds: any
 * rejection inside it is an *unhandled* rejection, and Node's default for
 * that is to terminate the process. Every scheduled job in this service —
 * the deposit window and its reminders, the rating timeout, the stalled
 * confirmation alert, the quote-selection timeout — runs from one of these
 * timers and starts with a database call. Neon suspends an idle compute
 * after five minutes, so a timer firing against a cold connection is an
 * entirely ordinary event; without this wrapper that single rejection kills
 * the task and takes every other pending timer down with it.
 *
 * `context` names the job in the log and in Sentry — a bare stack trace
 * from inside a timer gives no clue which one it was.
 */
export function scheduleSafely(
  callback: () => Promise<unknown>,
  delayMs: number,
  context: string,
): NodeJS.Timeout {
  return setTimeout(() => {
    void callback().catch((error: unknown) => {
      console.error(`Scheduled task "${context}" failed:`, error);
      Sentry.captureException(error, { extra: { scheduledTask: context } });
    });
  }, delayMs);
}
