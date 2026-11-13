import type { Tx } from '../src/index';
import { db } from './client';

let counter = 0;

/**
 * The legal way to DELIVERED (audit Y1, D-59 N1): the attempt is born SENDING, becomes CONFIRMED and
 * the order becomes DELIVERED in ONE transaction, because "attempt CONFIRMED" is only allowed together
 * with the delivery. The order must be PROCESSING; `transfer` (optional) runs inside the transaction
 * after the attempt exists and before it is confirmed (a TON transfer CONFIRMED for it, say).
 */
export async function deliverLegally(
  orderId: string,
  options: {
    readonly attemptNo?: number;
    readonly beforeConfirm?: (tx: Tx, attemptId: string) => Promise<void>;
  } = {},
) {
  return db.$transaction(async (tx) => {
    const attempt = await tx.fulfillmentAttempt.create({
      data: {
        orderId,
        attemptNo: options.attemptNo ?? 1,
        adapter: 'FRAGMENT',
        status: 'SENDING',
        request: {},
        externalRef: `dref-${++counter}`,
      },
    });
    if (options.beforeConfirm !== undefined) await options.beforeConfirm(tx, attempt.id);
    await tx.fulfillmentAttempt.update({
      where: { id: attempt.id },
      data: { status: 'CONFIRMED' },
    });
    await tx.order.update({ where: { id: orderId }, data: { status: 'DELIVERED' } });
    return attempt;
  });
}
