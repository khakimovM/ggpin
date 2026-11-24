import { describe, expect, it } from 'vitest';
import { MoneyError } from '../money';
import { cashbackCoins, discountForQuote, referralBonusTiyin } from './reward-math';

const notABigInt = (value: number): bigint => value as unknown as bigint;
const COIN_UNIT = 10_000n; // D-72: 1 coin = 100 so'm

describe('referralBonusTiyin (D-72 (3): 1% of what was paid, DOWN to a whole so‘m)', () => {
  it('1% of 10 000 so‘m is 100 so‘m', () => {
    expect(referralBonusTiyin(1_000_000n, 100)).toBe(10_000n);
  });

  it('rounds DOWN to a whole so‘m: 1% of 19 999 so‘m is 199 so‘m, not 200', () => {
    expect(referralBonusTiyin(1_999_900n, 100)).toBe(19_900n);
    expect(referralBonusTiyin(1_999_999n, 100)).toBe(19_900n);
  });

  it('never pays tiyin: every result is a whole so‘m', () => {
    for (const paid of [1n, 99n, 12_345n, 9_876_543n, 123_456_789n]) {
      expect(referralBonusTiyin(paid, 137) % 100n).toBe(0n);
    }
  });

  it('edges: nothing paid, 0 bps, 1 tiyin and less than one so‘m of bonus give 0', () => {
    expect(referralBonusTiyin(0n, 100)).toBe(0n);
    expect(referralBonusTiyin(5_000_000n, 0)).toBe(0n);
    expect(referralBonusTiyin(1n, 100)).toBe(0n);
    expect(referralBonusTiyin(9_999n, 100)).toBe(0n);
    expect(referralBonusTiyin(10_000n, 100)).toBe(100n);
  });

  it('a very large payment is exact (no float anywhere)', () => {
    const paid = 2n ** 62n + 12_345n;
    expect(referralBonusTiyin(paid, 100)).toBe((paid / 10_000n) * 100n);
  });

  it('refuses a negative payment, a number, and bps outside 0..10000', () => {
    expect(() => referralBonusTiyin(-1n, 100)).toThrow(MoneyError);
    expect(() => referralBonusTiyin(notABigInt(100), 100)).toThrow(MoneyError);
    for (const bps of [-1, 10_001, 1.5, Number.NaN]) {
      expect(() => referralBonusTiyin(100n, bps)).toThrow(MoneyError);
    }
    expect(referralBonusTiyin(100n, 10_000)).toBe(100n);
  });
});

describe('cashbackCoins (D-72 (4): 0.5%, 1 coin = 100 so‘m, DOWN to a whole coin)', () => {
  it('a 20 000 so‘m purchase earns 1 coin', () => {
    expect(cashbackCoins(2_000_000n, 50, COIN_UNIT)).toBe(1n);
  });

  it('rounds DOWN: 19 999 so‘m earns nothing, 39 999 so‘m earns 1', () => {
    expect(cashbackCoins(1_999_900n, 50, COIN_UNIT)).toBe(0n);
    expect(cashbackCoins(3_999_900n, 50, COIN_UNIT)).toBe(1n);
    expect(cashbackCoins(4_000_000n, 50, COIN_UNIT)).toBe(2n);
  });

  it('edges: 0 paid and 0 bps give 0; a 1-tiyin unit counts tiyin', () => {
    expect(cashbackCoins(0n, 50, COIN_UNIT)).toBe(0n);
    expect(cashbackCoins(9_000_000n, 0, COIN_UNIT)).toBe(0n);
    expect(cashbackCoins(10_000n, 100, 1n)).toBe(100n);
  });

  it('refuses a zero or negative unit, a negative payment and bad bps', () => {
    expect(() => cashbackCoins(100n, 50, 0n)).toThrow(MoneyError);
    expect(() => cashbackCoins(100n, 50, -1n)).toThrow(MoneyError);
    expect(() => cashbackCoins(-100n, 50, COIN_UNIT)).toThrow(MoneyError);
    expect(() => cashbackCoins(100n, 10_001, COIN_UNIT)).toThrow(MoneyError);
  });
});

describe('discountForQuote (D-72 (5): DOWN, held to the tier cap, whole so‘m)', () => {
  it('1.5% of 1 000 000 so‘m is exactly the 15 000 so‘m cap', () => {
    expect(
      discountForQuote({
        priceTiyin: 100_000_000n,
        bps: 150,
        maxDiscountTiyin: 1_500_000n,
      }),
    ).toBe(1_500_000n);
  });

  it('the cap holds: 1.5% of 5 000 000 so‘m gives 15 000 so‘m, not 75 000', () => {
    expect(
      discountForQuote({
        priceTiyin: 500_000_000n,
        bps: 150,
        maxDiscountTiyin: 1_500_000n,
      }),
    ).toBe(1_500_000n);
  });

  it('below the cap the percentage wins, rounded DOWN to a whole so‘m', () => {
    // 0.2% of 12 345.67 so‘m = 24.69 so‘m -> 24 so‘m
    expect(
      discountForQuote({
        priceTiyin: 1_234_567n,
        bps: 20,
        maxDiscountTiyin: 200_000n,
      }),
    ).toBe(2_400n);
  });

  it('a cap that is not a whole so‘m still gives a whole so‘m', () => {
    expect(
      discountForQuote({
        priceTiyin: 100_000_000n,
        bps: 150,
        maxDiscountTiyin: 150_050n,
      }),
    ).toBe(150_000n);
  });

  it('edges: 0 bps, a zero cap and a price too small for one so‘m give 0', () => {
    const cap = 1_500_000n;
    expect(
      discountForQuote({
        priceTiyin: 9_000_000n,
        bps: 0,
        maxDiscountTiyin: cap,
      }),
    ).toBe(0n);
    expect(
      discountForQuote({
        priceTiyin: 9_000_000n,
        bps: 150,
        maxDiscountTiyin: 0n,
      }),
    ).toBe(0n);
    expect(discountForQuote({ priceTiyin: 6_666n, bps: 150, maxDiscountTiyin: cap })).toBe(0n);
    expect(discountForQuote({ priceTiyin: 0n, bps: 150, maxDiscountTiyin: cap })).toBe(0n);
  });

  it('is always below the price, even at 99.99%', () => {
    for (const priceTiyin of [100n, 101n, 10_000n, 999_999n, 123_456_789n]) {
      const discount = discountForQuote({
        priceTiyin,
        bps: 9_999,
        maxDiscountTiyin: priceTiyin,
      });
      expect(discount).toBeLessThan(priceTiyin);
      expect(discount % 100n).toBe(0n);
    }
  });

  it('refuses 100% and more, a negative or missing cap and a negative price', () => {
    const cap = 100n;
    const noCap = null as unknown as bigint;
    const bad = [
      { priceTiyin: 100n, bps: 10_000, maxDiscountTiyin: cap },
      { priceTiyin: 100n, bps: 10, maxDiscountTiyin: -1n },
      { priceTiyin: 100n, bps: 10, maxDiscountTiyin: noCap },
      { priceTiyin: -1n, bps: 10, maxDiscountTiyin: cap },
    ];
    for (const input of bad) expect(() => discountForQuote(input)).toThrow(MoneyError);
  });
});
