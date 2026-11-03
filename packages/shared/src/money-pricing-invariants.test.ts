import { describe, expect, it } from 'vitest';
import { convertPairForCost, roundUpToSom } from './money';
import {
  COST_CURRENCIES,
  COST_FX_PAIR,
  maxCostFor,
  priceFromCost,
  type CostCurrency,
} from './money-pricing';

const TON_UZS = '63000';
const USDT_UZS = '12600.5';

describe('pricing invariants over a grid', () => {
  const costs = [1n, 7n, 999n, 123_456_789n, 1_234_567_891n, 9_999_999_999_999n];
  const rates: Record<CostCurrency, readonly string[]> = {
    TON: [TON_UZS, '63012.3456789', '0.000000000000000001', '4.123456789012345678'],
    USDT: [USDT_UZS, '12599.999999', '1'],
  };
  const markups = [0, 1, 300, 1000, 10_000];
  const margins = [0n, 1n, 12_345n];
  const tolerances = [0, 300, 10_000];

  it('holds for every combination', () => {
    let checked = 0;
    for (const costCurrency of COST_CURRENCIES) {
      for (const rate of rates[costCurrency]) {
        for (const costMinor of costs) {
          for (const markupBps of markups) {
            for (const minMarginTiyin of margins) {
              const { costTiyin, priceTiyin } = priceFromCost({
                costMinor,
                costCurrency,
                rate,
                markupBps,
                minMarginTiyin,
              });
              // the customer price is a whole so'm, never below cost + margin floor
              expect(priceTiyin % 100n).toBe(0n);
              expect(priceTiyin).toBeGreaterThanOrEqual(costTiyin + minMarginTiyin);
              expect(priceTiyin).toBe(roundUpToSom(priceTiyin));
              // cost conversion is the upward one
              expect(costTiyin).toBe(
                convertPairForCost({
                  amount: costMinor,
                  pair: COST_FX_PAIR[costCurrency],
                  from: costCurrency,
                  rate,
                }),
              );
              for (const toleranceBps of tolerances) {
                const maxCostMinor = maxCostFor({
                  costMinor,
                  costCurrency,
                  rate,
                  priceTiyin,
                  discountTiyin: 0n,
                  minMarginTiyin,
                  toleranceBps,
                });
                // never below the quoted cost, never above the tolerance
                expect(maxCostMinor).toBeGreaterThanOrEqual(costMinor);
                expect(maxCostMinor).toBeLessThanOrEqual(
                  (costMinor * BigInt(10_000 + toleranceBps)) / 10_000n,
                );
                // paying the maximum still leaves the minimum margin
                const worstCaseTiyin = convertPairForCost({
                  amount: maxCostMinor,
                  pair: COST_FX_PAIR[costCurrency],
                  from: costCurrency,
                  rate,
                });
                expect(worstCaseTiyin).toBeLessThanOrEqual(priceTiyin - minMarginTiyin);
                checked += 1;
              }
            }
          }
        }
      }
    }
    expect(checked).toBe(
      (4 + 3) * costs.length * markups.length * margins.length * tolerances.length,
    );
  });
});
