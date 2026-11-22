// How much one admin may do WITHOUT a bot code per Asia/Tashkent day (owner decision 2026-11-18,
// SA-S6-3): codeless wallet debits (a negative adjustment at or below the threshold) and codeless
// top-up reversals share one budget. Past it every further such action needs the code, whatever
// its size. Constants, not env: the owner set the numbers.

/** At most this many codeless debits + reversals per admin per Tashkent day (the 11th asks). */
export const ADMIN_CODELESS_DAILY_MAX_COUNT = 10;
/** Their absolute amounts together, this action included, at most 2 000 000 so'm. */
export const ADMIN_CODELESS_DAILY_MAX_TIYIN = 200_000_000n;

/** The binding flag that names the budget as the reason for the code (the panel shows it). */
export const ADMIN_CODELESS_BUDGET_FLAG = 'otpRequired: daily-limit';

/** The admin's codeless actions of the day so far (before this one), read under its lock. */
export interface CodelessUsage {
  readonly count: number;
  /** Sum of absolute amounts, tiyin. */
  readonly sumTiyin: bigint;
}

const magnitude = (tiyin: bigint): bigint => (tiyin < 0n ? -tiyin : tiyin);

/** True when THIS action would pass the budget: the 11th action, or the sum above the cap. */
export function codelessBudgetExceeded(used: CodelessUsage, amountTiyin: bigint): boolean {
  return (
    used.count + 1 > ADMIN_CODELESS_DAILY_MAX_COUNT ||
    used.sumTiyin + magnitude(amountTiyin) > ADMIN_CODELESS_DAILY_MAX_TIYIN
  );
}
