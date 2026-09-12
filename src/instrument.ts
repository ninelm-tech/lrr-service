/**
 * Sentry instrumentation — MUST be imported before anything else in main.ts.
 * @see https://docs.sentry.io/platforms/node/guides/nestjs/
 */
import * as Sentry from '@sentry/node';

const isProd = process.env.NODE_ENV === 'production';

// nodeProfilingIntegration requires a native binary tied to the exact Node.js
// version. Load it lazily so a missing binary never crashes the process —
// profiling is a nice-to-have, not a hard requirement.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let profilingIntegrations: any[] = [];
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { nodeProfilingIntegration } = require('@sentry/profiling-node') as typeof import('@sentry/profiling-node');
  profilingIntegrations = [nodeProfilingIntegration()];
} catch {
  console.warn('[Sentry] nodeProfilingIntegration not available on this Node version — profiling disabled.');
}

Sentry.init({
  dsn: process.env.SENTRY_DSN,

  environment: process.env.NODE_ENV,

  // Structured logs (Sentry.logger.*) — lets us follow a user's journey
  // (registration attempts, conflicts, login failures) without needing an
  // exception to be thrown, so a route can be "working" and still show where
  // real users get stuck.
  enableLogs: true,

  // 100% tracing in dev + staging; 20% in production to control volume/cost
  tracesSampleRate: isProd ? 0.2 : 1.0,

  // Profiling sample rate (relative to tracesSampleRate)
  profilesSampleRate: profilingIntegrations.length > 0 ? (isProd ? 0.5 : 1.0) : 0,

  integrations: profilingIntegrations,

  // Tags applied to every event — visible in the Sentry issue list
  initialScope: {
    tags: { service: 'lrr-service' },
  },
});
