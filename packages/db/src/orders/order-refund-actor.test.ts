import { IllegalOrderTransitionError } from '@repo/shared';
import { describe, expect, it, vi } from 'vitest';
import type { Tx } from '../ledger/index.js';
import { OrderNotFoundError } from './errors.js';
import { failAndRefundOrder, refundFailedOrder } from './order-refund.js';

// Audit S9e L-5: the refund helpers took any actor that was not `admin` as `system`. Now the actor
// is checked against the state machine at runtime, before the transaction is read or locked: a
// `reconciler` (or any other value a cast lets through) is refused, never run as `system`.

/** An interactive-transaction stand-in (no $connect) whose order lookup finds nothing. */
function fakeTx() {
  const findUnique = vi.fn(() => Promise.resolve(null));
  return { tx: { order: { findUnique } } as unknown as Tx, findUnique };
}

const HELD = { orderId: 'cm0order1', from: 'HELD', reason: 'HELD_EXPIRED' } as const;

describe('failAndRefundOrder / refundFailedOrder: the actor at runtime', () => {
  it.each(['reconciler', 'root', ''])(
    'refuses actor %j before touching the transaction',
    async (actor) => {
      const { tx, findUnique } = fakeTx();
      const input = { ...HELD, actor: actor as 'system' };
      await expect(failAndRefundOrder(tx, input)).rejects.toBeInstanceOf(
        IllegalOrderTransitionError,
      );
      await expect(
        refundFailedOrder(tx, { orderId: 'cm0order1', actor: actor as 'system' }),
      ).rejects.toBeInstanceOf(IllegalOrderTransitionError);
      expect(findUnique).not.toHaveBeenCalled();
    },
  );

  it('system and admin pass the check (and meet the database: here, no such order)', async () => {
    const { tx, findUnique } = fakeTx();
    await expect(failAndRefundOrder(tx, { ...HELD, actor: 'system' })).rejects.toBeInstanceOf(
      OrderNotFoundError,
    );
    await expect(
      failAndRefundOrder(tx, { ...HELD, actor: 'admin', actorRef: 'admin-1' }),
    ).rejects.toBeInstanceOf(OrderNotFoundError);
    await expect(
      refundFailedOrder(tx, { orderId: 'cm0order1', actor: 'system' }),
    ).rejects.toBeInstanceOf(OrderNotFoundError);
    expect(findUnique).toHaveBeenCalledTimes(3);
  });

  it('PROCESSING -> FAILED stays the system’s: an admin is refused there as before', async () => {
    const { tx, findUnique } = fakeTx();
    const input = { ...HELD, from: 'PROCESSING', actor: 'admin', actorRef: 'admin-1' } as const;
    await expect(failAndRefundOrder(tx, input)).rejects.toBeInstanceOf(IllegalOrderTransitionError);
    expect(findUnique).not.toHaveBeenCalled();
  });
});
