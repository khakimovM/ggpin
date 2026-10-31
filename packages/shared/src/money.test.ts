import { describe, expect, it } from 'vitest';
import {
  applyMarkup,
  CURRENCY_DECIMALS,
  convert,
  convertInverse,
  convertPair,
  convertPairForCost,
  convertPairForCredit,
  formatMajor,
  formatMoney,
  FX_PAIRS,
  MoneyError,
  parseMajor,
  parseSignedMajor,
  percentOf,
  roundUpToSom,
  somToTiyin,
  tiyinToSom,
  type Currency,
  type FxPair,
} from './money';

const NNBSP = ' ';
const MINUS = '−';
const BEYOND_2_53 = 2n ** 53n + 1n; // not representable as a JS number
const notAString = (value: number): string => value as unknown as string;
const notABigInt = (value: number): bigint => value as unknown as bigint;

describe('parseMajor / formatMajor', () => {
  it.each([
    ['UZS', '12550', 1_255_000n],
    ['UZS', '12550.5', 1_255_050n],
    ['UZS', '0.01', 1n],
    ['USDT', '1.234567', 1_234_567n],
    ['TON', '0.000000001', 1n],
    ['TON', '2.5', 2_500_000_000n],
    ['STARS', '50', 50n],
    ['UZS', '007', 700n],
  ] as const)('parses %s %s', (currency, input, expected) => {
    expect(parseMajor(currency, input)).toBe(expected);
  });

  it('parseMajor / somToTiyin reject negatives and -0 (user- and admin-entered amounts)', () => {
    for (const input of ['-500', '-12.50', '-0', '-0.00', '-0.01']) {
      expect(() => parseMajor('UZS', input), input).toThrow(/must not be negative/);
      expect(() => somToTiyin(input), input).toThrow(MoneyError);
    }
    expect(parseMajor('UZS', '0')).toBe(0n); // zero is the caller's rule, not the parser's
  });

  it('parseSignedMajor is the explicit signed path (ADJUSTMENT) and normalises -0', () => {
    expect(parseSignedMajor('UZS', '-12.50')).toBe(-1250n);
    expect(parseSignedMajor('UZS', '12.50')).toBe(1250n);
    expect(parseSignedMajor('UZS', '-0')).toBe(0n);
    expect(() => parseSignedMajor('UZS', '--1')).toThrow(MoneyError);
    expect(() => parseSignedMajor('UZS', '-1.001')).toThrow(/at most 2/);
  });

  it.each(['', ' 1', '1 ', '1.', '.5', '1e3', '1,5', '--1', '+1', '1.2.3', 'abc', '0x10', '١٢'])(
    'rejects garbage %j',
    (input) => {
      expect(() => parseMajor('UZS', input)).toThrow(MoneyError);
    },
  );

  it('rejects more decimals than the unit allows instead of truncating', () => {
    expect(() => parseMajor('UZS', '1.001')).toThrow(/at most 2/);
    expect(() => parseMajor('STARS', '1.0')).toThrow(/at most 0/);
    expect(() => parseMajor('USDT', '1.0000001')).toThrow(MoneyError);
  });

  it('rejects numbers (floats) as input type', () => {
    expect(() => parseMajor('UZS', notAString(12.5))).toThrow(/decimal string/);
  });

  it('round-trips every currency, including values above 2^53', () => {
    const currencies = Object.keys(CURRENCY_DECIMALS) as Currency[];
    for (const currency of currencies) {
      for (const minor of [0n, 1n, 99n, 100n, 123_456_789n, BEYOND_2_53, -BEYOND_2_53, -1n]) {
        expect(parseSignedMajor(currency, formatMajor(currency, minor))).toBe(minor);
      }
    }
  });

  it('formats canonically with trimmed trailing zeros', () => {
    expect(formatMajor('UZS', 1_255_000n)).toBe('12550');
    expect(formatMajor('UZS', 1_255_050n)).toBe('12550.5');
    expect(formatMajor('UZS', 5n)).toBe('0.05');
    expect(formatMajor('UZS', -5n)).toBe('-0.05');
    expect(formatMajor('TON', 1n)).toBe('0.000000001');
    expect(formatMajor('STARS', 50n)).toBe('50');
    expect(formatMajor('UZS', 0n)).toBe('0');
    expect(formatMajor('UZS', BEYOND_2_53)).toBe('90071992547409.93');
  });

  it('formatMajor rejects a non-bigint', () => {
    expect(() => formatMajor('UZS', notABigInt(1))).toThrow(/bigint/);
  });

  it('exposes so‘m helpers over the UZS unit', () => {
    expect(somToTiyin('12550.5')).toBe(1_255_050n);
    expect(tiyinToSom(1_255_050n)).toBe('12550.5');
  });
});

