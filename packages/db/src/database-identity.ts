import type { Tx } from './ledger/ledger.js';

/**
 * Which database a process is really connected to (D-52 r2, inject guard; L-1 fix in r3): the
 * name Postgres reports (not the URL: pg lets `?host=`/`?database=` style options and SSH tunnels
 * make a URL look local) and the dev marker. The marker is read ONLY from the database-level
 * setting in `pg_catalog.pg_db_role_setting` (the row with `setrole = 0` for the current
 * database, written by `ALTER DATABASE ... SET ggpin.env = 'dev'`), never from
 * `current_setting()`: a session can set that itself (`?options=-c ggpin.env=dev` in the URL, or
 * PGOPTIONS) and so fake the marker, or hide it with `-c ggpin.env=`. The marker is set by
 * `db:seed` with NODE_ENV=development|test and by the compose init script (both `ggpin` and
 * `ggpin_test`, fresh volumes only). A production database never has it. Every catalog name is
 * schema-qualified so a `search_path` option cannot shadow it.
 */
export interface DatabaseIdentity {
  readonly name: string;
  /** `'dev'` when the database itself carries `ggpin.env=dev`, otherwise null. */
  readonly marker: string | null;
}

export const DEV_DATABASE_MARKER = 'dev';

export async function readDatabaseIdentity(db: Tx): Promise<DatabaseIdentity> {
  const rows = await db.$queryRaw<{ name: string; marker: string | null }[]>`
    SELECT pg_catalog.current_database() AS "name",
      CASE WHEN EXISTS (
        SELECT 1
        FROM pg_catalog.pg_db_role_setting AS s
        JOIN pg_catalog.pg_database AS d ON d.oid OPERATOR(pg_catalog.=) s.setdatabase
        WHERE s.setrole OPERATOR(pg_catalog.=) 0
          AND d.datname OPERATOR(pg_catalog.=) pg_catalog.current_database()
          AND 'ggpin.env=dev'::pg_catalog.text OPERATOR(pg_catalog.=) ANY (s.setconfig)
      ) THEN 'dev' END AS "marker"`;
  const row = rows[0];
  if (row === undefined) throw new Error('readDatabaseIdentity: no row');
  return { name: row.name, marker: row.marker === '' ? null : row.marker };
}

/**
 * Marks the connected database as a dev/test one (idempotent). Only the seed calls it, and only
 * with NODE_ENV=development or test (seed.ts); the marker lets dev tools such as the bank-feed
 * inject CLI run there, and makes a production boot refuse that database.
 */
export async function markDevDatabase(db: Tx): Promise<void> {
  await db.$executeRaw`DO $$ BEGIN
    EXECUTE format('ALTER DATABASE %I SET ggpin.env = %L', current_database(), 'dev');
  END $$`;
}

/** Why a NODE_ENV=production process must not use this database, or null (D-52 r2). */
export function productionDatabaseRefusal(identity: DatabaseIdentity): string | null {
  if (identity.marker === DEV_DATABASE_MARKER) {
    return 'the database carries the dev marker (ggpin.env = dev): a production process refuses it';
  }
  if (/_(dev|test)$/.test(identity.name)) {
    return 'the database name ends with _dev or _test: a production process refuses it';
  }
  return null;
}

/**
 * Why a dev-only tool must not write to this database, or null (D-52 r2, inject guard). Allowed
 * only when the database Postgres reports is the URL's one and ends with `_test`, or when the
 * database itself carries the dev marker. A name alone (`ggpin`, `ggpin_dev`) is never enough.
 */
export function devToolDatabaseRefusal(
  identity: DatabaseIdentity,
  urlDatabaseName: string,
): string | null {
  if (identity.marker === DEV_DATABASE_MARKER) return null;
  if (identity.name === urlDatabaseName && identity.name.endsWith('_test')) return null;
  return 'the database is neither a _test database nor marked dev (ggpin.env = dev, set by db:seed)';
}

/** Thrown at a production boot on a dev/test database (worker and API PrismaService). */
export class NonProductionDatabaseError extends Error {
  constructor(reason: string) {
    super(`production database check: ${reason}`);
    this.name = 'NonProductionDatabaseError';
  }
}

/** The production boot check (D-52 r2, symmetric to the dev-tool guard): one query, then refuse. */
export async function assertProductionDatabase(db: Tx): Promise<void> {
  const refusal = productionDatabaseRefusal(await readDatabaseIdentity(db));
  if (refusal !== null) throw new NonProductionDatabaseError(refusal);
}
