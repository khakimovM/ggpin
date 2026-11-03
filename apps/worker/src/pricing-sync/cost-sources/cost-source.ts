/** The adapter code of ProductRoute rows served by Fragment (docs/06 "Yetkazish turlari"). */
export const FRAGMENT_ADAPTER = 'FRAGMENT';

export type CostCurrency = 'TON' | 'USDT';

/** An active product as a cost source sees it: only its active SKUs. */
export interface CostProduct {
  readonly productId: string;
  /** Stars-like: the customer picks the quantity; priced from one product-level row. */
  readonly allowCustomQty: boolean;
  readonly skus: readonly { readonly id: string; readonly quantity: number }[];
}

/** One future CostSnapshot row: `costMinor` buys `basisQuantity` units. */
export interface CostLine {
  /** null = product-level row (custom-quantity products, basisQuantity 1). */
  readonly skuId: string | null;
  readonly basisQuantity: number;
  readonly currency: CostCurrency;
  /** nanoTON or microUSDT, > 0. */
  readonly costMinor: bigint;
}

/**
 * What one fulfillment adapter currently charges us. Phase 3 has only the Fragment simulator
 * (owner answers Q6, Q17); the real Fragment price fetch arrives with the adapter in phase 5.
 */
export interface CostSource {
  /** ProductRoute.adapter this source prices; written to CostSnapshot.adapter. */
  readonly adapter: string;
  /** Written to CostSnapshot.source. The API refuses `simulator` rows in production (Q15). */
  readonly name: string;
  /** Fake data. A simulated source is used only while FULFILLMENT_DRY_RUN=true. */
  readonly simulated: boolean;
  costs(product: CostProduct): Promise<readonly CostLine[]>;
}

export const COST_SOURCES = Symbol('COST_SOURCES');
