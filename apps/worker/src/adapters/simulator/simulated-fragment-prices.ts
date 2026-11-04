import { SIMULATOR_SOURCE } from '@repo/shared';
import {
  FRAGMENT_ADAPTER,
  type CostLine,
  type CostProduct,
  type CostSource,
} from '../../pricing-sync/cost-sources/cost-source';

/**
 * FAKE Fragment prices for dev/test (FULFILLMENT_DRY_RUN=true only). NOT Fragment's real
 * prices and never fetched from fragment.com: fixed values in a plausible range (≈ $0.015 per
 * Star, ≈ $12 / $16 / $29 for Premium at the simulated 3.2 USDT per TON), constant so tests
 * and local quotes are deterministic. All in nanoTON (owner answer Q17: Fragment costs are TON).
 */
export const SIMULATED_STAR_NANO_TON = 4_700_000n; // 0.0047 TON per Star

/** Premium packs by SKU quantity (months). A SKU of any other length gets no simulated price. */
export const SIMULATED_PREMIUM_NANO_TON: ReadonlyMap<number, bigint> = new Map([
  [3, 3_750_000_000n], // 3.75 TON
  [6, 5_000_000_000n], // 5 TON
  [12, 9_100_000_000n], // 9.1 TON
]);

/**
 * Prices by product shape, not by slug, so the catalog seed can rename products freely:
 * a custom-quantity product (Stars) gets one per-unit product-level row; a fixed-pack product
 * (Premium) gets one row per active SKU whose month count is in the table above.
 */
export class SimulatedFragmentPrices implements CostSource {
  readonly adapter = FRAGMENT_ADAPTER;
  readonly name = SIMULATOR_SOURCE;
  readonly simulated = true;

  costs(product: CostProduct): Promise<readonly CostLine[]> {
    if (product.allowCustomQty) {
      return Promise.resolve([
        { skuId: null, basisQuantity: 1, currency: 'TON', costMinor: SIMULATED_STAR_NANO_TON },
      ]);
    }
    const lines: CostLine[] = [];
    for (const sku of product.skus) {
      const costMinor = SIMULATED_PREMIUM_NANO_TON.get(sku.quantity);
      if (costMinor === undefined) continue;
      lines.push({ skuId: sku.id, basisQuantity: sku.quantity, currency: 'TON', costMinor });
    }
    return Promise.resolve(lines);
  }
}
