import { BANK_FEED_DEFAULTS, TOPUP_BASE_UNIT_TIYIN, TOPUP_DEFAULTS } from '@repo/shared';
import { z } from 'zod';

const seconds = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const DAY_SEC = 86_400;

/**
 * Top-up tunables that are not money (docs/04 §4.5 of the phase-4 plan). Part of EnvSchema.
 * The grace must equal the worker's TOPUP_LATE_GRACE_SEC: the API writes `reservedUntil` with
 * it and the worker's matcher reads that column, so a mismatch only shifts where the window is
 * stored, never doubles it. A grace under an hour would hand an amount to a second user while a
 * slow bank transfer for the first one may still arrive.
 */
export const topupTuningShape = {
  // The unique extra is 1..N whole so'm. Below 999 only to make exhaustion testable.
  TOPUP_SUFFIX_MAX_SOM: z.coerce
    .number()
    .int()
    .min(1)
    .max(TOPUP_DEFAULTS.SUFFIX_MAX_SOM)
    .default(TOPUP_DEFAULTS.SUFFIX_MAX_SOM),
  TOPUP_INTENT_TTL_SEC: seconds(TOPUP_DEFAULTS.INTENT_TTL_SEC, 60, DAY_SEC),
  TOPUP_LATE_GRACE_SEC: seconds(TOPUP_DEFAULTS.LATE_GRACE_SEC, 3_600, 7 * DAY_SEC),
  TOPUP_NEW_ACCOUNT_AGE_SEC: seconds(TOPUP_DEFAULTS.NEW_ACCOUNT_AGE_SEC, 0, 90 * DAY_SEC),
  // How long an UNPAID expired or cancelled request still counts against its card's limit (D-42
  // (1)): `LEAST(reservedUntil, expiresAt + hold)`. The amount itself stays reserved for the whole
  // grace; only the capacity is released early, so create-and-cancel cannot block cards for a day.
  TOPUP_CAPACITY_HOLD_SEC: seconds(TOPUP_DEFAULTS.CAPACITY_HOLD_SEC, 1, 7 * DAY_SEC),
  // Not a secret (no secret-shaped suffix), so the BANK_FEED_ prefix rule lets the API read it.
  BANK_FEED_HEARTBEAT_MAX_AGE_SEC: seconds(BANK_FEED_DEFAULTS.HEARTBEAT_MAX_AGE_SEC, 10, 3_600),
} as const;

export interface TopupTuning {
  readonly NODE_ENV: string;
  readonly TOPUP_LATE_GRACE_SEC: number;
  readonly TOPUP_CAPACITY_HOLD_SEC: number;
  readonly TOPUP_INTENT_TTL_SEC: number;
}

/**
 * Cross-field rules of the tuning knobs. Production keeps the full 24 h grace of D-37 (2): the
 * 1 h minimum exists for dev and test only (a shorter grace hands an amount to the next user
 * while a slow transfer may still arrive). The capacity hold never outlives the reservation,
 * and in production it is at least the request's lifetime (R-5): a shorter hold would release a
 * card's room while most late transfers for it are still on their way.
 */
export function topupTuningProblems(env: TopupTuning): { name: string; message: string }[] {
  const problems: { name: string; message: string }[] = [];
  if (env.NODE_ENV === 'production' && env.TOPUP_LATE_GRACE_SEC < DAY_SEC) {
    problems.push({
      name: 'TOPUP_LATE_GRACE_SEC',
      message: 'must be at least 86400 in production (the 24 h grace of D-37)',
    });
  }
  // Not a safety bound (the hold already runs from expiresAt): a conservative floor, so a
  // request that just expired keeps its share of the card at least as long as it was open.
  if (env.NODE_ENV === 'production' && env.TOPUP_CAPACITY_HOLD_SEC < env.TOPUP_INTENT_TTL_SEC) {
    problems.push({
      name: 'TOPUP_CAPACITY_HOLD_SEC',
      message: 'must be at least TOPUP_INTENT_TTL_SEC in production',
    });
  }
  if (env.TOPUP_CAPACITY_HOLD_SEC > env.TOPUP_LATE_GRACE_SEC) {
    problems.push({
      name: 'TOPUP_CAPACITY_HOLD_SEC',
      message:
        'must not exceed TOPUP_LATE_GRACE_SEC (capacity is held at most as long as the amount)',
    });
  }
  return problems;
}