describe('roundUpToSom', () => {
  it('rounds up to a whole so‘m and keeps exact values', () => {
    expect(roundUpToSom(100n)).toBe(100n);
    expect(roundUpToSom(101n)).toBe(200n);
    expect(roundUpToSom(1n)).toBe(100n);
    expect(roundUpToSom(0n)).toBe(0n);
    expect(roundUpToSom(-150n)).toBe(-100n);
    expect(roundUpToSom(BEYOND_2_53)).toBe(9_007_199_254_740_993n + 7n);
  });

  it('rejects a non-bigint', () => {
    expect(() => roundUpToSom(notABigInt(100))).toThrow(MoneyError);
  });
});

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

describe('convertPair (cost rounds up, credit rounds down, both directions)', () => {
  interface Case {
    readonly pair: FxPair;
    readonly rate: string;
    readonly from: Currency;
    /** an amount whose conversion is inexact: [ceil, floor] */
    readonly ceil: bigint;
    readonly floor: bigint;
    readonly even: { readonly amount: bigint; readonly result: bigint };
  }

  // Every conversion below is for 1 minor unit of `from` (inexact) and one evenly divisible amount.
  const CASES: readonly Case[] = [
    // base -> quote (multiply)
    {
      pair: 'USDT_UZS',
      rate: '12600.5',
      from: 'USDT',
      ceil: 2n,
      floor: 1n,
      even: { amount: 1_000_000n, result: 1_260_050n },
    }, // 1.26005 tiyin
    {
      pair: 'TON_USDT',
      rate: '5.5',
      from: 'TON',
      ceil: 1n,
      floor: 0n,
      even: { amount: 1_000_000_000n, result: 5_500_000n },
    }, // 0.0055 micro
    {
      pair: 'TON_UZS',
      rate: '30000.5',
      from: 'TON',
      ceil: 1n,
      floor: 0n,
      even: { amount: 1_000_000_000n, result: 3_000_050n },
    }, // 0.00300005 tiyin
    // quote -> base (divide)
    {
      pair: 'USDT_UZS',
      rate: '12600',
      from: 'UZS',
      ceil: 1n,
      floor: 0n,
      even: { amount: 1_260_000n, result: 1_000_000n },
    }, // 0.79365 micro
    {
      pair: 'TON_USDT',
      rate: '5.5',
      from: 'USDT',
      ceil: 182n,
      floor: 181n,
      even: { amount: 5_500_000n, result: 1_000_000_000n },
    }, // 181.81 nano
    {
      pair: 'TON_UZS',
      rate: '30000.5',
      from: 'UZS',
      ceil: 334n,
      floor: 333n,
      even: { amount: 3_000_050n, result: 1_000_000_000n },
    }, // 333.33 nano
  ];

  it.each(CASES)('$pair from $from', ({ pair, rate, from, ceil, floor, even }) => {
    // where rounding really happens: cost = ceil, credit = floor, and they differ by exactly 1
    expect(convertPairForCost({ amount: 1n, pair, from, rate })).toBe(ceil);
    expect(convertPairForCredit({ amount: 1n, pair, from, rate })).toBe(floor);
    expect(ceil - floor).toBe(1n);
    // where it does not: both directions agree
    expect(convertPairForCost({ amount: even.amount, pair, from, rate })).toBe(even.result);
    expect(convertPairForCredit({ amount: even.amount, pair, from, rate })).toBe(even.result);
  });

  it('exposes the three stored pairs, quote per base', () => {
    expect(FX_PAIRS).toEqual({
      USDT_UZS: { base: 'USDT', quote: 'UZS' },
      TON_USDT: { base: 'TON', quote: 'USDT' },
      TON_UZS: { base: 'TON', quote: 'UZS' },
    });
  });

  it('convertPair takes the rounding explicitly', () => {
    const input = { amount: 1n, pair: 'TON_UZS', from: 'UZS', rate: '30000.5' } as const;
    expect(convertPair({ ...input, rounding: 'up' })).toBe(334n);
    expect(convertPair({ ...input, rounding: 'down' })).toBe(333n);
  });

  it('rejects a currency that is not a side of the pair', () => {
    expect(() =>
      convertPairForCost({ amount: 1n, pair: 'USDT_UZS', from: 'TON', rate: '1' }),
    ).toThrow(/not a side of USDT_UZS/);
    expect(() =>
      convertPairForCredit({ amount: 1n, pair: 'TON_USDT', from: 'STARS', rate: '1' }),
    ).toThrow(MoneyError);
  });
});

