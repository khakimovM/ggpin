import { describe, expect, it } from 'vitest';
import { MoneyError } from './money';
import {
  COST_CURRENCIES,
  COST_FX_PAIR,
  costForQuantity,
  maxCostFor,
  priceFromCost,
  totalAfterDiscount,
  unitDisplayPrice,
} from './money-pricing';

const notABigInt = (value: number): bigint => value as unknown as bigint;
const TON_UZS = '63000'; // so'm per 1 TON: 1 TON = 6 300 000 tiyin
const USDT_UZS = '12600.5';

describe('cost currencies', () => {
  it("maps each cost currency to the so'm pair that converts it", () => {
    expect(COST_CURRENCIES).toEqual(['TON', 'USDT']);
    expect(COST_FX_PAIR).toEqual({ TON: 'TON_UZS', USDT: 'USDT_UZS' });
  });
});

describe('costForQuantity (step 1)', () => {
  it('SKU-level snapshot returns its cost for exactly its own pack', () => {
    expect(
      costForQuantity({ snapshotCostMinor: 777n, basisQuantity: 3, quantity: 3, scope: 'sku' }),
    ).toBe(777n);
    expect(() =>
      costForQuantity({ snapshotCostMinor: 777n, basisQuantity: 3, quantity: 6, scope: 'sku' }),
    ).toThrow(MoneyError);
  });

  it('product-level snapshot scales proportionally and rounds UP', () => {
    // no remainder: 2 TON per 1 star-basis x 50
    expect(
      costForQuantity({
        snapshotCostMinor: 2_000_000_000n,
        basisQuantity: 1,
        quantity: 50,
        scope: 'product',
      }),
    ).toBe(100_000_000_000n);
    // 7 nano per 3 units: 9 units = 21 exactly, 10 units = 23.33 -> 24
    const base = { snapshotCostMinor: 7n, basisQuantity: 3, scope: 'product' } as const;
    expect(costForQuantity({ ...base, quantity: 9 })).toBe(21n);
    expect(costForQuantity({ ...base, quantity: 10 })).toBe(24n);
    expect(costForQuantity({ ...base, quantity: 1 })).toBe(3n); // 2.33 -> 3, never 2
  });

  it('rejects non-positive or non-integer quantities and invalid costs', () => {
    const ok = { snapshotCostMinor: 7n, basisQuantity: 3, quantity: 3, scope: 'product' } as const;
    expect(() => costForQuantity({ ...ok, quantity: 0 })).toThrow(MoneyError);
    expect(() => costForQuantity({ ...ok, quantity: 1.5 })).toThrow(MoneyError);
    expect(() => costForQuantity({ ...ok, basisQuantity: 0 })).toThrow(MoneyError);
    expect(() => costForQuantity({ ...ok, snapshotCostMinor: 0n })).toThrow(MoneyError);
    expect(() => costForQuantity({ ...ok, snapshotCostMinor: -1n })).toThrow(MoneyError);
    expect(() => costForQuantity({ ...ok, snapshotCostMinor: notABigInt(7) })).toThrow(MoneyError);
  });
});

describe('priceFromCost (steps 2-4)', () => {
  it('exact conversion and markup, no remainder anywhere', () => {
    // 1 TON = 6 300 000 tiyin; +10% = 6 930 000, already whole so'm
    expect(
      priceFromCost({
        costMinor: 1_000_000_000n,
        costCurrency: 'TON',
        rate: TON_UZS,
        markupBps: 1000,
        minMarginTiyin: 0n,
      }),
    ).toEqual({ costTiyin: 6_300_000n, priceTiyin: 6_930_000n });
  });

  it("rounds the FX conversion UP, the markup UP, and the price UP to a whole so'm", () => {
    // 7 nano = 0.0441 tiyin -> 1; 1 * 1.1 = 1.1 -> 2; 2 tiyin -> 100 (1 so'm)
    expect(
      priceFromCost({
        costMinor: 7n,
        costCurrency: 'TON',
        rate: TON_UZS,
        markupBps: 1000,
        minMarginTiyin: 0n,
      }),
    ).toEqual({ costTiyin: 1n, priceTiyin: 100n });
    // 1.000001 USDT = 1 260 051.26 tiyin -> 1 260 052; +10% = 1 386 057.2 -> 1 386 058;
    // -> 1 386 100
    expect(
      priceFromCost({
        costMinor: 1_000_001n,
        costCurrency: 'USDT',
        rate: USDT_UZS,
        markupBps: 1000,
        minMarginTiyin: 0n,
      }),
    ).toEqual({ costTiyin: 1_260_052n, priceTiyin: 1_386_100n });
  });

  it('the minimum margin wins when the markup is smaller than it', () => {
    // markup 0 -> 6 300 000; floor = cost + 50 000 = 6 350 000
    expect(
      priceFromCost({
        costMinor: 1_000_000_000n,
        costCurrency: 'TON',
        rate: TON_UZS,
        markupBps: 0,
        minMarginTiyin: 50_000n,
      }).priceTiyin,
    ).toBe(6_350_000n);
    // markup 10% = 630 000 margin beats a 50 000 minimum
    expect(
      priceFromCost({
        costMinor: 1_000_000_000n,
        costCurrency: 'TON',
        rate: TON_UZS,
        markupBps: 1000,
        minMarginTiyin: 50_000n,
      }).priceTiyin,
    ).toBe(6_930_000n);
  });

  it("rounds the floor itself up to a whole so'm", () => {
    // floor 6 300 000 + 1 = 6 300 001 -> 6 300 100
    expect(
      priceFromCost({
        costMinor: 1_000_000_000n,
        costCurrency: 'TON',
        rate: TON_UZS,
        markupBps: 0,
        minMarginTiyin: 1n,
      }).priceTiyin,
    ).toBe(6_300_100n);
  });

  it('rejects a zero cost, a negative margin and bad markup', () => {
    const ok = {
      costMinor: 1n,
      costCurrency: 'TON',
      rate: TON_UZS,
      markupBps: 0,
      minMarginTiyin: 0n,
    } as const;
    expect(() => priceFromCost({ ...ok, costMinor: 0n })).toThrow(MoneyError);
    expect(() => priceFromCost({ ...ok, minMarginTiyin: -1n })).toThrow(MoneyError);
    expect(() => priceFromCost({ ...ok, markupBps: -1 })).toThrow(MoneyError);
    expect(() => priceFromCost({ ...ok, rate: '0' })).toThrow(MoneyError);
  });
});