export interface TopupEnvLimits {
  readonly TOPUP_MIN_TIYIN: bigint;
  readonly TOPUP_MAX_TIYIN: bigint;
  readonly TOPUP_STEP_TIYIN: bigint;
  readonly TOPUP_DAILY_MAX_TIYIN: bigint;
  readonly TOPUP_NEW_ACCOUNT_DAILY_MAX_TIYIN: bigint;
}

export interface TopupEnvProblem {
  readonly name: keyof TopupEnvLimits;
  readonly message: string;
}

/**
 * Cross-field rules of the top-up limits, checked at boot. A limit that is 0, crosses another
 * one, or is not a multiple of the step would make every top-up fail, or let one through that
 * the owner meant to refuse; the database CHECK (`baseAmountTiyin % 100000 = 0`) would then
 * reject rows the API had already promised, so the step is tied to the same shared constant.
 */
export function topupEnvProblems(env: TopupEnvLimits): TopupEnvProblem[] {
  const problems: TopupEnvProblem[] = [];
  const problem = (name: keyof TopupEnvLimits, message: string): void => {
    problems.push({ name, message });
  };

  // The full Env object is passed in, so the five limits are listed by name (not enumerated).
  const all: (keyof TopupEnvLimits)[] = [
    'TOPUP_MIN_TIYIN',
    'TOPUP_MAX_TIYIN',
    'TOPUP_STEP_TIYIN',
    'TOPUP_DAILY_MAX_TIYIN',
    'TOPUP_NEW_ACCOUNT_DAILY_MAX_TIYIN',
  ];
  for (const name of all) {
    if (env[name] <= 0n) problem(name, 'must be greater than 0');
  }
  const step = env.TOPUP_STEP_TIYIN;
  if (step <= 0n) return problems; // every "multiple of the step" check below needs a step

  if (step % TOPUP_BASE_UNIT_TIYIN !== 0n) {
    problem(
      'TOPUP_STEP_TIYIN',
      `must be a multiple of ${TOPUP_BASE_UNIT_TIYIN} (the database CHECK)`,
    );
  }
  if (env.TOPUP_MIN_TIYIN > env.TOPUP_MAX_TIYIN) {
    problem('TOPUP_MIN_TIYIN', 'must not exceed TOPUP_MAX_TIYIN');
  }
  const multiples: (keyof TopupEnvLimits)[] = [
    'TOPUP_MIN_TIYIN',
    'TOPUP_MAX_TIYIN',
    'TOPUP_DAILY_MAX_TIYIN',
    'TOPUP_NEW_ACCOUNT_DAILY_MAX_TIYIN',
  ];
  for (const name of multiples) {
    if (env[name] % step !== 0n) problem(name, 'must be a multiple of TOPUP_STEP_TIYIN');
  }
  // A cap below the smallest request would refuse every top-up of that kind.
  for (const name of ['TOPUP_DAILY_MAX_TIYIN', 'TOPUP_NEW_ACCOUNT_DAILY_MAX_TIYIN'] as const) {
    if (env[name] < env.TOPUP_MIN_TIYIN) problem(name, 'must not be below TOPUP_MIN_TIYIN');
  }
  if (env.TOPUP_NEW_ACCOUNT_DAILY_MAX_TIYIN > env.TOPUP_DAILY_MAX_TIYIN) {
    problem(
      'TOPUP_NEW_ACCOUNT_DAILY_MAX_TIYIN',
      'must not exceed TOPUP_DAILY_MAX_TIYIN (a new account is limited more, not less)',
    );
  }
  return problems;
}
