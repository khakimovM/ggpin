import { PER_MONTH_DISPLAY_STEP_TIYIN, perUnitDisplayTiyin, type CatalogSku } from '@repo/shared';

// Premium terms (Product.dc.html `isPlans`): "36 700 so‘m/oy" under each term and the "Eng
// foydali" ribbon (owner decision Q6, phase 6). Display only: the figures are laid out from the
// catalog's display price; what the visitor pays comes only from a quote.

/** A positive tiyin string: a free or broken price is never laid out or called the best. */
const PRICE = /^[1-9]\d{0,18}$/;

export interface PlanValues {
  /** SKU id -> price per month as a tiyin string, for the terms that have a display price. */
  perMonth: ReadonlyMap<string, string>;
  /** The term with the lowest price per month, or null when fewer than two can be compared. */
  best: string | null;
}

/**
 * Per-month figures for terms whose `quantity` is the number of months. "Eng foydali" goes to the
 * lowest per-month figure as shown (a tie goes to the longer term), and only when at least two
 * terms can be compared: one term alone is not "the best" of anything.
 */
export function planValues(skus: readonly CatalogSku[]): PlanValues {
  const perMonth = new Map<string, string>();
  let best: { id: string; value: bigint; months: number } | null = null;
  for (const sku of skus) {
    const price = sku.fromPriceTiyin;
    if (price === null || !PRICE.test(price)) continue;
    if (!Number.isSafeInteger(sku.quantity) || sku.quantity <= 0) continue;
    const value = perUnitDisplayTiyin(BigInt(price), sku.quantity, PER_MONTH_DISPLAY_STEP_TIYIN);
    perMonth.set(sku.id, value.toString());
    if (
      best === null ||
      value < best.value ||
      (value === best.value && sku.quantity > best.months)
    ) {
      best = { id: sku.id, value, months: sku.quantity };
    }
  }
  return { perMonth, best: perMonth.size >= 2 && best !== null ? best.id : null };
}
