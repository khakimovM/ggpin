import type { PricingSku } from './price-book.types';

/**
 * Custom quantity (owner decision Q5): the pack whose markup and minimum margin apply is the
 * active SKU with the largest quantity that does not exceed what was asked for. Returns null
 * when the quantity is below every pack (the caller treats it as out of range). Callers must
 * gate on `customQtyRange` first: it is null when two active packs share a quantity, where this
 * pick would depend on row order.
 */
export function pickPricingSku<T extends PricingSku>(
  skus: readonly T[],
  quantity: number,
): T | null {
  let best: T | null = null;
  for (const sku of skus) {
    if (sku.quantity <= quantity && (best === null || sku.quantity > best.quantity)) best = sku;
  }
  return best;
}

export interface CustomQtyRange {
  readonly min: number;
  readonly max: number;
}

/**
 * The quantities a customer can really type for a product, or null when there are none. The
 * stored bounds alone are not enough: a quantity below the smallest ACTIVE pack has no pack to
 * take its markup from (`pickPricingSku` returns null), so it can never be quoted. The catalog
 * and the quote both ask this one function, so the catalog never advertises a quantity the
 * quote refuses.
 *
 * Fail closed on ambiguity: two ACTIVE packs with the same quantity (the schema does not forbid
 * it) would make "which pack prices a typed quantity" depend on row order, so the product has no
 * custom quantity at all until the duplicate is gone. Selling by `skuId` is unaffected. The
 * phase 9 admin panel prevents creating such a pair.
 */
export function customQtyRange(
  product: {
    readonly allowCustomQty: boolean;
    readonly minQty: number | null;
    readonly maxQty: number | null;
  },
  activeSkus: readonly { readonly quantity: number }[],
): CustomQtyRange | null {
  const { allowCustomQty, minQty, maxQty } = product;
  if (!allowCustomQty || minQty === null || maxQty === null) return null;
  let smallest: number | null = null;
  const seen = new Set<number>();
  for (const sku of activeSkus) {
    if (seen.has(sku.quantity)) return null;
    seen.add(sku.quantity);
    if (smallest === null || sku.quantity < smallest) smallest = sku.quantity;
  }
  if (smallest === null || smallest > maxQty) return null;
  return { min: Math.max(minQty, smallest), max: maxQty };
}
