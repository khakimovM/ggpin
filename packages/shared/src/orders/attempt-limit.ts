// The attempt cap of fulfillment (S4 review CR m5; plan S10 fix round, item 1): how many send
// attempts an order gets before the core holds it, and which attempts count. This is the rule the
// worker applies in apps/worker fulfill-fresh.ts (`MAX_SEND_ATTEMPTS`, held-policy.ts
// `isAttemptHoldError`); the worker still keeps its own copy until it moves here (phase 5 S9), and
// a test in apps/api (order-admin-rules.spec.ts) reads the worker's source to hold the two together.
//
// Phase 5 S9 (D-64 (5), D-66): an OWNER release starts the count again. The release's audit row
// stores the highest attempt number at that moment (`before.maxAttemptNo`, S9b); only attempts
// numbered above it (`releasedAfterAttemptNo`) count. An OPERATOR retry or a SYSTEM row resets
// nothing (Q-20); choosing which row counts is the caller's job.
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

/** An attempt as the cap reads it: its `error` decides whether it counts. */
export interface AttemptErrorRow {
  readonly error: string | null;
}

/** An attempt with its number, for a count that starts at an operator release. */
export interface NumberedAttemptRow extends AttemptErrorRow {
  readonly attemptNo: number;
}

type MaybeNumberedAttemptRow = AttemptErrorRow & { readonly attemptNo?: number };

function isPositiveInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0;
}

/**
 * False only for an attempt the OWNER's release already covered: its `attemptNo` is at most
 * `releasedAfterAttemptNo` (the highest attempt number when the OWNER released the order, stored
 * in the release's audit row, D-66). Numbers, not clocks: one writer, no tie at the same ms, no
 * Invalid Date. Fail-closed: a release, or an attempt number, that is not a positive integer never
 * hides an attempt: counting too many holds the order sooner, never pays twice.
 */
function countsAfterRelease(
  attempt: MaybeNumberedAttemptRow,
  releasedAfterAttemptNo: number | null | undefined,
): boolean {
  if (releasedAfterAttemptNo === null || releasedAfterAttemptNo === undefined) return true;
  if (!isPositiveInteger(releasedAfterAttemptNo)) return true;
  const { attemptNo } = attempt;
  if (!isPositiveInteger(attemptNo)) return true;
  return attemptNo > releasedAfterAttemptNo;
}

/**
 * How many of the order's attempts count against MAX_SEND_ATTEMPTS. With
 * `releasedAfterAttemptNo` (the OWNER's latest release) only attempts numbered above it count.
 */
export function sendAttemptsUsed(attempts: readonly AttemptErrorRow[]): number;
export function sendAttemptsUsed(
  attempts: readonly NumberedAttemptRow[],
  releasedAfterAttemptNo?: number | null,
): number;
export function sendAttemptsUsed(
  attempts: readonly MaybeNumberedAttemptRow[],
  releasedAfterAttemptNo?: number | null,
): number {
  return countSendAttempts(attempts, releasedAfterAttemptNo);
}

/**
 * True when the worker's next fresh run would hold the order again before any payout: every send
 * attempt it gets was used (fulfill-fresh.ts, the first check of `run`). With
 * `releasedAfterAttemptNo`, only the attempts after the OWNER's latest release count.
 */
export function attemptLimitReached(attempts: readonly AttemptErrorRow[]): boolean;
export function attemptLimitReached(
  attempts: readonly NumberedAttemptRow[],
  releasedAfterAttemptNo?: number | null,
): boolean;
export function attemptLimitReached(
  attempts: readonly MaybeNumberedAttemptRow[],
  releasedAfterAttemptNo?: number | null,
): boolean {
  return countSendAttempts(attempts, releasedAfterAttemptNo) >= MAX_SEND_ATTEMPTS;
}

function countSendAttempts(
  attempts: readonly MaybeNumberedAttemptRow[],
  releasedAfterAttemptNo: number | null | undefined,
): number {
  return attempts.filter(
    (attempt) =>
      !isAttemptHoldError(attempt.error) && countsAfterRelease(attempt, releasedAfterAttemptNo),
  ).length;
}

/** The note of a HELD event the core writes before any attempt existed (held-policy.ts). */
export const CORE_HOLD_NOTE_PREFIX = 'core hold: ';

/** The core hold's note, exactly as the worker writes it: `core hold: <REASON> (<why>)`. */
export function coreHoldNote(reason: string, why: string): string {
  return `${CORE_HOLD_NOTE_PREFIX}${reason} (${why})`;
}

/** The `why` of the attempt-cap hold (fulfill-fresh.ts). Informational only: never matched on. */
export const ATTEMPT_LIMIT_HOLD_WHY = 'every attempt was proven not sent';
