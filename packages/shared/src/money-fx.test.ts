import { describe, expect, it } from 'vitest';
import { compareFxRates, fxRateMoveBps, fxRateMovesMoreThan, fxRateWithin } from './money-fx';
import { MANUAL_FX_RATE_BOUNDS, ManualFxPairSchema, ManualFxRateSchema } from './pricing/manual-fx';

describe('compareFxRates', () => {
  it('compares decimal strings exactly, whatever their spelling', () => {
    expect(compareFxRates('USDT_UZS', '12650', '12650.000')).toBe(0);
    expect(compareFxRates('USDT_UZS', '12650', '12650.0000000000000001')).toBe(-1);
    expect(compareFxRates('TON_USDT', '5.215', '5.2149999')).toBe(1);
    // As numbers, not as text: "9" < "10".
    expect(compareFxRates('TON_USDT', '9', '10')).toBe(-1);
  });
});

describe('fxRateWithin', () => {
  it('both bounds are inclusive; a slipped digit is outside', () => {
    const b = MANUAL_FX_RATE_BOUNDS.USDT_UZS;
    expect(fxRateWithin('USDT_UZS', b.min, b)).toBe(true);
    expect(fxRateWithin('USDT_UZS', b.max, b)).toBe(true);
    expect(fxRateWithin('USDT_UZS', '126500', b)).toBe(false);
    expect(fxRateWithin('USDT_UZS', '1265', b)).toBe(false);
    expect(fxRateWithin('TON_USDT', '0.4999', MANUAL_FX_RATE_BOUNDS.TON_USDT)).toBe(false);
  });
});

describe('fxRateMovesMoreThan / fxRateMoveBps', () => {
  it('exactly 10% is not a jump, a hair above is, in both directions', () => {
    expect(fxRateMovesMoreThan('USDT_UZS', '10000', '11000', 1000)).toBe(false);
    expect(fxRateMovesMoreThan('USDT_UZS', '10000', '11000.01', 1000)).toBe(true);
    expect(fxRateMovesMoreThan('USDT_UZS', '10000', '9000', 1000)).toBe(false);
    expect(fxRateMovesMoreThan('USDT_UZS', '10000', '8999.99', 1000)).toBe(true);
  });

  it('measures against the previous rate and rounds the bps up', () => {
    expect(fxRateMoveBps('USDT_UZS', '10000', '11000')).toBe(1000n);
    expect(fxRateMoveBps('USDT_UZS', '10000', '10000.01')).toBe(1n);
    expect(fxRateMoveBps('TON_USDT', '3', '3')).toBe(0n);
  });
});

describe('manual FX input', () => {
  it('accepts positive decimals only, the pairs the owner types only', () => {
    for (const ok of ['12650', '5.215', '0.5'])
      expect(ManualFxRateSchema.safeParse(ok).success).toBe(true);
    for (const bad of ['0', '0.000', '-1', '1e4', '012', '1,5', ' 1', '1.'])
      expect(ManualFxRateSchema.safeParse(bad).success).toBe(false);
    expect(ManualFxPairSchema.safeParse('TON_UZS').success).toBe(false);
  });

  it('every bound is a valid rate and min < max', () => {
    for (const [pair, b] of Object.entries(MANUAL_FX_RATE_BOUNDS)) {
      expect(ManualFxRateSchema.safeParse(b.min).success).toBe(true);
      expect(compareFxRates(pair as keyof typeof MANUAL_FX_RATE_BOUNDS, b.min, b.max)).toBe(-1);
    }
  });
});
