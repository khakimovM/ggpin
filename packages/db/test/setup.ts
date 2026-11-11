import { afterAll, beforeEach } from 'vitest';
import { requireTestDatabaseUrl } from './db-guard';
import { db, disconnect } from './client';

// Re-checked per file: a test file must never run if the URL changed since global setup.
requireTestDatabaseUrl(process.env['DATABASE_URL']);

// TRUNCATE (never DROP) keeps the migrated schema and resets state between tests.
async function truncateAll(): Promise<void> {
  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const list = tables.map((t) => `"${t.tablename}"`).join(', ');
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

beforeEach(truncateAll);

// Also after the file: the e2e suites of the api, the worker and the flow run next on the same
// database and treat any live TopupCard they did not create as foreign (a card left by the last
// test here failed them).
afterAll(async () => {
  try {
    await truncateAll();
  } finally {
    await disconnect();
  }
});
