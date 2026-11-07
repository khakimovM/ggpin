import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { checkE2eDatabaseUrl, maintenanceUrl, migrateOutputNamesDatabase } from './db-guard';

// Preparing the e2e database for journeys that run against the real API. Only ever creates a
// database and applies the committed migrations; nothing is dropped, truncated or reset.

const DB_PACKAGE = path.resolve(__dirname, '../../../../packages/db');

/**
 * The environment of the processes started here: a short allowlist, never the developer's own
 * shell (a DATABASE_URL or secret of theirs must not leak into the e2e API or the migration).
 *
 * One exception outside our hands: packages/db/prisma.config.ts loads `packages/db/.env` into the
 * migrate process when that file exists. Node's loadEnvFile never replaces a variable that is
 * already set, and DATABASE_URL is always set here, so the file cannot redirect the migration;
 * migrateDatabase also checks that Prisma reports the expected database.
 */
export function minimalEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Creates the database if it does not exist yet. Returns whether it was created. */
export async function ensureDatabase(databaseUrl: string): Promise<boolean> {
  const { name } = checkE2eDatabaseUrl(databaseUrl);
  const client = new pg.Client({ connectionString: maintenanceUrl(databaseUrl) });
  await client.connect();
  try {
    const found = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (found.rowCount === 1) return false;
    // An identifier cannot be a bound parameter; the guard has restricted the name to [a-z0-9_].
    await client.query(`CREATE DATABASE "${name}"`);
    return true;
  } finally {
    await client.end();
  }
}

/** `prisma migrate deploy` against this URL only (the committed migrations, in order). */
export function migrateDatabase(databaseUrl: string): void {
  const { name } = checkE2eDatabaseUrl(databaseUrl);
  const prismaCli = require.resolve('prisma/build/index.js', { paths: [DB_PACKAGE] });
  const result = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: DB_PACKAGE,
    env: { ...minimalEnv(), NODE_ENV: 'development', DATABASE_URL: databaseUrl },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`prisma migrate deploy failed:\n${result.stdout}\n${result.stderr}`);
  }
  // Belt and braces: it must have run against the database we meant, not one named elsewhere.
  if (!migrateOutputNamesDatabase(result.stdout, name)) {
    throw new Error(`prisma migrate deploy did not report database "${name}":\n${result.stdout}`);
  }
}
