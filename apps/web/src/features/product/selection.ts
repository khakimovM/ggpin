import type { CatalogProductDetail } from '@repo/shared';
import type { Selection } from './use-quote';

const DIGITS = /^\d{1,9}$/;

/** A typed quantity as a whole number, or null when it is empty or not a number. */
export function parseQuantity(raw: string): number | null {
  return DIGITS.test(raw) ? Number(raw) : null;
}

export type QuantityCheck = { ok: true; quantity: number } | { ok: false };

/**
 * Whether a typed quantity can be sent: a whole number inside the range the CATALOG gave
 * (`minQty..maxQty`, the same rule the quote enforces). Outside it no request is made; the form
 * shows the range instead of the server's `QTY_OUT_OF_RANGE`.
 */
export function checkQuantity(raw: string, min: number, max: number): QuantityCheck {
  const quantity = parseQuantity(raw);
  if (quantity === null || quantity < min || quantity > max) return { ok: false };
  return { ok: true, quantity };
}

export type ProductLayout = 'quantity' | 'skus';

/** Free quantity (Stars) or a list of ready packages (Premium, games). */
export function layoutOf(product: CatalogProductDetail): ProductLayout {
  const range = product.minQty !== null && product.maxQty !== null;
  return product.allowCustomQty && range ? 'quantity' : 'skus';
}

/** What the quote would be asked for, or null while the choice is incomplete. */
export function selectionOf(
  product: CatalogProductDetail,
  selectedSku: string | null,
  customQty: string | null,
): Selection | null {
  if (layoutOf(product) === 'quantity') {
    const { minQty, maxQty } = product;
    if (minQty === null || maxQty === null) return null;
    const check = checkQuantity(customQty ?? String(minQty), minQty, maxQty);
    return check.ok ? { kind: 'qty', quantity: check.quantity } : null;
  }
  // A stale id (a package that left the catalog since) is no choice.
  return product.skus.some((sku) => sku.id === selectedSku) && selectedSku !== null
    ? { kind: 'sku', skuId: selectedSku }
    : null;
}

/** Product-level facts the page needs before it can sell anything. */
export function isSupported(product: CatalogProductDetail): boolean {
  // Today only a Telegram username form exists (input-fields.tsx). Any other field, or none (a
  // quote needs a recipient token), is a product this page cannot sell yet: "unavailable".
  return (
    product.inputSchema.length === 1 && product.inputSchema.every((f) => f.type === 'tgUsername')
  );
}

export function isInStock(product: CatalogProductDetail): boolean {
  return product.stock === null || product.stock > 0;
}
