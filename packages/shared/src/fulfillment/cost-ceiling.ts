// The ONE cost ceiling fulfillment compares against (carried over from the phase 3 review, I4).
//
// `maxCostFor` (money-pricing.ts) computes the ceiling ONCE, at quote time, from
// PRICE_TOLERANCE_BPS and the margin floor, and the quote stores it as `Quote.maxCostMinor`; the
// order copies it as `Order.maxCostMinor`. From then on that stored number is the only truth:
// - the worker NEVER reads PRICE_TOLERANCE_BPS (a changed env must not move the ceiling of an
//   order the customer already paid for) and never recomputes a ceiling from a fresh cost;
// - freshness of the FX/cost behind the quote is checked only when the quote is issued, not when
//   the order is created (N3 of the phase 3 review): the tolerance bounds that gap.
//
// The ceiling is in the ORDER's cost currency (`Order.costCurrency`, TON nanotons or USDT micro
// units). Phase 5 has NO cross-currency comparison: the order carries one FX snapshot (a single
// pair), so it cannot convert an adapter's other currency honestly. An adapter that costs in a
// currency other than `Order.costCurrency` is not usable for the order (HELD `NO_ADAPTER`), and
// `exceedsCostCeiling` throws instead of comparing numbers of different units (review F3, L5).
import { MoneyError } from '../money';
import type { CostCurrency } from '../money-pricing';

/** The stored ceiling and the unit it is in: exactly the Order columns, nothing recomputed. */
export interface StoredCostCeiling {
  readonly costCurrency: CostCurrency;
  /** `Order.costMinor`: what the quote expected to pay. */
  readonly costMinor: bigint;
  /** `Order.maxCostMinor`: the most fulfillment may pay. */
  readonly maxCostMinor: bigint;
}

/** What the provider asks for, with its unit. */
export interface ActualCost {
  readonly currency: CostCurrency;
  readonly amountMinor: bigint;
}

/**
 * True when paying `actual` would break the ceiling, so the order must be HELD
 * (`PRICE_ABOVE_MAX`). A payment exactly at the ceiling is allowed; one unit above is not.
 * Throws `MoneyError` when `actual.currency` is not the ceiling's currency: the caller must have
 * refused that adapter before it got here.
 */
export function exceedsCostCeiling(ceiling: StoredCostCeiling, actual: ActualCost): boolean {
  if (actual.currency !== ceiling.costCurrency) {
    throw new MoneyError(
      `cannot compare ${actual.currency} with a ${ceiling.costCurrency} cost ceiling`,
    );
  }
  return actual.amountMinor > ceiling.maxCostMinor;
}