describe('maxCostFor (steps 6-8)', () => {
  const base = {
    costMinor: 1_000_000_000n,
    costCurrency: 'TON',
    rate: TON_UZS,
    discountTiyin: 0n,
    minMarginTiyin: 0n,
    toleranceBps: 300,
  } as const;

  it('fixture 1: the tolerance binds', () => {
    // price 6 930 000 -> margin cap 1 100 000 000; tolerance cap 1 030 000 000
    expect(maxCostFor({ ...base, priceTiyin: 6_930_000n })).toBe(1_030_000_000n);
  });

  it('fixture 2: the margin floor binds', () => {
    // price = cost + 2% = 6 426 000 -> margin cap 1 020 000 000 < tolerance cap 1 030 000 000
    expect(maxCostFor({ ...base, priceTiyin: 6_426_000n })).toBe(1_020_000_000n);
  });

  it('the minimum margin lowers the margin cap, down to exactly the cost', () => {
    // price 6 350 000 - margin 50 000 = 6 300 000 tiyin = exactly 1 TON
    expect(maxCostFor({ ...base, priceTiyin: 6_350_000n, minMarginTiyin: 50_000n })).toBe(
      1_000_000_000n,
    );
  });

  it('both caps round DOWN', () => {
    // cost 7: tolerance 7 * 1.03 = 7.21 -> 7 (not 8)
    expect(maxCostFor({ ...base, costMinor: 7n, priceTiyin: 100n })).toBe(7n);
    // cost 1 234 567 891: price 7 777 800; margin cap 1 234 571 428.57 -> 1 234 571 428
    expect(maxCostFor({ ...base, costMinor: 1_234_567_891n, priceTiyin: 7_777_800n })).toBe(
      1_234_571_428n,
    );
  });

  it('a discount shrinks the margin cap', () => {
    // (6 426 000 - 100 000) / 6 300 000 TON = 1 004 126 984.1, below the tolerance cap, above cost
    expect(maxCostFor({ ...base, priceTiyin: 6_426_000n, discountTiyin: 100_000n })).toBe(
      1_004_126_984n,
    );
  });

  it('throws when the (discounted) price cannot cover the cost: invariant maxCost >= cost', () => {
    expect(() => maxCostFor({ ...base, priceTiyin: 6_426_000n, discountTiyin: 500_000n })).toThrow(
      MoneyError,
    );
    expect(() => maxCostFor({ ...base, priceTiyin: 100n, discountTiyin: 100n })).toThrow(
      MoneyError,
    );
    // price below the minimum margin gives a negative margin cap
    expect(() => maxCostFor({ ...base, priceTiyin: 100n, minMarginTiyin: 200n })).toThrow(
      MoneyError,
    );
  });

  it('rejects negative inputs and non-bigints', () => {
    const ok = { ...base, priceTiyin: 6_930_000n };
    expect(() => maxCostFor({ ...ok, costMinor: 0n })).toThrow(MoneyError);
    expect(() => maxCostFor({ ...ok, priceTiyin: -1n })).toThrow(MoneyError);
    expect(() => maxCostFor({ ...ok, discountTiyin: -1n })).toThrow(MoneyError);
    expect(() => maxCostFor({ ...ok, minMarginTiyin: -1n })).toThrow(MoneyError);
    expect(() => maxCostFor({ ...ok, priceTiyin: notABigInt(1) })).toThrow(MoneyError);
    expect(() => maxCostFor({ ...ok, toleranceBps: -1 })).toThrow(MoneyError);
  });
});

describe('unitDisplayPrice (step 10)', () => {
  it('divides a pack price into a per-unit price, rounding UP', () => {
    expect(unitDisplayPrice(1_100_000n, 50)).toBe(22_000n); // docs/04 sample, no remainder
    expect(unitDisplayPrice(100n, 3)).toBe(34n); // 33.33 -> 34, never 33
    expect(unitDisplayPrice(0n, 3)).toBe(0n);
  });

  it('rejects a non-positive quantity and a negative price', () => {
    expect(() => unitDisplayPrice(100n, 0)).toThrow(MoneyError);
    expect(() => unitDisplayPrice(-1n, 1)).toThrow(MoneyError);
  });
});

describe('totalAfterDiscount (step 5)', () => {
  it('subtracts the discount from the price', () => {
    expect(totalAfterDiscount(550_000n, 0n)).toBe(550_000n);
    expect(totalAfterDiscount(550_000n, 50_000n)).toBe(500_000n);
    expect(totalAfterDiscount(550_000n, 550_000n)).toBe(0n);
  });

  it('refuses a discount above the price, a negative discount and a negative price', () => {
    expect(() => totalAfterDiscount(100n, 101n)).toThrow(MoneyError);
    expect(() => totalAfterDiscount(100n, -1n)).toThrow(MoneyError);
    expect(() => totalAfterDiscount(-1n, 0n)).toThrow(MoneyError);
    expect(() => totalAfterDiscount(notABigInt(100), 0n)).toThrow(MoneyError);
  });
});
