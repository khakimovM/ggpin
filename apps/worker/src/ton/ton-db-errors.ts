// SQLSTATEs the TON repositories react to, read structurally (no Prisma runtime class imported):
// Prisma 7 with the pg driver adapter puts the server's code in
// `meta.driverAdapterError.cause.originalCode`; node-postgres errors carry it in `code`; the
// guards of migration 10 also write it into the message ("... GG001"). Causes are followed a few
// levels deep, like db-outage.ts does.

function field(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null && name in value
    ? Reflect.get(value, name)
    : undefined;
}

function hasSqlState(error: unknown, state: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    const adapterCause = field(field(field(current, 'meta'), 'driverAdapterError'), 'cause');
    if (field(adapterCause, 'originalCode') === state) return true;
    if (field(current, 'code') === state) return true;
    if (current instanceof Error && current.message.includes(state)) return true;
    current = field(current, 'cause');
  }
  return false;
}

/** A guard trigger of migration 10 refused the write (SQLSTATE GG001): the state moved under us. */
export function isGuardRefusal(error: unknown): boolean {
  return hasSqlState(error, 'GG001');
}

/**
 * Postgres aborted the transaction to break a deadlock (40P01). Everything was rolled back, so
 * the whole transaction may run again; it is never an "unknown outcome" (docs/06, R4-1).
 */
export function isDeadlock(error: unknown): boolean {
  return hasSqlState(error, '40P01');
}

/** A short, value-free description of an error for a log line: its class and code only. */
export function errorKind(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  const code = field(error, 'code');
  return typeof code === 'string' ? `${name}(${code})` : name;
}
