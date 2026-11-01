import { describe, expect, it } from 'vitest';
import {
  convertPair,
  convertPairForCost,
  convertPairForCredit,
  FX_PAIRS,
  MoneyError,
  type Currency,
  type FxPair,
} from './money';

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
