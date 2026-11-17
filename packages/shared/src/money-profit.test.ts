import { describe, expect, it } from 'vitest';
import { MoneyError } from './money';
import { orderGrossProfitTiyin, priceFromCost, pricePreview } from './money-pricing';

const TON_UZS = '63000'; // 1 TON = 6 300 000 tiyin
const order = {
  priceTiyin: 1_000_000n,
  discountTiyin: 100_000n,
  costCurrency: 'TON',
  costMinor: 100_000_000n, // 0.1 TON = 630 000 tiyin
  fxPair: 'TON_UZS',
  rate: TON_UZS,
};

describe('orderGrossProfitTiyin', () => {
  it('is price − discount − cost in so’m at the order snapshot', () => {
    expect(orderGrossProfitTiyin(order)).toBe(900_000n - 630_000n);
  });

  it('rounds the cost UP, so a fraction of a tiyin never adds to the profit', () => {
    // 1 nanoTON = 0.0063 tiyin -> 1 tiyin of cost.
    expect(orderGrossProfitTiyin({ ...order, costMinor: 1n })).toBe(900_000n - 1n);
  });

  it('may be negative (sold at a loss)', () => {
    expect(orderGrossProfitTiyin({ ...order, costMinor: 1_000_000_000n })).toBe(
      900_000n - 6_300_000n,
    );
  });

  it('prices USDT costs with USDT_UZS', () => {
    const usdt = { ...order, costCurrency: 'USDT', costMinor: 10_000_000n, fxPair: 'USDT_UZS' };
    expect(orderGrossProfitTiyin({ ...usdt, rate: '12600' })).toBe(900_000n - 12_600_000n);
  });

  it('refuses a snapshot of another pair or an unknown currency (never a guessed rate)', () => {
    expect(() => orderGrossProfitTiyin({ ...order, fxPair: 'USDT_UZS' })).toThrow(MoneyError);
    expect(() => orderGrossProfitTiyin({ ...order, costCurrency: 'UZS' })).toThrow(MoneyError);
    expect(() => orderGrossProfitTiyin({ ...order, costMinor: -1n })).toThrow(MoneyError);
    expect(() => orderGrossProfitTiyin({ ...order, discountTiyin: 2_000_000n })).toThrow(
      MoneyError,
    );
  });
});

describe('pricePreview', () => {
  const input = {
    costMinor: 100_000_000n,
    costCurrency: 'TON' as const,
    rate: TON_UZS,
    markupBps: 1500,
    minMarginTiyin: 0n,
  };

  it('gives exactly the priceFromCost price and its margin', () => {
    const preview = pricePreview(input);
    const { costTiyin, priceTiyin } = priceFromCost(input);
    expect(preview).toEqual({
      costTiyin,
      priceTiyin,
      marginTiyin: priceTiyin - costTiyin,
      belowMinMargin: false,
    });
    expect(preview.marginTiyin).toBe(724_500n - 630_000n);
  });

  it('the minimum margin floor wins over a small markup', () => {
    const preview = pricePreview({ ...input, markupBps: 0, minMarginTiyin: 50_000n });
    expect(preview.priceTiyin).toBe(680_000n);
    expect(preview.marginTiyin).toBe(50_000n);
    expect(preview.belowMinMargin).toBe(false);
  });
});
