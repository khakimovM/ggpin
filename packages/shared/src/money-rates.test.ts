import { describe, expect, it } from 'vitest';
import { MoneyError, mulDiv, multiplyRates } from './money';

const notABigInt = (value: number): bigint => value as unknown as bigint;
const notAString = (value: number): string => value as unknown as string;
const FX_RATE_CHECK = /^[0-9]+(\.[0-9]{1,18})?$/; // FxRate_rate_check

describe('mulDiv', () => {
  it.each([
    // [amount, num, den, up, down]
    [10n, 1n, 3n, 4n, 3n],
    [1n, 1n, 3n, 1n, 0n],
    [9n, 1n, 3n, 3n, 3n], // no remainder: both directions agree
    [50n, 7n, 3n, 117n, 116n], // 350 / 3 = 116.67
    [0n, 5n, 3n, 0n, 0n],
    [10n, 0n, 3n, 0n, 0n],
    [-10n, 1n, 3n, -3n, -4n], // ceiling / floor, not truncation
  ])('mulDiv(%s, %s, %s) rounds up to %s and down to %s', (amount, num, den, up, down) => {
    expect(mulDiv(amount, num, den, 'up')).toBe(up);
    expect(mulDiv(amount, num, den, 'down')).toBe(down);
  });

  it('multiplies before dividing, so one unit price is not rounded early', () => {
    // 2/3 per unit then x3 would give 0 or 3; the exact answer is 2.
    expect(mulDiv(2n, 3n, 3n, 'down')).toBe(2n);
    expect(mulDiv(1_100_000n, 1n, 50n, 'up')).toBe(22_000n);
  });

  it('is exact beyond 2^53', () => {
    const big = 2n ** 53n + 1n;
    expect(mulDiv(big, 3n, 3n, 'up')).toBe(big);
  });

  it('rejects a non-positive denominator and non-bigint arguments', () => {
    expect(() => mulDiv(1n, 1n, 0n, 'up')).toThrow(MoneyError);
    expect(() => mulDiv(1n, 1n, -2n, 'down')).toThrow(MoneyError);
    expect(() => mulDiv(notABigInt(1), 1n, 1n, 'up')).toThrow(MoneyError);
    expect(() => mulDiv(1n, notABigInt(1), 1n, 'up')).toThrow(MoneyError);
    expect(() => mulDiv(1n, 1n, notABigInt(1), 'up')).toThrow(MoneyError);
  });
});

describe('multiplyRates', () => {
  it('composes exactly when the product fits in 18 places', () => {
    expect(multiplyRates('5.5', '12600.5', 'up')).toBe('69302.75');
    expect(multiplyRates('5.5', '12600.5', 'down')).toBe('69302.75');
    expect(multiplyRates('2', '3', 'up')).toBe('6');
    expect(multiplyRates('7.50', '2', 'down')).toBe('15'); // trailing zeros trimmed
    expect(multiplyRates('0007.5', '2', 'down')).toBe('15'); // leading zeros normalised
  });

  it('rounds UP at the 18-decimal cut for cost use, DOWN on request', () => {
    // 1.000000000000000001^2 = 1.000000000000000002000000000000000001
    expect(multiplyRates('1.000000000000000001', '1.000000000000000001', 'up')).toBe(
      '1.000000000000000003',
    );
    expect(multiplyRates('1.000000000000000001', '1.000000000000000001', 'down')).toBe(
      '1.000000000000000002',
    );
  });

  it('keeps a tiny product alive when rounding up and refuses a zero rate when down', () => {
    // 1e-18 * 0.5 = 5e-19
    expect(multiplyRates('0.000000000000000001', '0.5', 'up')).toBe('0.000000000000000001');
    expect(() => multiplyRates('0.000000000000000001', '0.5', 'down')).toThrow(MoneyError);
  });

  it('always yields a string the DB CHECK accepts', () => {
    const rates = [
      '0.000000000000000001',
      '1',
      '5.123456789',
      '12600.5',
      '99999.999999999999999999',
    ];
    for (const a of rates) {
      for (const b of rates) {
        for (const rounding of ['up', 'down'] as const) {
          let product: string | undefined;
          try {
            product = multiplyRates(a, b, rounding);
          } catch (error) {
            // only a product below 1e-18 rounding down may be refused
            expect(error).toBeInstanceOf(MoneyError);
            expect(rounding).toBe('down');
            continue;
          }
          expect(product).toMatch(FX_RATE_CHECK);
        }
      }
    }
  });

  it('rejects malformed rates, zero, and more than 18 decimals', () => {
    expect(() => multiplyRates('0', '5', 'up')).toThrow(MoneyError);
    expect(() => multiplyRates('5', '-1', 'up')).toThrow(MoneyError);
    expect(() => multiplyRates('1e3', '5', 'up')).toThrow(MoneyError);
    expect(() => multiplyRates('0.0000000000000000001', '5', 'up')).toThrow(MoneyError);
    expect(() => multiplyRates(notAString(5), '5', 'up')).toThrow(MoneyError);
  });
});
