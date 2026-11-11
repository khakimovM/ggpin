// Which database rule refused a PaymentIntent INSERT. Prisma 7 with the pg driver adapter puts
// the Postgres details under `meta.driverAdapterError.cause` (recorded against the test
// database while building S4):
//   unique  -> code P2002, cause.constraint.index = "<index name>"
//   EXCLUDE -> code P2039, cause.originalCode = "23P01", message names the constraint
// The service reacts differently to each, so the index names are spelled out here once.

export type IntentInsertConflict =
  /** Another request took the same amount on the card first: retry with another suffix. */
  | 'AMOUNT_TAKEN'
  /** The user already has a PENDING P2P request (partial unique). */
  | 'USER_PENDING'
  /** The same Idempotency-Key was used concurrently. */
  | 'IDEMPOTENCY_KEY';

const UNIQUE_INDEX: Readonly<Record<string, IntentInsertConflict>> = {
  PaymentIntent_card_amount_pending_key: 'AMOUNT_TAKEN',
  PaymentIntent_user_pending_p2p_key: 'USER_PENDING',
  PaymentIntent_userId_idempotencyKey_key: 'IDEMPOTENCY_KEY',
};
const EXCLUSION_SQLSTATE = '23P01';
const EXCLUSION_NAME = 'PaymentIntent_card_amount_reserved_excl';

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function adapterCause(error: unknown): unknown {
  return field(field(field(error, 'meta'), 'driverAdapterError'), 'cause');
}

/** The conflict an INSERT ran into, or null for any other error (which the caller rethrows). */
export function intentInsertConflict(error: unknown): IntentInsertConflict | null {
  const code = field(error, 'code');
  const cause = adapterCause(error);
  if (code === 'P2002') {
    const index = field(field(cause, 'constraint'), 'index');
    return typeof index === 'string' ? (UNIQUE_INDEX[index] ?? null) : null;
  }
  const sqlState = field(cause, 'originalCode') ?? field(cause, 'code');
  if (sqlState === EXCLUSION_SQLSTATE) {
    const message = field(cause, 'originalMessage');
    // Only our reservation constraint means "amount taken"; any other exclusion is unexpected.
    return typeof message === 'string' && message.includes(EXCLUSION_NAME) ? 'AMOUNT_TAKEN' : null;
  }
  return null;
}

/** The unique index named `index` refused the write (Prisma P2002 naming exactly that index). */
export function isUniqueViolation(error: unknown, index: string): boolean {
  return (
    field(error, 'code') === 'P2002' &&
    field(field(adapterCause(error), 'constraint'), 'index') === index
  );
}

// Shapes recorded against the test database (S4 review, m5):
//   lock_timeout on pg_advisory_xact_lock -> P2010, cause.originalCode = "55P03"
//   interactive transaction past its timeout, or not started within maxWait -> P2028
// P2024 is Prisma's documented "timed out fetching a connection from the pool".
const BUSY_CODES: ReadonlySet<unknown> = new Set(['P2028', 'P2024']);
const LOCK_NOT_AVAILABLE = '55P03';

/**
 * `lock_timeout` ran out (55P03). Usually on this card's advisory lock (the card is busy, another
 * may not be), sometimes on the INSERT waiting for a twin request's uncommitted row. Either way
 * the attempt wrote nothing and its transaction is gone.
 */
export function isLockNotAvailable(error: unknown): boolean {
  const cause = adapterCause(error);
  return (field(cause, 'originalCode') ?? field(cause, 'code')) === LOCK_NOT_AVAILABLE;
}

/**
 * The database itself was too busy (no pooled connection, or the transaction not started or not
 * finished in time). Unlike a busy card, another card would not help: the caller answers 503.
 */
export function isDatabaseBusy(error: unknown): boolean {
  return BUSY_CODES.has(field(error, 'code'));
}
