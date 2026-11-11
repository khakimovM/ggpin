import type { LedgerEntry } from '@repo/db';
import type { LedgerItem } from '@repo/shared';

// Which kinds legitimately point at an order or at a payment (docs/04 "Hamyon"). A link is shown
// only when BOTH the reference type and the kind fit: a corrupt or future row (say an ADJUSTMENT
// that carries an ORDER ref) must not leak an internal id under a public name.
const ORDER_KINDS: ReadonlySet<string> = new Set(['PURCHASE', 'REFUND']);
const PAYMENT_KINDS: ReadonlySet<string> = new Set(['TOPUP', 'TOPUP_REVERSAL']);

// The only place a LedgerEntry row becomes the public /me/ledger item. Fields are listed one by
// one so a new column can never reach the wire. `refType`/`refId` are NOT exposed: an
// ADMIN_ACTION refId is an internal audit id, so only order and payment links are shown, under
// their own names.
export function toLedgerItem(row: LedgerEntry): LedgerItem {
  return {
    id: row.id,
    kind: row.kind,
    amountTiyin: row.amountTiyin.toString(),
    createdAt: row.createdAt.toISOString(),
    orderId: row.refType === 'ORDER' && ORDER_KINDS.has(row.kind) ? row.refId : null,
    paymentId: row.refType === 'PAYMENT' && PAYMENT_KINDS.has(row.kind) ? row.refId : null,
  };
}
