import {
  MoneyError,
  isAuditSecretKey,
  orderGrossProfitTiyin,
  totalAfterDiscount,
  type AdminOrderRow,
} from '@repo/shared';
import { iso, isoOrNull } from '../read/admin-read-view';
import type { AdminOrderRowSource } from './admin-order-rows.repository';

// Keys of the stored recipient that are not input fields: the display name has its own slot and
// the photo is a link, not something the customer typed.
const NOT_A_FIELD = new Set(['displayName', 'photoUrl']);

/**
 * `recipient` of an admin order row: the resolved display name and the customer's input fields
 * (username, player id, ...). Only flat string values, and never a key the audit classifier
 * calls secret (a token a future adapter might store): fail closed.
 */
export function adminRecipient(stored: unknown): AdminOrderRow['recipient'] {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
    return { displayName: null, fields: {} };
  }
  const entries = Object.entries(stored as Record<string, unknown>);
  const displayName = entries.find(([key]) => key === 'displayName')?.[1];
  const fields: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (NOT_A_FIELD.has(key) || isAuditSecretKey(key) || typeof value !== 'string') continue;
    fields[key] = value;
  }
  return { displayName: typeof displayName === 'string' ? displayName : null, fields };
}

/**
 * Profit of a DELIVERED order (null before, docs/04 `AdminOrderRow`): money-pricing.ts at the
 * order's own FX snapshot. A row whose stored cost cannot be priced shows no profit rather than a
 * guessed one.
 */
function profitOf(order: AdminOrderRowSource): string | null {
  if (order.status !== 'DELIVERED') return null;
  try {
    return orderGrossProfitTiyin({
      priceTiyin: order.priceTiyin,
      discountTiyin: order.discountTiyin,
      costCurrency: order.costCurrency,
      costMinor: order.costMinor,
      fxPair: order.fxRate.pair,
      rate: order.fxRate.rate,
    }).toString();
  } catch (error) {
    if (error instanceof MoneyError) return null;
    throw error;
  }
}

export function toAdminOrderRow(order: AdminOrderRowSource): AdminOrderRow {
  return {
    id: order.id,
    number: order.number,
    createdAt: iso(order.createdAt),
    user: { id: order.user.id, username: order.user.username },
    product: { id: order.product.id, slug: order.product.slug, name: order.product.nameUz },
    sku: order.sku === null ? null : { id: order.sku.id, label: order.sku.labelUz },
    quantity: order.quantity,
    recipient: adminRecipient(order.recipient),
    priceTiyin: order.priceTiyin.toString(),
    discountTiyin: order.discountTiyin.toString(),
    totalTiyin: totalAfterDiscount(order.priceTiyin, order.discountTiyin).toString(),
    costCurrency: order.costCurrency,
    costMinor: order.costMinor.toString(),
    profitTiyin: profitOf(order),
    status: order.status,
    statusReason: order.statusReason,
    adapter: order.attempts[0]?.adapter ?? null,
    deliveredAt: isoOrNull(order.deliveredAt),
  };
}
