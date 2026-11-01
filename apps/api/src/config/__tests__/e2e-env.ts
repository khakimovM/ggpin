import type { Env } from '../env';
import { buildTestEnv } from './test-env';

// E2E suites use Redis logical DB 15 so they never read or delete keys of a dev worker or API
// running against DB 0 on the same Redis (e.g. `worker:heartbeat`).
export const E2E_REDIS_DB = 15;

/**
 * Builds the e2e config from DATABASE_URL / REDIS_URL (CI: Postgres on 5432; locally on 5433).
 * Refuses any database whose name does not end in `_test` (rules/70-testing.md), the same
 * guard packages/db uses. Error messages name the database, never the full URL (password).
 */
export function buildE2eEnv(): Env {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error('DATABASE_URL is not set; e2e tests need a database whose name ends in _test.');
  }
  const dbName = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
  if (!dbName.endsWith('_test')) {
    throw new Error(`Refusing to run e2e tests: database "${dbName}" does not end in "_test".`);
  }
  const redisUrl = new URL(process.env['REDIS_URL'] ?? 'redis://localhost:6379');
  redisUrl.pathname = `/${E2E_REDIS_DB}`;
  // Silent: e2e output stays readable; the logging suites opt in to capture explicitly.
  return buildTestEnv({
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl.toString(),
    LOG_LEVEL: 'silent',
  });
}
