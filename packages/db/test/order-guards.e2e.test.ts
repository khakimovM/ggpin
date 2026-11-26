import { describe, expect, it } from 'vitest';
import {
  LivePayoutError,
  RestrictedTransitionError,
  StaleOrderStateError,
  failAndRefundOrder,
  refundFailedOrder,
  sumBalance,
  transitionOrder,
  type AttemptStatus,
  type OrderTransitionInput,
  type TonTransferStatus,
} from '../src/index';
import { db } from './client';
import {
  PRICE,
  addAttempt,
  addTransfer,
  captureError,
  events,
  forceAttempt,
  forceTransfer,
  moveAttempt,
  paidOrder,
  refunds,
  statusOf,
} from './order-fixtures';

// Audit H2 and the review findings F2, F7: "not sent" must be provable before an order is failed,
// held or refunded; the two edges that move money have one door each; a refund returns what the
// ledger took; a reason and an operator are never missing.

let wallets = 0;
const wallet = () => `0:${(++wallets).toString(16).padStart(64, '0')}`;

const refund = (orderId: string) =>
  db.$transaction((tx) => refundFailedOrder(tx, { orderId, actor: 'system' }));

async function expectUntouched(orderId: string, status: string, userId: string) {
  expect(await statusOf(orderId)).toBe(status);
  expect(await refunds(orderId)).toHaveLength(0);
  expect(await sumBalance(db, userId)).toBe(-PRICE);
}

describe('the two edges that move money have one door each (H2)', () => {
  it('transitionOrder refuses leaving NEEDS_REVIEW, whoever asks', async () => {
    const { user, order } = await paidOrder('NEEDS_REVIEW');
    for (const to of ['DELIVERED', 'FAILED'] as const) {
      for (const actor of [{ actor: 'reconciler' }, { actor: 'admin', actorRef: 'a1' }] as const) {
        const input = {
          orderId: order.id,
          from: 'NEEDS_REVIEW',
          to,
          reason: 'CONFIRM_TIMEOUT',
          ...actor,
        };
        const error = await captureError(
          db.$transaction((tx) => transitionOrder(tx, input as OrderTransitionInput)),
        );
        expect(error, `${to} by ${actor.actor}`).toBeInstanceOf(RestrictedTransitionError);
      }
    }
    await expectUntouched(order.id, 'NEEDS_REVIEW', user.id);
    expect(await events(order.id)).toHaveLength(0);
  });

  it('transitionOrder refuses entering REFUNDED: a FAILED order is not refunded without its ledger entry', async () => {
    const failed = await paidOrder('FAILED');
    const delivered = await paidOrder('DELIVERED');
    for (const [order, from] of [
      [failed.order, 'FAILED'],
      [delivered.order, 'DELIVERED'],
    ] as const) {
      const error = await captureError(
        db.$transaction((tx) =>
          transitionOrder(tx, {
            orderId: order.id,
            from,
            to: 'REFUNDED',
            actor: 'admin',
            actorRef: 'a1',
          }),
        ),
      );
      expect(error, from).toBeInstanceOf(RestrictedTransitionError);
    }
    await expectUntouched(failed.order.id, 'FAILED', failed.user.id);
  });

  it('refundFailedOrder will not take an order straight from NEEDS_REVIEW', async () => {
    const { user, order } = await paidOrder('NEEDS_REVIEW');
    expect(await captureError(refund(order.id))).toBeInstanceOf(StaleOrderStateError);
    await expectUntouched(order.id, 'NEEDS_REVIEW', user.id);
  });
});