describe('applyMarkup / percentOf', () => {
  it('applies markup in basis points with explicit rounding', () => {
    expect(applyMarkup(10_000n, 500, 'up')).toBe(10_500n);
    expect(applyMarkup(10_000n, 0, 'up')).toBe(10_000n);
    expect(applyMarkup(333n, 100, 'up')).toBe(337n); // 336.33
    expect(applyMarkup(333n, 100, 'down')).toBe(336n);
    expect(applyMarkup(0n, 100, 'up')).toBe(0n);
  });

  it('computes percentages of an amount (referral 1% = 100 bps)', () => {
    expect(percentOf(1_000_000n, 100, 'down')).toBe(10_000n);
    expect(percentOf(150n, 100, 'down')).toBe(1n); // 1.5
    expect(percentOf(150n, 100, 'up')).toBe(2n);
    expect(percentOf(-150n, 100, 'down')).toBe(-2n);
    expect(percentOf(-150n, 100, 'up')).toBe(-1n);
    expect(percentOf(100n, 10_000, 'down')).toBe(100n);
  });

  it('stays exact above 2^53', () => {
    expect(percentOf(BEYOND_2_53 * 10_000n, 100, 'down')).toBe(BEYOND_2_53 * 100n);
  });

  it('rejects invalid bps and non-bigint amounts', () => {
    for (const bps of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) {
      expect(() => applyMarkup(100n, bps, 'up')).toThrow(/bps/);
      expect(() => percentOf(100n, bps, 'up')).toThrow(/bps/);
    }
    expect(() => applyMarkup(notABigInt(100), 100, 'up')).toThrow(MoneyError);
    expect(() => percentOf(notABigInt(100), 100, 'up')).toThrow(MoneyError);
  });
});

describe('formatMoney', () => {
  it.each(['uz', 'ru'] as const)('formats the design rules for %s', (locale) => {
    expect(formatMoney(8_540_000n, locale)).toBe(`85${NNBSP}400`);
    expect(formatMoney(0n, locale)).toBe('0');
    expect(formatMoney(99n, locale)).toBe('0,99');
    expect(formatMoney(5n, locale)).toBe('0,05');
    expect(formatMoney(100n, locale)).toBe('1');
    expect(formatMoney(100_000n, locale)).toBe(`1${NNBSP}000`);
    expect(formatMoney(8_540_050n, locale)).toBe(`85${NNBSP}400,50`);
    expect(formatMoney(123_456_789_000n, locale)).toBe(`1${NNBSP}234${NNBSP}567${NNBSP}890`);
    expect(formatMoney(-120_000n, locale)).toBe(`${MINUS}1${NNBSP}200`);
    expect(formatMoney(-1n, locale)).toBe(`${MINUS}0,01`);
  });

  it('is deterministic above 2^53', () => {
    expect(formatMoney(BEYOND_2_53, 'uz')).toBe(
      `90${NNBSP}071${NNBSP}992${NNBSP}547${NNBSP}409,93`,
    );
  });

  it('never uses a plain space, hyphen-minus or Intl output', () => {
    const out = formatMoney(-123_456_700n, 'ru');
    expect(out).not.toContain(' ');
    expect(out).not.toContain('-');
    expect(out.startsWith(MINUS)).toBe(true);
  });

  it('rejects a non-bigint', () => {
    expect(() => formatMoney(notABigInt(100), 'uz')).toThrow(MoneyError);
  });
});
