// Prisma error codes the matcher treats as "another processor already wrote this": a unique
// violation (P2002) of an outcome, a payment or a ledger key. Read structurally so no Prisma
// runtime class has to be imported here. The PG exclusion violation (23P01) is NOT included:
// it would mean two reservations overlap, which is a bug to surface, not a replay.
function codeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

export function isUniqueViolation(error: unknown): boolean {
  return codeOf(error) === 'P2002';
}

function field(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null && name in value
    ? Reflect.get(value, name)
    : undefined;
}

function columnsOf(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  // The driver adapter may quote identifiers ('"senderId"'); the engine's meta.target does not.
  return value.map((column) => String(column).replace(/"/g, ''));
}

/** One unique key: its index name and its columns. */
export interface UniqueKey {
  readonly index: string;
  readonly columns: readonly string[];
}

/**
 * A unique violation (P2002) of exactly this key. With the pg driver adapter Prisma 7 names the
 * index in `meta.driverAdapterError.cause.constraint.index` (recorded against ggpin_test: the
 * ingest replay e2e, and the API's db-errors.ts); a column list (`meta.target`, or
 * `constraint.fields`) is accepted too. Any other key, or a shape that names neither, is NOT
 * this one: the caller then treats it as a real error.
 */
export function isUniqueViolationOn(error: unknown, key: UniqueKey): boolean {
  if (!isUniqueViolation(error)) return false;
  const meta = field(error, 'meta');
  const constraint = field(field(field(meta, 'driverAdapterError'), 'cause'), 'constraint');
  if (field(constraint, 'index') === key.index) return true;
  const named = columnsOf(field(meta, 'target')) ?? columnsOf(field(constraint, 'fields'));
  if (named === null) return false;
  return named.length === key.columns.length && key.columns.every((c) => named.includes(c));
}
