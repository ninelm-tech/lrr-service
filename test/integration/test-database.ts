/**
 * Points integration tests at the throwaway Postgres from
 * docker-compose.test.yml, unless DATABASE_URL is already set (CI supplies
 * its own service container).
 *
 * Called from both the global setup and each worker: Jest workers are
 * separate processes, so an env var set in globalSetup alone would not
 * reliably reach the code under test.
 */
export const DEFAULT_TEST_DATABASE_URL =
  'postgresql://lrr:lrr@localhost:5433/lrr_test';

export function useTestDatabase(): string {
  const url = process.env.DATABASE_URL || DEFAULT_TEST_DATABASE_URL;

  // A test run that silently pointed at staging or production would be
  // catastrophic — these suites truncate every table between tests.
  if (!/localhost|127\.0\.0\.1/.test(url)) {
    throw new Error(
      `Refusing to run integration tests against a non-local database: ${url.replace(/:[^:@]+@/, ':***@')}`,
    );
  }

  process.env.DATABASE_URL = url;
  return url;
}
