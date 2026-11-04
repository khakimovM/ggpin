// Quote pricing math (phase 3 plan "Pricing math", steps 1-11). Part of the money module
// (.claude/rules/40-domain-money.md): no other file computes a price. Every cost-side step
// rounds UP and every ceiling for what we may be charged rounds DOWN, so rounding can never
// leave us paying more than the customer was quoted for.
import {
  applyMarkup,
  convertPair,
  convertPairForCost,
  type FxPair,
  mulDiv,
  MoneyError,
  roundUpToSom,
} from './money';

/** Currencies a supplier cost can be denominated in (Fragment pays TON, suppliers USDT). */
export const COST_CURRENCIES = ['TON', 'USDT'] as const;
export type CostCurrency = (typeof COST_CURRENCIES)[number];

/** The stored FX pair that converts a cost currency into so'm. */
export const COST_FX_PAIR = { TON: 'TON_UZS', USDT: 'USDT_UZS' } as const satisfies Record<
  CostCurrency,
  FxPair
>;

function positiveInt(value: number, name: string): bigint {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new MoneyError(`${name} must be a positive integer`);
  }
  return BigInt(value);
}

function requireBigInt(value: bigint, name: string, min: bigint): void {
  if (typeof value !== 'bigint') throw new MoneyError(`${name} must be a bigint`);
  if (value < min) throw new MoneyError(`${name} must be at least ${min}`);
}

export interface CostForQuantityInput {
  /** CostSnapshot.costMinor, in TON nano or USDT micro. */
  readonly snapshotCostMinor: bigint;
  /** CostSnapshot.basisQuantity: how many units the snapshot cost buys. */
  readonly basisQuantity: number;
  /** Units being priced. */
  readonly quantity: number;
  /** `sku`: the snapshot prices one pack and the quantity must be exactly that pack.
   *  `product`: the snapshot is per `basisQuantity` units and scales proportionally. */
  readonly scope: 'sku' | 'product';
}

/** Step 1: cost of `quantity` units in the snapshot's currency minor units. Rounds UP. */
export function costForQuantity(input: CostForQuantityInput): bigint {
  const { snapshotCostMinor, basisQuantity, quantity, scope } = input;
  requireBigInt(snapshotCostMinor, 'snapshot cost', 1n);
  const basis = positiveInt(basisQuantity, 'basis quantity');
  const wanted = positiveInt(quantity, 'quantity');
  if (scope === 'sku') {
    if (basis !== wanted) throw new MoneyError('SKU snapshot only prices its own pack size');
    return snapshotCostMinor;
  }
  return mulDiv(snapshotCostMinor, wanted, basis, 'up');
}

export interface PriceFromCostInput {
  readonly costMinor: bigint;
  readonly costCurrency: CostCurrency;
  /** FxRate.rate of `COST_FX_PAIR[costCurrency]`. */
  readonly rate: string;
  readonly markupBps: number;
  readonly minMarginTiyin: bigint;
}

export interface PriceFromCost {
  /** Our cost in tiyin (step 2). */
  readonly costTiyin: bigint;
  /** Customer price in tiyin, a whole number of so'm (steps 3-4). */
  readonly priceTiyin: bigint;
}

/**
 * Steps 2-4: cost to tiyin (UP), the larger of "cost + markup" and "cost + minimum margin"
 * (UP), then up to a whole so'm. Never below cost + minMarginTiyin.
 */
export function priceFromCost(input: PriceFromCostInput): PriceFromCost {
  const { costMinor, costCurrency, rate, markupBps, minMarginTiyin } = input;
  requireBigInt(costMinor, 'cost', 1n);
  requireBigInt(minMarginTiyin, 'minimum margin', 0n);
  const costTiyin = convertPairForCost({
    amount: costMinor,
    pair: COST_FX_PAIR[costCurrency],
    from: costCurrency,
    rate,
  });
  const marked = applyMarkup(costTiyin, markupBps, 'up');
  const floor = costTiyin + minMarginTiyin;
  return { costTiyin, priceTiyin: roundUpToSom(marked > floor ? marked : floor) };
}

export interface MaxCostInput {
  readonly costMinor: bigint;
  readonly costCurrency: CostCurrency;
  readonly rate: string;
  readonly priceTiyin: bigint;
  readonly discountTiyin: bigint;
  readonly minMarginTiyin: bigint;
  /** PRICE_TOLERANCE_BPS: how far the real cost may drift above the quoted cost. */
  readonly toleranceBps: number;
}

/**
 * Steps 6-8: the most fulfillment may pay for this order, in cost-currency minor units.
 * The lower of the drift tolerance and the margin floor (what the customer actually pays,
 * minus the minimum margin, converted back and rounded DOWN). Both caps round down so the
 * ceiling is never generous. Throws if the result would be below the quoted cost: that means
 * the price cannot cover its own cost plus margin and must not become a quote.
 */
export function maxCostFor(input: MaxCostInput): bigint {
  const { costMinor, costCurrency, rate, priceTiyin, discountTiyin, minMarginTiyin } = input;
  requireBigInt(costMinor, 'cost', 1n);
  requireBigInt(priceTiyin, 'price', 0n);
  requireBigInt(discountTiyin, 'discount', 0n);
  requireBigInt(minMarginTiyin, 'minimum margin', 0n);
  const byTolerance = applyMarkup(costMinor, input.toleranceBps, 'down');
  const byMargin = convertPair({
    amount: priceTiyin - discountTiyin - minMarginTiyin,
    pair: COST_FX_PAIR[costCurrency],
    from: 'UZS',
    rate,
    rounding: 'down',
  });
  const maxCostMinor = byTolerance < byMargin ? byTolerance : byMargin;
  if (maxCostMinor < costMinor) {
    throw new MoneyError('maxCost is below the quoted cost: price does not cover cost plus margin');
  }
  return maxCostMinor;
}

/**
 * Step 10, display only: price of one unit given the price of a pack. Rounds UP so the
 * "from X per unit" hint is never lower than what a pack really costs per unit.
 */
export function unitDisplayPrice(fromPriceTiyin: bigint, quantity: number): bigint {
  requireBigInt(fromPriceTiyin, 'price', 0n);
  return mulDiv(fromPriceTiyin, 1n, positiveInt(quantity, 'quantity'), 'up');
}

/**
 * Step 5: what the customer pays for a quote. A discount can never exceed the price (the
 * total is never negative) and is never negative itself (it cannot raise the price).
 */
export function totalAfterDiscount(priceTiyin: bigint, discountTiyin: bigint): bigint {
  requireBigInt(priceTiyin, 'price', 0n);
  requireBigInt(discountTiyin, 'discount', 0n);
  if (discountTiyin > priceTiyin) {
    throw new MoneyError('discount is larger than the price');
  }
  return priceTiyin - discountTiyin;
}
