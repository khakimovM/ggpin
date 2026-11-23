import { validationError } from '../../../common/admin/admin-input';
import {
  ADMIN_MAX_MIN_MARGIN_TIYIN,
  packageQuantityInRange,
  premiumMonthsAllowed,
  type AdminCatalogFieldErrorCode,
} from '@repo/shared';
import type { Db } from '../../../infra/prisma/db';
import type { AdminCatalogWriteRepository, LockedProduct } from './admin-catalog-write.repository';

// The domain rules of a catalog write (docs/04 «Katalog», D-63 (8), owner Q5/Q6 and 2026-11-22),
// checked in the write's transaction under the Product row lock. The shared Zod body already
// refused shapes; the money bounds are checked again here because they price every future quote
// (fail closed).

/** What the package rules read (a slice of the repository: unit tests pass a plain fake). */
export type PackageRuleStore = Pick<AdminCatalogWriteRepository, 'activeSkusWithQuantity'>;

/** `400 VALIDATION_ERROR` + `fields[{ path, code }]` (mapped by the admin write runner). */
export function catalogRuleError(path: string, code: AdminCatalogFieldErrorCode | 'INVALID') {
  return validationError(path, code);
}

/** Markup 0..10 000 bps (0–100 %) and minimum margin 0..10 000 000 000 tiyin (100 mln so‘m). */
export function checkPricingFields(fields: {
  readonly markupBps?: number | undefined;
  readonly minMarginTiyin?: bigint | undefined;
}): void {
  const { markupBps, minMarginTiyin } = fields;
  if (
    markupBps !== undefined &&
    (!Number.isInteger(markupBps) || markupBps < 0 || markupBps > 10_000)
  ) {
    throw catalogRuleError('markupBps', 'INVALID');
  }
  if (
    minMarginTiyin !== undefined &&
    (minMarginTiyin < 0n || minMarginTiyin > ADMIN_MAX_MIN_MARGIN_TIYIN)
  ) {
    throw catalogRuleError('minMarginTiyin', 'INVALID');
  }
}

/** A package as it will be after the write. */
export interface PackageAfter {
  /** null for a new package. */
  readonly skuId: string | null;
  readonly quantity: number;
  readonly isActive: boolean;
}

/**
 * The package rules, on the state the write leaves behind:
 * - Telegram Premium: the quantity (months) is 3, 6 or 12 (`PREMIUM_MONTHS`) — checked when the
 *   quantity is set (a new package, or an edit that asks for a quantity);
 * - a free-quantity product: the quantity is inside the product's `minQty..maxQty`
 *   (`QUANTITY_RANGE`, owner 2026-11-22) — checked when the quantity is set, or when the package
 *   is switched on (an older package outside the range does not come back to the store);
 * - a free-quantity product: no second ACTIVE package of the same quantity (`DUPLICATE_PACKAGE`)
 *   — the quote's exact-pack lookup would otherwise be ambiguous. Checked when the package ends
 *   active and its quantity or activity is set by this write. The caller holds the Product lock,
 *   so two parallel writes of one quantity are serialised and the second one sees the first.
 */
export async function checkPackageRules(
  tx: Db,
  repo: PackageRuleStore,
  product: LockedProduct,
  next: PackageAfter,
  touched: { readonly quantity: boolean; readonly isActive: boolean },
): Promise<void> {
  if (touched.quantity && !premiumMonthsAllowed(product.slug, next.quantity)) {
    throw catalogRuleError('quantity', 'PREMIUM_MONTHS');
  }
  const switchedOn = touched.isActive && next.isActive;
  if ((touched.quantity || switchedOn) && !packageQuantityInRange(product, next.quantity)) {
    throw catalogRuleError('quantity', 'QUANTITY_RANGE');
  }
  if (!product.allowCustomQty || !next.isActive) return;
  if (!touched.quantity && !touched.isActive) return;
  const twins = await repo.activeSkusWithQuantity(tx, product.id, next.quantity, next.skuId);
  if (twins > 0) throw catalogRuleError('quantity', 'DUPLICATE_PACKAGE');
}
