import { describe, expect, it } from 'vitest';
import {
  LivePayoutError,
  failAndRefundOrder,
  refundFailedOrder,
  sumBalance,
  transitionOrder,
} from '../src/index';
import { db } from './client';
import { expectCheck, expectGuard, expectPrismaCode } from './check-helpers';
import { expectRefused } from './needs-review-expect';
import {
  OPERATOR,
  PRICE,
  addAttempt,
  addTransfer,
  bouncedProof,
  captureError,
  forceAttempt,
  forceTransfer,
  moveTransfer,
  paidOrder,
  refunds,
  reviewOrder,
  uniqueHash,
} from './order-fixtures';
import { resolve } from './order-resolve';

// Owner decision A1 (D-59), second half: one bounce pays one refund, the plain helpers refuse a bounced
// transfer, and what the database does with BOUNCED (the proof itself is in needs-review-bounced).

describe('TON_BOUNCED: one bounce, one refund, and the plain helpers stay out', () => {
  it('one bounce pays one refund: a second order cannot use the same return transaction (audit R2e)', async () => {
    const first = await reviewOrder('BOUNCED');
    const second = await reviewOrder('BOUNCED');
    const returnTxHash = uniqueHash();
    await resolve({
      orderId: first.order.id,
      to: 'FAILED',
      proof: bouncedProof(first.transfer, { returnTxHash }),
      resolver: OPERATOR,
    });
    await expectRefused(
      second,
      'FAILED',
      bouncedProof(second.transfer, { returnTxHash }),
      OPERATOR,
      'RETURN_TX_REUSED',
      'same return tx',
    );
    expect(await sumBalance(db, second.user.id)).toBe(-PRICE);
  });

  it('the database backs that up: two resolution audit rows cannot name the same return transaction', async () => {
    const row = (targetId: string, returnTxHash: string) => ({
      actorType: 'SYSTEM',
      action: 'ORDER_REVIEW_RESOLVE',
      targetType: 'Order',
      targetId,
      after: { proof: { kind: 'TON_BOUNCED', returnTxHash } },
    });
    const hash = uniqueHash();
    await db.auditLog.create({ data: row('order-a', hash) });
    await expectPrismaCode(db.auditLog.create({ data: row('order-b', hash) }), 'P2002');
    // Other actions, other hashes and rows without a return transaction are free.
    await db.auditLog.create({ data: row('order-b', uniqueHash()) });
    await db.auditLog.create({
      data: { ...row('order-c', hash), action: 'SOMETHING_ELSE' },
    });
    await db.auditLog.create({
      data: { ...row('order-d', hash), after: { proof: { kind: 'MANUAL' } } },
    });
  });

  it('the return transaction cannot be one of OUR outgoing transactions (a payout passed off as a bounce)', async () => {
    const bounced = await reviewOrder('BOUNCED');
    const paid = await reviewOrder('CONFIRMED');
    await expectRefused(
      bounced,
      'FAILED',
      bouncedProof(bounced.transfer, { returnTxHash: paid.transfer.txHash }),
      OPERATOR,
      'MISMATCH',
      "another order's confirmed payout as the return",
    );
  });

  it('the plain helpers refuse a bounced transfer: only the proof path is open', async () => {
    const held = await paidOrder('PROCESSING');
    const attempt = await forceAttempt(held.order.id, 'FAILED');
    await forceTransfer(attempt.id, 'BOUNCED');
    const toHeld = await captureError(
      db.$transaction((tx) =>
        transitionOrder(tx, {
          orderId: held.order.id,
          from: 'PROCESSING',
          to: 'HELD',
          actor: 'system',
          reason: 'ADAPTER_ERROR',
        }),
      ),
    );
    expect(toHeld).toBeInstanceOf(LivePayoutError);
    expect((toHeld as LivePayoutError).detail).toContain('BOUNCED');
    const toFailed = await captureError(
      db.$transaction((tx) =>
        failAndRefundOrder(tx, {
          orderId: held.order.id,
          from: 'PROCESSING',
          reason: 'ADAPTER_ERROR',
          actor: 'system',
        }),
      ),
    );
    expect(toFailed).toBeInstanceOf(LivePayoutError);
    const stuck = await paidOrder('FAILED');
    const closed = await forceAttempt(stuck.order.id, 'FAILED');
    await forceTransfer(closed.id, 'BOUNCED');
    const refund = await captureError(
      db.$transaction((tx) => refundFailedOrder(tx, { orderId: stuck.order.id, actor: 'system' })),
    );
    expect(refund).toBeInstanceOf(LivePayoutError);
    expect(await refunds(stuck.order.id)).toHaveLength(0);
  });
});

describe('BOUNCED in the database: where it can come from and what it does to the order', () => {
  it('BROADCAST -> BOUNCED while the order is PROCESSING or NEEDS_REVIEW; CONFIRMED -> BOUNCED when a bounce is found late', async () => {
    const processing = await paidOrder('PROCESSING');
    const attempt = await addAttempt(processing.order.id, 'SENDING');
    const transfer = await addTransfer(attempt.id, 'BROADCAST');
    expect((await moveTransfer(transfer.id, 'BOUNCED')).status).toBe('BOUNCED');

    const late = await paidOrder('PROCESSING');
    const lateAttempt = await addAttempt(late.order.id, 'SENDING');
    const confirmed = await addTransfer(lateAttempt.id, 'CONFIRMED');
    await db.order.update({
      where: { id: late.order.id },
      data: { status: 'NEEDS_REVIEW', statusReason: 'CONFIRM_TIMEOUT' },
    });
    const flipped = await db.tonTransfer.update({
      where: { id: confirmed.id },
      data: { status: 'BOUNCED' },
    });
    // Our transaction's hash and logical time stay what the CONFIRMED edge wrote.
    expect(flipped).toMatchObject({
      status: 'BOUNCED',
      txHash: confirmed.txHash,
      txLt: confirmed.txLt,
    });
  });

  it('a transfer of a DELIVERED order cannot become BOUNCED: a bounced payout never belongs to a delivered order (D-59 A1)', async () => {
    const { order } = await paidOrder('PROCESSING');
    const attempt = await addAttempt(order.id, 'SENDING');
    const transfer = await addTransfer(attempt.id, 'CONFIRMED');
    await db.$transaction(async (tx) => {
      await tx.fulfillmentAttempt.update({
        where: { id: attempt.id },
        data: { status: 'CONFIRMED' },
      });
      await tx.order.update({ where: { id: order.id }, data: { status: 'DELIVERED' } });
    });
    await expectGuard(
      db.tonTransfer.update({ where: { id: transfer.id }, data: { status: 'BOUNCED' } }),
      'can only become BOUNCED while its order is PROCESSING or NEEDS_REVIEW',
    );
    expect((await db.tonTransfer.findUniqueOrThrow({ where: { id: transfer.id } })).status).toBe(
      'CONFIRMED',
    );
  });

  it('BOUNCED needs the transaction hash and the logical time of our message (CHECK)', async () => {
    const { order } = await paidOrder('PROCESSING');
    const attempt = await addAttempt(order.id, 'SENDING');
    const transfer = await addTransfer(attempt.id, 'BROADCAST');
    await expectCheck(
      db.tonTransfer.update({ where: { id: transfer.id }, data: { status: 'BOUNCED', txLt: 7n } }),
      'TonTransfer_chain_tx_check',
    );
    await expectCheck(
      db.tonTransfer.update({
        where: { id: transfer.id },
        data: { status: 'BOUNCED', txHash: uniqueHash() },
      }),
      'TonTransfer_chain_lt_check',
    );
  });
});
