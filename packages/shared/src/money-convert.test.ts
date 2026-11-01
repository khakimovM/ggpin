import { describe, expect, it } from 'vitest';
import { convert, convertInverse, MoneyError } from './money';

const notAString = (value: number): string => value as unknown as string;
const notABigInt = (value: number): bigint => value as unknown as bigint;

describe('convert', () => {
  const uzsToUsdt = (amount: bigint, rate: string, rounding: 'up' | 'down'): bigint =>
    convert({ amount, from: 'UZS', to: 'USDT', rate, rounding });

  it('treats the rate as major-per-major (1 USDT = 12 600 so‘m is the inverse pair)', () => {
    // 1 UZS = 0.000079365 USDT → 1 000 000 UZS = 79.365 USDT
    expect(
      convert({
        amount: 100_000_000n,
        from: 'UZS',
        to: 'USDT',
        rate: '0.0000793650',
        rounding: 'down',
      }),
    ).toBe(79_365_000n);
    // 1 USDT = 12600 UZS → 2.5 USDT = 31 500 so‘m = 3 150 000 tiyin
    expect(
      convert({ amount: 2_500_000n, from: 'USDT', to: 'UZS', rate: '12600', rounding: 'up' }),
    ).toBe(3_150_000n);
  });

  it('is exact when the product divides evenly: up === down', () => {
    // 1 TON = 5 USDT; 1 TON = 1e9 nano → 5e6 micro
    for (const rounding of ['up', 'down'] as const) {
      expect(
        convert({ amount: 1_000_000_000n, from: 'TON', to: 'USDT', rate: '5', rounding }),
      ).toBe(5_000_000n);
    }
  });

  it('rounds up for cost and down for credit at an inexact boundary', () => {
    // 1 tiyin = 0.01 UZS; rate 0.00008 USDT/UZS → 0.0000008 USDT = 0.8 micro
    expect(uzsToUsdt(1n, '0.00008', 'up')).toBe(1n);
    expect(uzsToUsdt(1n, '0.00008', 'down')).toBe(0n);
    // 3 tiyin → 2.4 micro
    expect(uzsToUsdt(3n, '0.00008', 'up')).toBe(3n);
    expect(uzsToUsdt(3n, '0.00008', 'down')).toBe(2n);
    // exactly half a micro (0.5): 1 tiyin at 0.00005 → 0.5 micro; no banker's rounding
    expect(uzsToUsdt(1n, '0.00005', 'up')).toBe(1n);
    expect(uzsToUsdt(1n, '0.00005', 'down')).toBe(0n);
  });

  it('uses ceiling/floor (not truncation) for negative amounts', () => {
    expect(uzsToUsdt(-1n, '0.00008', 'up')).toBe(0n);
    expect(uzsToUsdt(-1n, '0.00008', 'down')).toBe(-1n);
    // -50 000 so'm × 0.0001 = -5 USDT exactly: both directions agree
    expect(uzsToUsdt(-5_000_000n, '0.0001', 'down')).toBe(-5_000_000n);
    expect(uzsToUsdt(-5_000_000n, '0.0001', 'up')).toBe(-5_000_000n);
  });

  it('handles Stars (0 decimals) and zero', () => {
    expect(convert({ amount: 50n, from: 'STARS', to: 'USDT', rate: '0.015', rounding: 'up' })).toBe(
      750_000n,
    );
    expect(uzsToUsdt(0n, '0.00008', 'up')).toBe(0n);
  });

  it('stays exact above 2^53', () => {
    const huge = 10n ** 20n + 1n;
    expect(convert({ amount: huge, from: 'TON', to: 'TON', rate: '1', rounding: 'down' })).toBe(
      huge,
    );
    expect(convert({ amount: huge, from: 'TON', to: 'TON', rate: '1.000', rounding: 'up' })).toBe(
      huge,
    );
  });

  it('rejects bad rates', () => {
    for (const rate of ['0', '0.000', '-1', '', '1e-5', '.5', '1,5', 'x']) {
      expect(() => uzsToUsdt(1n, rate, 'up')).toThrow(MoneyError);
    }
    expect(() => uzsToUsdt(1n, '0.1234567890123456789', 'up')).toThrow(/at most 18/);
    expect(() => uzsToUsdt(1n, notAString(0.5), 'up')).toThrow(/decimal string/);
  });

  it('rejects a non-bigint amount', () => {
    expect(() => uzsToUsdt(notABigInt(1), '1', 'up')).toThrow(MoneyError);
  });
});

describe('convertInverse', () => {
  // rate is FROM-per-TO: 12 600 so'm per 1 USDT; amounts are minor units.
  const tiyinToMicro = (amount: bigint, rounding: 'up' | 'down', rate = '12600'): bigint =>
    convertInverse({ amount, from: 'UZS', to: 'USDT', rate, rounding });

  it('is exact when the division is even: up === down', () => {
    // 12 600 so'm = 1 260 000 tiyin = exactly 1 USDT
    expect(tiyinToMicro(1_260_000n, 'up')).toBe(1_000_000n);
    expect(tiyinToMicro(1_260_000n, 'down')).toBe(1_000_000n);
  });

  it('rounds up for cost and down for credit where the division is inexact', () => {
    // 1 tiyin = 0.01 so'm / 12600 = 0.79365 micro
    expect(tiyinToMicro(1n, 'up')).toBe(1n);
    expect(tiyinToMicro(1n, 'down')).toBe(0n);
    // 10 000 so'm = 793 650.79365 micro
    expect(tiyinToMicro(1_000_000n, 'up')).toBe(793_651n);
    expect(tiyinToMicro(1_000_000n, 'down')).toBe(793_650n);
  });

  it('uses ceiling/floor for negative amounts and handles zero', () => {
    expect(tiyinToMicro(-1n, 'up')).toBe(0n);
    expect(tiyinToMicro(-1n, 'down')).toBe(-1n);
    expect(tiyinToMicro(0n, 'up')).toBe(0n);
  });

  it('is the exact inverse of convert for a rate with decimals', () => {
    const forward = convert({
      amount: 1_000_000n,
      from: 'USDT',
      to: 'UZS',
      rate: '12600.5',
      rounding: 'up',
    });
    expect(forward).toBe(1_260_050n); // 1 USDT -> 12 600.50 so'm = 1 260 050 tiyin
    expect(tiyinToMicro(forward, 'down', '12600.5')).toBe(1_000_000n);
  });

  it('stays exact above 2^53', () => {
    const huge = 10n ** 20n;
    expect(
      convertInverse({ amount: huge, from: 'TON', to: 'TON', rate: '1', rounding: 'up' }),
    ).toBe(huge);
  });

  it('rejects bad rates and non-bigint amounts', () => {
    for (const rate of ['0', '-1', '', '1e3', 'x']) {
      expect(() => tiyinToMicro(1n, 'up', rate)).toThrow(MoneyError);
    }
    expect(() => tiyinToMicro(notABigInt(1), 'up')).toThrow(/bigint/);
  });
});
