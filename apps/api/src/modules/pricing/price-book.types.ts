import type { CostCurrency } from '@repo/shared';

/** The SKU row whose markup and minimum margin price an order. */
export interface PricingSku {
  readonly id: string;
  readonly quantity: number;
  readonly markupBps: number;
  readonly minMarginTiyin: bigint;
}

export interface PriceRequest {
  readonly product: { readonly id: string };
  /** Fixed pack: the SKU itself. Custom quantity: `pickPricingSku(skus, quantity)`. */
  readonly pricingSku: PricingSku;
  /** The pack being bought, or null for a custom quantity (priced from the product snapshot). */
  readonly sku: { readonly id: string } | null;
  readonly quantity: number;
  readonly now: Date;
  /** Discount applied to the price; lowers the margin ceiling. Always 0 in phase 3. */
  readonly discountTiyin?: bigint;
}

export interface PriceResult {
  readonly costCurrency: CostCurrency;
  /** Our cost in TON nano / USDT micro. Never sent to a client. */
  readonly costMinor: bigint;
  readonly costSnapshotId: string;
  readonly fxRateId: string;
  readonly priceTiyin: bigint;
  /** Most fulfillment may pay (cost currency minor units). Never sent to a client. */
  readonly maxCostMinor: bigint;
}

export interface DisplayProduct {
  readonly id: string;
  /** Active SKUs only. */
  readonly skus: readonly PricingSku[];
}

export interface ProductDisplayPrices {
  /** Cheapest priced pack; null when no pack has a fresh price. */
  readonly fromPriceTiyin: bigint | null;
  /** Price of the smallest pack divided by its quantity (display only); null as above. */
  readonly unitPriceTiyin: bigint | null;
  /** skuId -> price, only for packs with a fresh price. */
  readonly skuPriceTiyin: ReadonlyMap<string, bigint>;
}
