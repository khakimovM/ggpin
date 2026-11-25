import { SIMULATOR_SOURCE } from '@repo/shared';
import type {
  CostLine,
  CostProduct,
  CostSource,
} from '../../pricing-sync/cost-sources/cost-source';
import { RESELLER_STARS_ADAPTER, SIMULATED_STAR_MICRO_USDT } from './simulated-reseller.adapter';

/**
 * FAKE prices of the dry-run backup provider (FULFILLMENT_DRY_RUN=true only; the cost sync refuses
 * a simulated source otherwise). The same per-Star price the RESELLER_STARS simulator charges in
 * `prepare`, in micro-USDT. It sells Stars only: a custom-quantity product gets one product-level
 * row, a fixed-pack product (Premium) none. Used when the cost sync prices a product from its
 * backup route because Fragment is DOWN (S7 review M2, criterion 5).
 */
export class SimulatedResellerPrices implements CostSource {
  readonly adapter = RESELLER_STARS_ADAPTER;
  readonly name = SIMULATOR_SOURCE;
  readonly simulated = true;

  costs(product: CostProduct): Promise<readonly CostLine[]> {
    if (!product.allowCustomQty) return Promise.resolve([]);
    return Promise.resolve([
      { skuId: null, basisQuantity: 1, currency: 'USDT', costMinor: SIMULATED_STAR_MICRO_USDT },
    ]);
  }
}
