import type { Quote } from '@repo/db';
import { RecipientSchema, totalAfterDiscount, type QuoteResponse } from '@repo/shared';

// Phase 3 has no discounts (a discountCode is refused with CODE_INVALID); phase 10 stores the
// applied amount and replaces this constant.
const NO_DISCOUNT_TIYIN = 0n;

/**
 * The only place a Quote row becomes the public shape. Fields are listed one by one so cost,
 * maxCost, FX/snapshot ids and markup (all columns of the row) can never reach the wire.
 */
export function toQuoteResponse(row: Quote): QuoteResponse {
  const recipient = RecipientSchema.parse(row.recipient);
  return {
    quoteId: row.id,
    priceTiyin: row.priceTiyin.toString(),
    discountTiyin: NO_DISCOUNT_TIYIN.toString(),
    totalTiyin: totalAfterDiscount(row.priceTiyin, NO_DISCOUNT_TIYIN).toString(),
    expiresAt: row.expiresAt.toISOString(),
    recipient: { username: recipient.username, displayName: recipient.displayName },
    currency: 'UZS',
  };
}
