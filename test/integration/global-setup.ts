import { execSync } from 'child_process';
import { useTestDatabase } from './test-database';

/**
 * Builds the schema once per run, from the real migrations rather than
 * `db push` — so these tests exercise the same DDL production gets, and a
 * broken migration fails here instead of on deploy.
 */
export default function globalSetup(): void {
  const url = useTestDatabase();

  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
  });
}
