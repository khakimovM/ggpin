import type { OrderStatusReason } from '@repo/shared';
import { appendLedgerEntry, assertInTransaction, lockWallet, type Tx } from '../ledger/ledger.js';
import {
  OrderNotFoundError,
  PurchaseEntryMismatchError,
  PurchaseEntryMissingError,
  StaleOrderStateError,
} from './errors.js';
import { applyTransition } from './order-transition-core.js';
import { transitionOrder } from './order-transition.js';
import { assertNoLivePayout, lockOrderRow, readPayoutState } from './payout-state.js';

type RefundActor =
  | { readonly actor: 'system'; readonly actorRef?: null }
  /**
   * order-state.ts allows FAILED -> REFUNDED for `system` and `admin` only: a reconciler that
   * failed an order refunds it as `system`, an operator as `admin` (and must be named).
   */
  | { readonly actor: 'admin'; readonly actorRef: string };

export type RefundFailedOrderInput = {
  readonly orderId: string;
  readonly note?: string;
} & RefundActor;

export type RefundOutcome =
  | {
      readonly outcome: 'REFUNDED';
      readonly userId: string;
      /** What went back to the wallet: exactly what the PURCHASE entry took. */
      readonly amountTiyin: bigint;
      readonly ledgerEntryId: string;
    }
  /** A second call: the order was already REFUNDED, nothing was written. */
  | { readonly outcome: 'ALREADY_REFUNDED'; readonly userId: string };

/**
 * FAILED -> REFUNDED plus the `REFUND` ledger entry (`ORDER/<orderId>`), in the caller's
 * transaction. The order must already be FAILED (the caller moved it there in the same or an
 * earlier transaction); any other state is `StaleOrderStateError`.
 *
 * Lock order: the user's wallet FIRST (every money movement of a user is serialised), then the
 * order row; the status is read only after both. A concurrent refund has finished by then, so the
 * second caller sees REFUNDED and answers `ALREADY_REFUNDED` without touching the ledger. It does
 * not rely on catching the unique violation (`LedgerEntry(refType, refId, kind)`), because a
 * failed statement aborts the whole Postgres transaction; that unique stays as the backstop.
 *
 * Under that lock it checks what makes a refund true (audit H2, M4; review F2):
 * - no payout may have gone out: no attempt SENDING / SENT / UNKNOWN / CONFIRMED, every TON
 *   transfer EXPIRED (`LivePayoutError`);
 * - the money returned is read from the ledger: the order's own PURCHASE entry must exist
 *   (`PurchaseEntryMissingError`) and equal `priceTiyin - discountTiyin`
 *   (`PurchaseEntryMismatchError`). The ledger wins: nothing is credited that was never taken.
 * The order keeps its `statusReason`, so the cause of the failure outlives the refund.
 *
 * After commit the caller deletes `wallet:{userId}` and enqueues `ORDER_REFUNDED`, only for the
 * `REFUNDED` outcome. A caller that catches `PurchaseEntryMissingError` must log it as an error.
 */
export function refundFailedOrder(tx: Tx, input: RefundFailedOrderInput): Promise<RefundOutcome> {
  return refundFailedOrderWith(tx, input, {});
}

/**
 * INTERNAL: `refundFailedOrder` for `resolveNeedsReview`, which has just bound an owner's proof
 * (TON_NOT_DEBITED, TON_BOUNCED, TON_UNMATCHED_RESOLVED) to the transfers listed in
 * `provenTransferIds`: only those, and only when failed on the chain, bounced or consumed without
 * a match, no longer stop the refund (owner decisions A1-A4). Not exported from the package index.
 */
