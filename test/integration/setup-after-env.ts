import { useTestDatabase } from './test-database';

// Runs inside each Jest worker, before PrismaService is constructed — it
// reads DATABASE_URL in its constructor, so this must happen first.
useTestDatabase();

// Migrations run once in globalSetup; a slow first connection shouldn't fail
// an otherwise healthy suite.
jest.setTimeout(30_000);