describe('no live payout: fail, hold and refund are refused when money may have gone out (H2)', () => {
  it('C2: PROCESSING with a BROADCAST transfer cannot fail or refund', async () => {
    const { user, order } = await paidOrder('PROCESSING');
    const attempt = await addAttempt(order.id, 'SENDING');
    await addTransfer(attempt.id, 'BROADCAST');
    await moveAttempt(attempt.id, 'SENT');
    const error = await captureError(
      db.$transaction((tx) =>
        failAndRefundOrder(tx, {
          orderId: order.id,
          from: 'PROCESSING',
          reason: 'RECIPIENT_GONE',
          actor: 'system',
        }),
      ),
    );
    expect(error).toBeInstanceOf(LivePayoutError);
    await expectUntouched(order.id, 'PROCESSING', user.id);
    expect(await events(order.id)).toHaveLength(0);
  });

  it('C3: PROCESSING with an UNKNOWN attempt cannot go HELD, and a HELD order with one cannot fail', async () => {
    const { user, order } = await paidOrder('PROCESSING');
    await addAttempt(order.id, 'UNKNOWN');
    const toHeld = await captureError(
      db.$transaction((tx) =>
        transitionOrder(tx, {
          orderId: order.id,
          from: 'PROCESSING',
          to: 'HELD',
          actor: 'system',
          reason: 'ADAPTER_ERROR',
        }),
      ),
    );
    expect(toHeld).toBeInstanceOf(LivePayoutError);
    await expectUntouched(order.id, 'PROCESSING', user.id);
    // A HELD order that gets a live attempt afterwards (a bug, a late row) still cannot fail.
    const held = await paidOrder('HELD');
    await forceAttempt(held.order.id, 'UNKNOWN');
    const toFailed = await captureError(
      db.$transaction((tx) =>
        failAndRefundOrder(tx, {
          orderId: held.order.id,
          from: 'HELD',
          reason: 'HELD_EXPIRED',
          actor: 'system',
        }),
      ),
    );
    expect(toFailed).toBeInstanceOf(LivePayoutError);
    await expectUntouched(held.order.id, 'HELD', held.user.id);
  });

  it('a FAILED order that has a live payout is not refunded (the refund checks again)', async () => {
    const { user, order } = await paidOrder('FAILED');
    // A payout on a FAILED order is a state the database refuses: forced, to prove the refund helper does too.
    const attempt = await forceAttempt(order.id, 'CONFIRMED');
    await forceTransfer(attempt.id, 'CONFIRMED');
    expect(await captureError(refund(order.id))).toBeInstanceOf(LivePayoutError);
    await expectUntouched(order.id, 'FAILED', user.id);
  });

  it.each(['SENDING', 'SENT', 'UNKNOWN', 'CONFIRMED'] as const)(
    'an attempt that is %s blocks failing, holding and refunding',
    async (status: AttemptStatus) => {
      for (const to of ['FAILED', 'HELD'] as const) {
        const { order } = await paidOrder('PROCESSING');
        // A CONFIRMED attempt of a PROCESSING order is refused at commit (D-59 N1): forced in.
        if (status === 'CONFIRMED') await forceAttempt(order.id, status);
        else await addAttempt(order.id, status);
        const error = await captureError(
          db.$transaction((tx) =>
            transitionOrder(tx, {
              orderId: order.id,
              from: 'PROCESSING',
              to,
              actor: 'system',
              reason: 'ADAPTER_ERROR',
            }),
          ),
        );
        expect(error, `${status} -> ${to}`).toBeInstanceOf(LivePayoutError);
      }
      const failed = await paidOrder('FAILED');
      await forceAttempt(failed.order.id, status);
      expect(await captureError(refund(failed.order.id))).toBeInstanceOf(LivePayoutError);
    },
  );

  it.each(['SIGNED', 'BROADCAST', 'CONFIRMED', 'ONCHAIN_FAILED', 'CONSUMED_UNMATCHED'] as const)(
    'a transfer that is %s (not provably EXPIRED) blocks failing, holding and refunding',
    async (status: TonTransferStatus) => {
      for (const to of ['FAILED', 'HELD'] as const) {
        const { order } = await paidOrder('PROCESSING');
        // The attempt is FAILED so only the transfer can be the reason for the refusal. A FAILED attempt
        // with a transfer that is not EXPIRED is a state the database refuses: forced.
        const attempt = await forceAttempt(order.id, 'FAILED');
        await forceTransfer(attempt.id, status, { wallet: wallet() });
        const error = await captureError(
          db.$transaction((tx) =>
            transitionOrder(tx, {
              orderId: order.id,
              from: 'PROCESSING',
              to,
              actor: 'system',
              reason: 'ADAPTER_ERROR',
            }),
          ),
        );
        expect(error, `${status} -> ${to}`).toBeInstanceOf(LivePayoutError);
      }
    },
  );

  it('a provably unsent order (no rows, or FAILED attempt with an EXPIRED transfer) can fail and refund', async () => {
    const plain = await paidOrder('PROCESSING');
    const proven = await paidOrder('PROCESSING');
    const attempt = await addAttempt(proven.order.id, 'SENDING');
    await addTransfer(attempt.id, 'EXPIRED');
    await moveAttempt(attempt.id, 'FAILED');
    for (const { user, order } of [plain, proven]) {
      const result = await db.$transaction((tx) =>
        failAndRefundOrder(tx, {
          orderId: order.id,
          from: 'PROCESSING',
          reason: 'RECIPIENT_CHANGED',
          actor: 'system',
        }),
      );
      expect(result.outcome).toBe('REFUNDED');
      expect(await sumBalance(db, user.id)).toBe(0n);
    }
  });

  it('holding with no payout rows is the ordinary path', async () => {
    const { order } = await paidOrder('PROCESSING');
    await db.$transaction((tx) =>
      transitionOrder(tx, {
        orderId: order.id,
        from: 'PROCESSING',
        to: 'HELD',
        actor: 'system',
        reason: 'LIMIT_DAILY',
      }),
    );
    expect(await statusOf(order.id)).toBe('HELD');
  });
});
