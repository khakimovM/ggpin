import { describe, expect, it } from 'vitest';
import { MoneyError, parseMajor } from './money';
import { checkTonLimits, coversPayout, isLowBalance } from './money-pricing';

// Hot-wallet limits (rules/45, docs/06): moved from the worker's TON module (phase 5 S4), the
// worker's sender and signing transaction import them from here.
const limits = { perOrderMaxNano: parseMajor('TON', '50'), dailyMaxNano: parseMajor('TON', '500') };

describe('hot-wallet limits: exactly at the limit passes, one nanoton more is HELD', () => {
  it('per order', () => {
    expect(checkTonLimits(limits.perOrderMaxNano, 0n, limits)).toEqual({ ok: true });
    expect(checkTonLimits(limits.perOrderMaxNano + 1n, 0n, limits)).toEqual({
      ok: false,
      reason: 'LIMIT_PER_ORDER',
    });
  });

  it('rolling 24 h: the spent sum plus this payout', () => {
    const spent = limits.dailyMaxNano - parseMajor('TON', '10');
    expect(checkTonLimits(parseMajor('TON', '10'), spent, limits)).toEqual({ ok: true });
    expect(checkTonLimits(parseMajor('TON', '10') + 1n, spent, limits)).toEqual({
      ok: false,
      reason: 'LIMIT_DAILY',
    });
    expect(checkTonLimits(1n, limits.dailyMaxNano, limits)).toEqual({
      ok: false,
      reason: 'LIMIT_DAILY',
    });
  });

  it('the per-order limit is checked first; impossible inputs throw', () => {
    expect(checkTonLimits(limits.perOrderMaxNano + 1n, limits.dailyMaxNano, limits)).toEqual({
      ok: false,
      reason: 'LIMIT_PER_ORDER',
    });
    expect(() => checkTonLimits(0n, 0n, limits)).toThrow(MoneyError);
    expect(() => checkTonLimits(-1n, 0n, limits)).toThrow(MoneyError);
    expect(() => checkTonLimits(1n, -1n, limits)).toThrow(MoneyError);
  });

  it('the balance must cover the amount AND the fee reserve; the alert is strictly below', () => {
    const reserve = 50_000_000n;
    expect(coversPayout(1_050_000_000n, 1_000_000_000n, reserve)).toBe(true);
    expect(coversPayout(1_049_999_999n, 1_000_000_000n, reserve)).toBe(false);
    expect(isLowBalance(parseMajor('TON', '100'), parseMajor('TON', '100'))).toBe(false);
    expect(isLowBalance(parseMajor('TON', '100') - 1n, parseMajor('TON', '100'))).toBe(true);
  });
});
