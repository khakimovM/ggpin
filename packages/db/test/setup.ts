import { afterAll, beforeEach } from 'vitest';
import { requireTestDatabaseUrl } from './db-guard';
import { db, disconnect } from './client';

// Re-checked per file: a test file must never run if the URL changed since global setup.
requireTestDatabaseUrl(process.env['DATABASE_URL']);

// TRUNCATE (never DROP) keeps the migrated schema and resets state between tests.
beforeEach(async () => {
  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const list = tables.map((t) => `"${t.tablename}"`).join(', ');
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
});

afterAll(disconnect);
