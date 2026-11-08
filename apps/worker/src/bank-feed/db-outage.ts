// "The database is not there right now" vs "this message cannot be processed" (S6 N5). Only
// the first may wait: a short Postgres outage must not fail every in-flight message closed and
// pause its card. Read structurally (no Prisma runtime class imported), as prisma-errors.ts.

/** Prisma engine codes of an unreachable or dropped database, or an exhausted pool. */
const PRISMA_CONNECTION_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024']);

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
