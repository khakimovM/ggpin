import { describe, expect, it } from 'vitest';
import {
  checkDailyTopupLimit,
  dailyLimitDetails,
  dailyWindowStart,
  type DailyLimitInput,
} from './topup-limits';
import { TOPUP_DEFAULTS, TopupAmountOutOfRangeDetailsSchema } from './topup-schemas';

const SOM = 100n; // tiyin per so'm
const input = (overrides: Partial<DailyLimitInput>): DailyLimitInput => ({
  usedBaseTiyin: 0n,
  requestedBaseTiyin: 0n,
  isNewAccount: false,
  dailyMaxTiyin: TOPUP_DEFAULTS.DAILY_MAX_TIYIN,
  newAccountDailyMaxTiyin: TOPUP_DEFAULTS.NEW_ACCOUNT_DAILY_MAX_TIYIN,
  ...overrides,
});

describe('checkDailyTopupLimit: the new-account cap of 500 000 so‘m, in BASE amounts', () => {
  it('exactly 500 000 so‘m is allowed', () => {
    const verdict = checkDailyTopupLimit(
      input({ isNewAccount: true, requestedBaseTiyin: 500_000n * SOM }),
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.remainingTiyin).toBe(500_000n * SOM);
  });

  it('501 000 so‘m is refused with the new-account reason', () => {
    const verdict = checkDailyTopupLimit(
      input({ isNewAccount: true, requestedBaseTiyin: 501_000n * SOM }),
    );
    expect(verdict).toEqual({
      ok: false,
      reason: 'NEW_ACCOUNT_DAILY_LIMIT',
      remainingTiyin: 500_000n * SOM,
    });
  });

  it('what is already used shrinks the room: 300 000 used, 200 000 fits, 201 000 does not', () => {
    const used = 300_000n * SOM;
    const ask = (so: bigint) =>
      checkDailyTopupLimit(
        input({ isNewAccount: true, usedBaseTiyin: used, requestedBaseTiyin: so * SOM }),
      ).ok;
    expect(ask(200_000n)).toBe(true);
    expect(ask(201_000n)).toBe(false);
  });
});

describe('checkDailyTopupLimit: the 5 000 000 so‘m cap of every account', () => {
  it('an established account may use up to the cap, not beyond', () => {
    expect(checkDailyTopupLimit(input({ requestedBaseTiyin: 2_000_000n * SOM })).ok).toBe(true);
    const nearCap = input({
      usedBaseTiyin: 4_000_000n * SOM,
      requestedBaseTiyin: 1_000_000n * SOM,
    });
    expect(checkDailyTopupLimit(nearCap).ok).toBe(true);
    const over = checkDailyTopupLimit({ ...nearCap, requestedBaseTiyin: 1_001_000n * SOM });
    expect(over).toEqual({ ok: false, reason: 'DAILY_LIMIT', remainingTiyin: 1_000_000n * SOM });
  });

  it('the new-account cap does not apply to an established account', () => {
    expect(checkDailyTopupLimit(input({ requestedBaseTiyin: 600_000n * SOM })).ok).toBe(true);
  });

  it('a new account can hit the general cap first when its own cap is configured higher', () => {
    const verdict = checkDailyTopupLimit(
      input({
        isNewAccount: true,
        newAccountDailyMaxTiyin: 9_000_000n * SOM,
        usedBaseTiyin: 4_500_000n * SOM,
        requestedBaseTiyin: 1_000_000n * SOM,
      }),
    );
    expect(verdict.reason).toBe('DAILY_LIMIT');
    expect(verdict.remainingTiyin).toBe(500_000n * SOM);
  });

  it('on a tie the new-account reason is reported', () => {
    const verdict = checkDailyTopupLimit(
      input({ isNewAccount: true, newAccountDailyMaxTiyin: TOPUP_DEFAULTS.DAILY_MAX_TIYIN }),
    );
    expect(verdict.reason).toBe('NEW_ACCOUNT_DAILY_LIMIT');
  });

  it('used above the cap leaves no room (never negative)', () => {
    const verdict = checkDailyTopupLimit(
      input({ usedBaseTiyin: 6_000_000n * SOM, requestedBaseTiyin: 1n }),
    );
    expect(verdict).toEqual({ ok: false, reason: 'DAILY_LIMIT', remainingTiyin: 0n });
  });
});

describe('dailyLimitDetails', () => {
  const range = { minTiyin: TOPUP_DEFAULTS.MIN_TIYIN, stepTiyin: TOPUP_DEFAULTS.STEP_TIYIN };

  it('max is what is left today, as strings that fit the 422 details schema', () => {
    const verdict = checkDailyTopupLimit(
      input({
        isNewAccount: true,
        usedBaseTiyin: 100_000n * SOM,
        requestedBaseTiyin: 450_000n * SOM,
      }),
    );
    const details = dailyLimitDetails(verdict, range);
    expect(details).toEqual({
      min: '500000',
      max: '40000000',
      step: '100000',
      reason: 'NEW_ACCOUNT_DAILY_LIMIT',
    });
    expect(TopupAmountOutOfRangeDetailsSchema.safeParse(details).success).toBe(true);
  });

  it('when less than the minimum is left, max is below min: "today the limit is used up"', () => {
    const verdict = checkDailyTopupLimit(
      input({ usedBaseTiyin: 4_998_000n * SOM, requestedBaseTiyin: 5_000n * SOM }),
    );
    const details = dailyLimitDetails(verdict, range);
    expect(verdict.ok).toBe(false);
    expect(BigInt(details.max)).toBeLessThan(BigInt(details.min));
    expect(details.reason).toBe('DAILY_LIMIT');
  });

  it('a fully used day reports max 0', () => {
    const verdict = checkDailyTopupLimit(
      input({ usedBaseTiyin: 5_000_000n * SOM, requestedBaseTiyin: 5_000n * SOM }),
    );
    expect(dailyLimitDetails(verdict, range).max).toBe('0');
  });
});

describe('dailyWindowStart', () => {
  it('is exactly 24 hours before now', () => {
    expect(dailyWindowStart(new Date('2026-11-05T10:00:00.000Z')).toISOString()).toBe(
      '2026-11-04T10:00:00.000Z',
    );
  });
});
