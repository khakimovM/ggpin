import { BANK_FEED_DEFAULTS, TOPUP_DEFAULTS, topupTuningProblems } from '@repo/shared';
import { z } from 'zod';

const DAY_SEC = 86_400;

const seconds = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const tiyin = (fallback: bigint) =>
  z
    .string()
    .regex(/^\d+$/, 'must be a non-negative integer written with digits only')
    .default(String(fallback))
    .transform((v) => BigInt(v));

/**
 * The top-up knobs the matcher needs (docs/05 §6). The time knobs and the daily caps MUST equal
 * the API's (apps/api/src/config/topup-env.ts, same names, same defaults from TOPUP_DEFAULTS):
 * the API allocates against card capacity and refuses requests over the caps with them, the
 * worker turns cards FULL and re-checks the caps when crediting with them. Same ranges here.
 */
export const workerTopupShape = {
  TOPUP_INTENT_TTL_SEC: seconds(TOPUP_DEFAULTS.INTENT_TTL_SEC, 60, DAY_SEC),
  TOPUP_LATE_GRACE_SEC: seconds(TOPUP_DEFAULTS.LATE_GRACE_SEC, 3_600, 7 * DAY_SEC),
  TOPUP_CAPACITY_HOLD_SEC: seconds(TOPUP_DEFAULTS.CAPACITY_HOLD_SEC, 1, 7 * DAY_SEC),
  TOPUP_NEW_ACCOUNT_AGE_SEC: seconds(TOPUP_DEFAULTS.NEW_ACCOUNT_AGE_SEC, 0, 90 * DAY_SEC),
  TOPUP_DAILY_MAX_TIYIN: tiyin(TOPUP_DEFAULTS.DAILY_MAX_TIYIN),
  TOPUP_NEW_ACCOUNT_DAILY_MAX_TIYIN: tiyin(TOPUP_DEFAULTS.NEW_ACCOUNT_DAILY_MAX_TIYIN),
  // Allowed gap between the time the bank prints and Telegram's message date (TIME_SKEW review).
  BANK_TIME_SKEW_SEC: seconds(BANK_FEED_DEFAULTS.BANK_TIME_SKEW_SEC, 60, 3_600),
} as const;

export interface WorkerTopupEnv {
  readonly NODE_ENV: string;
  readonly TOPUP_INTENT_TTL_SEC: number;
  readonly TOPUP_LATE_GRACE_SEC: number;
  readonly TOPUP_CAPACITY_HOLD_SEC: number;
  readonly TOPUP_DAILY_MAX_TIYIN: bigint;
  readonly TOPUP_NEW_ACCOUNT_DAILY_MAX_TIYIN: bigint;
}

/** Cross-field rules: the shared tuning rules (same as the API) plus the order of the two caps. */
export function workerTopupProblems(env: WorkerTopupEnv): string[] {
  const problems = topupTuningProblems(env).map(({ name, message }) => `${name}: ${message}`);
  if (env.TOPUP_DAILY_MAX_TIYIN <= 0n)
    problems.push('TOPUP_DAILY_MAX_TIYIN: must be greater than 0');
  if (env.TOPUP_NEW_ACCOUNT_DAILY_MAX_TIYIN <= 0n) {
    problems.push('TOPUP_NEW_ACCOUNT_DAILY_MAX_TIYIN: must be greater than 0');
  }
  if (env.TOPUP_NEW_ACCOUNT_DAILY_MAX_TIYIN > env.TOPUP_DAILY_MAX_TIYIN) {
    problems.push(
      'TOPUP_NEW_ACCOUNT_DAILY_MAX_TIYIN: must not exceed TOPUP_DAILY_MAX_TIYIN (a new account is limited more, not less)',
    );
  }
  return problems;
}
