// The attempt cap of fulfillment (S4 review CR m5; plan S10 fix round, item 1): how many send
// attempts an order gets before the core holds it, and which attempts count. This is the rule the
// worker applies in apps/worker fulfill-fresh.ts (`MAX_SEND_ATTEMPTS`, held-policy.ts
// `isAttemptHoldError`); the worker still keeps its own copy until it moves here (phase 5 S9), and
// a test in apps/api (order-admin-rules.spec.ts) reads the worker's source to hold the two together.
//
// The owner CLI (`order:retry`) uses it to recognise an order the worker would hold again at once:
// it COUNTS the attempts under the order lock instead of reading the HELD event's note, so a change
// of the note's wording can never make the check silently pass.

/**
 * How many send attempts one order gets before it is HELD (ADAPTER_ERROR) instead of trying again.
 * A new attempt is made only after the previous one was PROVEN not sent (docs/06, D-60 (2)).
 */
export const MAX_SEND_ATTEMPTS = 2;

/**
 * `FulfillmentAttempt.error` values of an attempt that a HOLD failed before anything was signed
 * (the TON module's limits, balance and payee allowlist). Such an attempt sent nothing and does
 * not count against MAX_SEND_ATTEMPTS.
 */
export const ATTEMPT_HOLD_ERRORS = [
  'LIMIT_PER_ORDER',
  'LIMIT_DAILY',
  'LOW_BALANCE',
  'PAY_ADDRESS_NOT_ALLOWED',
] as const;

/** `error` prefix of the core's hold after the wallet stayed unusable through the last retry. */
export const TON_NOT_SENT_ERROR_PREFIX = 'TON_NOT_SENT_';

/** True when the attempt was failed by a hold, not by a payout proven not sent. */
export function isAttemptHoldError(error: string | null): boolean {
  if (error === null) return false;
  return (
    ATTEMPT_HOLD_ERRORS.some((known) => known === error) ||
    error.startsWith(TON_NOT_SENT_ERROR_PREFIX)
  );
}

/** How many of the order's attempts count against MAX_SEND_ATTEMPTS. */
export function sendAttemptsUsed(attempts: readonly { readonly error: string | null }[]): number {
  return attempts.filter((attempt) => !isAttemptHoldError(attempt.error)).length;
}

/**
 * True when the worker's next fresh run would hold the order again before any payout: every send
 * attempt it gets was used (fulfill-fresh.ts, the first check of `run`).
 */
export function attemptLimitReached(
  attempts: readonly { readonly error: string | null }[],
): boolean {
  return sendAttemptsUsed(attempts) >= MAX_SEND_ATTEMPTS;
}

/** The note of a HELD event the core writes before any attempt existed (held-policy.ts). */
export const CORE_HOLD_NOTE_PREFIX = 'core hold: ';

/** The core hold's note, exactly as the worker writes it: `core hold: <REASON> (<why>)`. */
export function coreHoldNote(reason: string, why: string): string {
  return `${CORE_HOLD_NOTE_PREFIX}${reason} (${why})`;
}

/** The `why` of the attempt-cap hold (fulfill-fresh.ts). Informational only: never matched on. */
export const ATTEMPT_LIMIT_HOLD_WHY = 'every attempt was proven not sent';
