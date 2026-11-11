// The e2e database guard. Pure (no I/O), so it is unit-tested (src/lib/e2e-db-guard.test.ts).

export const DEFAULT_E2E_DATABASE_URL =
  'postgresql://ggpin:ggpin@localhost:5433/ggpin_web_e2e_test';

// A dedicated database: lower-case letters, digits and underscores only (so the name is safe to
// quote as an identifier), ending in `_test`, at most 63 bytes in all. Postgres cuts an identifier
// longer than that SILENTLY, so a 64+ character name could end up (without its `_test`) as a
// different database than the one the guard approved. 58 + `_test` (5) = 63.
const DATABASE_NAME = /^[a-z0-9_]{1,58}_test$/;

// Parsed `URL.hostname` values: an IPv6 address keeps its brackets.
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

// The database the backend e2e suites clear on every run.
const BACKEND_SHARED_DATABASES: ReadonlySet<string> = new Set(['ggpin_test']);

export interface E2eDatabase {
  url: string;
  name: string;
}

/**
 * Checks `E2E_DATABASE_URL` (or the local default) and returns it with the database name.
 * The name is judged AFTER percent-decoding, because that is what the server receives:
 * `ggpin%5Ftest` is `ggpin_test`, and a name carrying `%` is refused outright.
 */
export function checkE2eDatabaseUrl(url: string): E2eDatabase {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('E2E_DATABASE_URL is not a valid URL.');
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error('E2E_DATABASE_URL must be a postgresql:// URL.');
  }
  // The journeys write to this database directly (cards, reads): only ever on this machine.
  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error('E2E_DATABASE_URL must point at this machine (localhost, 127.0.0.1 or ::1).');
  }
  let name: string;
  try {
    name = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  } catch {
    throw new Error('E2E_DATABASE_URL has a malformed database name.');
  }
  if (name.includes('%')) {
    throw new Error('E2E_DATABASE_URL: the database name must not contain "%".');
  }
  if (BACKEND_SHARED_DATABASES.has(name)) {
    throw new Error(
      `E2E_DATABASE_URL must not name "${name}": the backend suites clear it on every run.`,
    );
  }
  if (!DATABASE_NAME.test(name)) {
    throw new Error(
      `E2E_DATABASE_URL must name a dedicated database matching ${String(DATABASE_NAME)}; got "${name}".`,
    );
  }
  return { url, name };
}

/** The same server and credentials, on the `postgres` maintenance database. */
export function maintenanceUrl(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

export function e2eDatabase(): E2eDatabase {
  return checkE2eDatabaseUrl(process.env.E2E_DATABASE_URL ?? DEFAULT_E2E_DATABASE_URL);
}

/**
 * Whether the output of `prisma migrate deploy` says it worked on THIS database. The line it
 * prints (checked against a real run, Prisma 7) is
 * `Datasource "db": PostgreSQL database "<name>", schema "public" at "<host>:<port>"`.
 */
export function migrateOutputNamesDatabase(output: string, name: string): boolean {
  return output.includes(`PostgreSQL database "${name}"`);
}