export async function refundFailedOrderWith(
  tx: Tx,
  input: RefundFailedOrderInput,
  options: { readonly provenTransferIds?: readonly string[] },
): Promise<RefundOutcome> {
  assertInTransaction(tx, 'refundFailedOrder');
  const owner = await tx.order.findUnique({
    where: { id: input.orderId },
    select: { userId: true },
  });
  if (owner === null) throw new OrderNotFoundError(input.orderId);
  await lockWallet(tx, owner.userId);
  await lockOrderRow(tx, input.orderId);

  const order = await tx.order.findUnique({
    where: { id: input.orderId },
    select: { status: true, priceTiyin: true, discountTiyin: true },
  });
  if (order === null) throw new OrderNotFoundError(input.orderId);
  if (order.status === 'REFUNDED') return { outcome: 'ALREADY_REFUNDED', userId: owner.userId };
  if (order.status !== 'FAILED') throw new StaleOrderStateError(input.orderId, 'FAILED');

  assertNoLivePayout(input.orderId, await readPayoutState(tx, input.orderId), options);

  const purchase = await tx.ledgerEntry.findUnique({
    where: {
      refType_refId_kind: { refType: 'ORDER', refId: input.orderId, kind: 'PURCHASE' },
    },
    select: { userId: true, amountTiyin: true },
  });
  if (purchase === null) throw new PurchaseEntryMissingError(input.orderId);
  const orderTotal = order.priceTiyin - order.discountTiyin;
  const amountTiyin = -purchase.amountTiyin;
  if (purchase.userId !== owner.userId || amountTiyin !== orderTotal) {
    throw new PurchaseEntryMismatchError(input.orderId, orderTotal, amountTiyin);
  }

  await applyTransition(tx, {
    orderId: input.orderId,
    from: 'FAILED',
    to: 'REFUNDED',
    note: input.note ?? 'refund of a failed order',
    ...(input.actor === 'admin'
      ? { actor: 'admin' as const, actorRef: input.actorRef }
      : { actor: 'system' as const }),
  });
  const entry = await appendLedgerEntry(tx, {
    userId: owner.userId,
    kind: 'REFUND',
    amountTiyin,
    refType: 'ORDER',
    refId: input.orderId,
  });
  return { outcome: 'REFUNDED', userId: owner.userId, amountTiyin, ledgerEntryId: entry.id };
}

export type FailAndRefundInput = {
  readonly orderId: string;
  /** Where the order is now: a failure before sending, or a HELD order that ran out of time. */
  readonly from: 'PROCESSING' | 'HELD';
  /** Why it failed (`RECIPIENT_GONE`, `RECIPIENT_CHANGED`, `HELD_EXPIRED`...). Kept after the refund. */
  readonly reason: OrderStatusReason;
  readonly note?: string;
} & RefundActor;

/**
 * PROCESSING|HELD -> FAILED -> REFUNDED in one go, with the lock order the other money helpers
 * use: wallet first, then order. Prefer it to two separate calls: calling `transitionOrder(FAILED)`
 * and `refundFailedOrder` by hand also works (both lock wallet before order), but this one cannot
 * be called in the wrong order or half-done. Both legs run in the caller's transaction.
 */
export async function failAndRefundOrder(
  tx: Tx,
  input: FailAndRefundInput,
): Promise<RefundOutcome> {
  assertInTransaction(tx, 'failAndRefundOrder');
  const owner = await tx.order.findUnique({
    where: { id: input.orderId },
    select: { userId: true },
  });
  if (owner === null) throw new OrderNotFoundError(input.orderId);
  await lockWallet(tx, owner.userId);
  // `transitionOrder` re-takes the (already held) wallet lock, then the order row, and refuses
  // when a payout may have gone out.
  await transitionOrder(tx, {
    orderId: input.orderId,
    from: input.from,
    to: 'FAILED',
    reason: input.reason,
    note: input.note ?? `failed: ${input.reason}`,
    ...(input.actor === 'admin'
      ? { actor: 'admin' as const, actorRef: input.actorRef }
      : { actor: 'system' as const }),
  });
  return refundFailedOrder(tx, input);
}
