// "The database is not there right now" vs "this message cannot be processed" (S6 N5). Only
// the first may wait: a short Postgres outage must not fail every in-flight message closed and
// pause its card. Read structurally (no Prisma runtime class imported), as prisma-errors.ts.

/**
 * Prisma engine codes of an unreachable or dropped database, or an exhausted pool.
 *
 * P2028 (review L1): the interactive transaction did not start within `maxWait`, or ran past its
 * `timeout` (recorded against the test DB, apps/api db-errors.ts). The matcher's `maxWait` (4 s) is
 * below the pool's connection timeout (5 s, @repo/db), so an exhausted pool shows up as P2028, not
 * as P2024. Waiting it out is safe: Prisma rolls the transaction back (and Postgres drops an
 * uncommitted one with its connection), so nothing of the attempt stays; a COMMIT that did land
 * anyway is found by the retry, because MatcherService.process starts from the stored outcome
 * (unique per message, as are the Payment and the ledger key) and only re-runs the idempotent
 * effects. The delay spends no attempt; after MAX_DB_OUTAGE_WAITS the usual attempts and
 * fail-closed follow, so even a P2028 that keeps coming never ends silently.
 */
const PRISMA_CONNECTION_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028']);

/** Driver-adapter (`@prisma/adapter-pg`) error kinds of the same situations. */
const ADAPTER_CONNECTION_KINDS = new Set([
  'DatabaseNotReachable',
  'ConnectionClosed',
  'SocketTimeout',
  'TooManyConnections',
]);

/**
 * Postgres SQLSTATEs of a server that is going away or not accepting connections yet: class 08
 * (connection exception), 57P01 admin_shutdown, 57P02 crash_shutdown, 57P03 cannot_connect_now.
 */
function isConnectionSqlState(code: unknown): boolean {
  return typeof code === 'string' && (code.startsWith('08') || /^57P0[123]$/.test(code));
}

function field(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null && name in value
    ? Reflect.get(value, name)
    : undefined;
}

function adapterCauseIsConnection(error: unknown): boolean {
  const cause = field(field(field(error, 'meta'), 'driverAdapterError'), 'cause');
  const kind = field(cause, 'kind');
  if (typeof kind === 'string' && ADAPTER_CONNECTION_KINDS.has(kind)) return true;
  return (
    kind === 'postgres' &&
    isConnectionSqlState(field(cause, 'originalCode') ?? field(cause, 'code'))
  );
}

/**
 * True for an error that says the database could not be reached or dropped the connection
 * (checked on the error and up to three `cause` levels). A constraint violation, a lock timeout
 * (55P03), a trigger refusal or any other data error is NOT one: that still fails closed.
 */
export function isDbConnectionError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    const code = field(current, 'code');
    if (typeof code === 'string' && PRISMA_CONNECTION_CODES.has(code)) return true;
    if (adapterCauseIsConnection(current)) return true;
    if (isConnectionSqlState(code) && typeof field(current, 'severity') === 'string') return true;
    // node-postgres' own wording when the server closes the socket under it.
    if (current instanceof Error && /^Connection terminated/.test(current.message)) return true;
    current = field(current, 'cause');
  }
  return false;
}
