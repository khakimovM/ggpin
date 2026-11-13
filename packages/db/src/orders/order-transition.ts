import { assertTransition } from '@repo/shared';
import { assertInTransaction, lockWallet, type Tx } from '../ledger/ledger.js';
import { DeliveryNotProvenError, OrderNotFoundError, RestrictedTransitionError } from './errors.js';
import { applyTransition, type OrderTransitionInput } from './order-transition-core.js';
import {
  assertNoLivePayout,
  deliveryProblem,
  lockOrderRow,
  readPayoutState,
} from './payout-state.js';

export type { OrderTransitionInput, ReasonedStatus } from './order-transition-core.js';

/**
 * The public writer of `Order.status` for the ordinary edges: asserts the move against the state
 * machine of `@repo/shared` (`assertTransition` throws `IllegalOrderTransitionError`), then changes
 * the row with a compare-and-set (`UPDATE ... WHERE id AND status = from`). Zero rows means
 * someone else moved the order first: `StaleOrderStateError`, nothing written. The `OrderEvent`
 * is written in the same transaction, so a status never changes without its history row.
 *
 * Two edges are NOT available here (`RestrictedTransitionError`), because each moves money or
 * decides an unknown outcome and has its own helper that checks what this one cannot:
 * - leaving NEEDS_REVIEW: only `resolveNeedsReview`, with a proof bound to the order's rows;
 * - entering REFUNDED: only `refundFailedOrder` / `failAndRefundOrder`, which write the ledger entry.
 *
 * Entering FAILED, HELD or CANCELLED is "not sent" by definition, so it is checked under lock
 * (wallet, then order row) against the order's own rows: no attempt SENDING / SENT / UNKNOWN /
 * CONFIRMED and every TON transfer EXPIRED, else `LivePayoutError` (audit H2, review R8).
 * Entering FAILED or CANCELLED also takes the wallet lock first (a refund follows), so the lock
 * order is always wallet -> order -> attempt -> transfer.
 *
 * Entering DELIVERED is "sent" by definition, so it is checked under the order lock as well (audit
 * Y1, L5): at least one CONFIRMED attempt, no attempt still SENDING / SENT / UNKNOWN, and every
 * TON transfer CONFIRMED, EXPIRED or ONCHAIN_FAILED, else `DeliveryNotProvenError`. The SQL guard
 * of `Order` enforces the same rule and stamps `deliveredAt` from the database clock (Y11).
 *
 * Moving into HELD / NEEDS_REVIEW / FAILED needs a `reason`; an `admin` actor needs `actorRef`.
 * Must run inside `prisma.$transaction` (throws `NotInTransactionError` otherwise), together with
 * the money movement the new status causes.
 */
export async function transitionOrder(
  tx: Tx,
  input: OrderTransitionInput,
): Promise<{ readonly eventId: string }> {
  assertInTransaction(tx, 'transitionOrder');
  // The illegal edge is the more useful answer, so the state machine speaks first.
  assertTransition(input.from, input.to, input.actor);
  if (input.from === 'NEEDS_REVIEW' || input.to === 'REFUNDED') {
    throw new RestrictedTransitionError(input.from, input.to);
  }
  if (input.to === 'FAILED' || input.to === 'HELD' || input.to === 'CANCELLED') {
    const owner = await tx.order.findUnique({
      where: { id: input.orderId },
      select: { userId: true },
    });
    if (owner === null) throw new OrderNotFoundError(input.orderId);
    // Money moves after FAILED and CANCELLED (the refund): wallet first, like the refund helper.
    if (input.to === 'FAILED' || input.to === 'CANCELLED') await lockWallet(tx, owner.userId);
    await lockOrderRow(tx, input.orderId);
    assertNoLivePayout(input.orderId, await readPayoutState(tx, input.orderId));
  }
  if (input.to === 'DELIVERED') {
    await lockOrderRow(tx, input.orderId);
    const problem = deliveryProblem(await readPayoutState(tx, input.orderId));
    if (problem !== null) throw new DeliveryNotProvenError(input.orderId, problem.detail);
  }
  return applyTransition(tx, input);
}
