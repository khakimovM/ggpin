// The 24-hour top-up caps (D-37 (7)), as one pure function so that the request that creates an
// intent (422) and the worker that credits money (review `DAILY_LIMIT`) apply the SAME formula.
//
// What is counted: BASE amounts (`baseAmountTiyin`), never the random 1-999 so'm extra.
// Counting the paid amount would make a request for exactly the cap fail, because the extra
// pushes it over. What counts as "used" in the last 24 hours:
//   - PAID intents, by `paidAt`;
//   - PENDING intents, by `createdAt`.
// EXPIRED and CANCELLED intents never received money and do not count (a cancelled request
// frees its share). When crediting, `used` excludes the intent being credited and the request
// is that intent's own base amount: both caps are re-checked at that moment.
import { TiyinStringSchema } from '../money-schemas';
import {
  TOPUP_DEFAULTS,
  TOPUP_LIMIT_REASONS,
  type TopupAmountOutOfRangeDetails,
} from './topup-schemas';

export type TopupLimitReason = (typeof TOPUP_LIMIT_REASONS)[number];

/** Start of the rolling 24 hour window ending at `now`. */
export function dailyWindowStart(now: Date): Date {
  return new Date(now.getTime() - TOPUP_DEFAULTS.DAILY_CREATE_WINDOW_SEC * 1000);
}

export interface DailyLimitInput {
  /** Sum of base amounts counted in the window (see the header). */
  readonly usedBaseTiyin: bigint;
  /** Base amount being created or credited. */
  readonly requestedBaseTiyin: bigint;
  /** Account younger than `TOPUP_NEW_ACCOUNT_AGE_SEC`. */
  readonly isNewAccount: boolean;
  readonly dailyMaxTiyin: bigint;
  readonly newAccountDailyMaxTiyin: bigint;
}

export interface DailyLimitVerdict {
  readonly ok: boolean;
  /** The cap that leaves the least room (the new-account cap on a tie). */
  readonly reason: TopupLimitReason;
  /** What may still be requested under that cap; never negative. */
  readonly remainingTiyin: bigint;
}

export function checkDailyTopupLimit(input: DailyLimitInput): DailyLimitVerdict {
  const room = (cap: bigint): bigint =>
    cap > input.usedBaseTiyin ? cap - input.usedBaseTiyin : 0n;
  let reason: TopupLimitReason = 'DAILY_LIMIT';
  let remainingTiyin = room(input.dailyMaxTiyin);
  if (input.isNewAccount) {
    const newRoom = room(input.newAccountDailyMaxTiyin);
    if (newRoom <= remainingTiyin) {
      reason = 'NEW_ACCOUNT_DAILY_LIMIT';
      remainingTiyin = newRoom;
    }
  }
  return { ok: input.requestedBaseTiyin <= remainingTiyin, reason, remainingTiyin };
}

/**
 * `details` of the 422 for a daily cap. `max` is what is LEFT today, so it can be below `min`
 * (even `0`): the client reads `max < min` as "today's limit is used up". The code stays
 * `TOPUP_AMOUNT_OUT_OF_RANGE` in that case too.
 */
export function dailyLimitDetails(
  verdict: DailyLimitVerdict,
  range: { readonly minTiyin: bigint; readonly stepTiyin: bigint },
): TopupAmountOutOfRangeDetails {
  return {
    min: TiyinStringSchema.parse(range.minTiyin.toString()),
    max: TiyinStringSchema.parse(verdict.remainingTiyin.toString()),
    step: TiyinStringSchema.parse(range.stepTiyin.toString()),
    reason: verdict.reason,
  };
}
