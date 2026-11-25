import { describe, expect, it } from 'vitest';
import {
  LivePayoutError,
  failAndRefundOrder,
  refundFailedOrder,
  sumBalance,
  transitionOrder,
} from '../src/index';
import { db } from './client';
import {
  PRICE,
  addAttempt,
  addTransfer,
  bypassingGuards,
  captureError,
  moveAttempt,
  paidOrder,
  refunds,
  reviewOrder,
  statusOf,
} from './order-fixtures';
import { OPERATOR, manualProof, unmatchedProof } from './order-proofs';
import { resolve } from './order-resolve';

// Phase 5 S9f (owner 2026-11-18): a transfer whose attempt holds a late chain fact (`late`,
// `lateDestination`) is a payout that may have gone out, whatever its status says. No automatic
// refund, hold or cancel may rest on it (`assertNoLivePayout`, under the wallet and order locks):
// the second run's RECIPIENT_GONE refund, the HELD sweep's refund and every other caller are
// refused with `LivePayoutError` and nothing is written. The one way past it is the owner's MANUAL
// FAILED (OTP), or an owner proof bound to the very transfer that carries the late fact
// (order-refund-late-bound.e2e.test.ts has the rest of that rule).

const LATE = { ton: { late: { from: 'EXPIRED', outcome: 'SEQNO_HELD', via: 'SCAN' } } };
// CR M2: the worker's mark on a transfer whose message the owner's hint for ANOTHER transfer found.
const LATE_OTHER = {
  ton: {
    late: {
      from: 'EXPIRED',
      outcome: 'OTHER_TRANSFER',
      via: 'HINT',
      auditId: 'audit-1',
      hintedTransferId: 'cktransfer0000000000000002',
      txHash: 'ab'.repeat(32),
      txLt: '9',
    },
  },
};
const LATE_DESTINATION = { ton: { lateDestination: { verdict: 'NOT_PAID', destTxHash: null } } };

/** A PROCESSING order whose attempt 1 FAILED with its transfer EXPIRED, `response` on it. */
async function afterExpired(response: object | null) {
  const base = await paidOrder('PROCESSING');
  const attempt = await addAttempt(base.order.id, 'SENDING');
  const transfer = await addTransfer(attempt.id, 'EXPIRED');
  await moveAttempt(attempt.id, 'FAILED');
  if (response !== null) {
    await db.fulfillmentAttempt.update({ where: { id: attempt.id }, data: { response } });
  }
  return { ...base, attempt, transfer };
}

const failAndRefund = (orderId: string) =>
  db.$transaction((tx) =>
    failAndRefundOrder(tx, {
      orderId,
      from: 'PROCESSING',
      reason: 'RECIPIENT_GONE',
      actor: 'system',
    }),
  );

async function expectUntouched(orderId: string, userId: string, status: string, label: string) {
  expect(await statusOf(orderId), label).toBe(status);
  expect(await refunds(orderId), label).toHaveLength(0);
  expect(await sumBalance(db, userId), label).toBe(-PRICE);
}

describe('an automatic refund beside a late chain fact is refused (S9f, owner 2026-11-18)', () => {
  it.each([
    ['late', LATE],
    ['lateDestination', LATE_DESTINATION],
    ['late OTHER_TRANSFER (CR M2)', LATE_OTHER],
  ])(
    '%s on the EXPIRED transfer of attempt 1: failAndRefundOrder writes nothing',
    async (key, fact) => {
      const order = await afterExpired(fact);
      const error = await captureError(failAndRefund(order.order.id));
      expect(error, key).toBeInstanceOf(LivePayoutError);
      expect((error as LivePayoutError).detail, key).toBe(
        'transfer is EXPIRED with a late chain fact',
      );
      await expectUntouched(order.order.id, order.user.id, 'PROCESSING', key);
      expect(await db.orderEvent.count({ where: { orderId: order.order.id, to: 'FAILED' } })).toBe(
        0,
      );
    },
  );

  it('control: the same EXPIRED transfer without a late fact is failed and refunded', async () => {
    const order = await afterExpired(null);
    await expect(failAndRefund(order.order.id)).resolves.toMatchObject({
      outcome: 'REFUNDED',
      amountTiyin: PRICE,
    });
    expect(await statusOf(order.order.id)).toBe('REFUNDED');
    expect(await sumBalance(db, order.user.id)).toBe(0n);
  });

  it('HELD is refused too: a hold says "nothing left", the late fact says otherwise', async () => {
    const order = await afterExpired(LATE);
    const error = await captureError(
      db.$transaction((tx) =>
        transitionOrder(tx, {
          orderId: order.order.id,
          from: 'PROCESSING',
          to: 'HELD',
          actor: 'system',
          reason: 'NO_ADAPTER',
        }),
      ),
    );
    expect(error).toBeInstanceOf(LivePayoutError);
    await expectUntouched(order.order.id, order.user.id, 'PROCESSING', 'HELD');
  });

  it('refundFailedOrder checks it itself: a FAILED order beside a late fact is not refunded', async () => {
    const order = await afterExpired(LATE);
    await bypassingGuards((tx) =>
      tx.order.update({
        where: { id: order.order.id },
        data: { status: 'FAILED', statusReason: 'RECIPIENT_GONE' },
      }),
    );
    const error = await captureError(
      db.$transaction((tx) => refundFailedOrder(tx, { orderId: order.order.id, actor: 'system' })),
    );
    expect(error).toBeInstanceOf(LivePayoutError);
    await expectUntouched(order.order.id, order.user.id, 'FAILED', 'refundFailedOrder');
  });
});

describe('the owner is the one way past a late chain fact', () => {
  it('MANUAL FAILED refunds a NEEDS_REVIEW order whose only transfer is EXPIRED with SEQNO_HELD', async () => {
    const review = await reviewOrder('EXPIRED', 'FAILED');
    await db.fulfillmentAttempt.update({
      where: { id: review.attempt.id },
      data: { response: LATE },
    });
    const result = await resolve({
      orderId: review.order.id,
      to: 'FAILED',
      proof: manualProof,
      resolver: OPERATOR,
    });
    expect(result.refund).toMatchObject({ outcome: 'REFUNDED', amountTiyin: PRICE });
    expect(await statusOf(review.order.id)).toBe('REFUNDED');
  });

  it('an owner proof bound to a transfer with its own late fact settles that fact: refunded (owner 2026-11-18)', async () => {
    const review = await reviewOrder('CONSUMED_UNMATCHED');
    await db.fulfillmentAttempt.update({
      where: { id: review.attempt.id },
      data: { response: LATE },
    });
    const result = await resolve({
      orderId: review.order.id,
      to: 'FAILED',
      proof: unmatchedProof(review.transfer),
      resolver: OPERATOR,
    });
    expect(result.refund).toMatchObject({ outcome: 'REFUNDED', amountTiyin: PRICE });
    expect(await statusOf(review.order.id)).toBe('REFUNDED');
    expect(await sumBalance(db, review.user.id)).toBe(0n);
    expect(await refunds(review.order.id)).toHaveLength(1);
    const attempt = await db.fulfillmentAttempt.findUniqueOrThrow({
      where: { id: review.attempt.id },
    });
    expect(attempt.status).toBe('FAILED');
  });
});
