import type { PricingSku } from './price-book.types';

/**
 * Custom quantity (owner decision Q5): the pack whose markup and minimum margin apply is the
 * active SKU with the largest quantity that does not exceed what was asked for. Returns null
 * when the quantity is below every pack (the caller treats it as out of range).
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
