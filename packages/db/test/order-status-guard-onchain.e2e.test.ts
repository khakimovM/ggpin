import { describe, expect, it } from 'vitest';
import type { TonTransferStatus, Tx } from '../src/index';
import { db } from './client';
import { expectCheck, expectGuard } from './check-helpers';
import {
  PRICE,
  addAttempt,
  bouncedProof,
  notDebitedProof,
  unmatchedProof,
  bypassingGuards,
  addTransfer,
  forceAttempt,
  forceTransfer,
  moveAttempt,
  moveTransfer,
  paidOrder,
  resolveAuditData,
  reviewOrder,
  statusOf,
  uniqueHash,
} from './order-fixtures';

// Owner decisions A1-A4 (D-59), the database side: a transfer that failed ON THE CHAIN, was BOUNCED
// or lost its seqno to an unknown transaction (the three "review-only" ones) lets an order go
// NEEDS_REVIEW -> FAILED and FAILED -> REFUNDED, and nothing else; the proof's audit row is demanded
// at COMMIT. The proofs themselves are in needs-review-*.e2e.test.ts.

// The full proof of each transfer, as resolveNeedsReview writes it into the audit row (I-1: the SQL
// check compares the transaction, the return transaction and the resolver type, not just the kind).
const REVIEW_ONLY = [
  ['ONCHAIN_FAILED', 'TON_NOT_DEBITED', notDebitedProof],
  ['BOUNCED', 'TON_BOUNCED', bouncedProof],
  ['CONSUMED_UNMATCHED', 'TON_UNMATCHED_RESOLVED', unmatchedProof],
] as const satisfies readonly (readonly [TonTransferStatus, string, unknown])[];

const refundIn = (tx: Tx, order: { id: string; userId: string }) =>
  tx.ledgerEntry.create({
    data: {
      userId: order.userId,
      kind: 'REFUND',
      amountTiyin: PRICE,
      refType: 'ORDER',
      refId: order.id,
    },
  });

describe.each(REVIEW_ONLY)(
  'a %s transfer: the exception is only the review resolution',
  (status, proofKind, build) => {
    it('PROCESSING -> FAILED is refused: no review, no way out (audit R2a, R2a2, review P2)', async () => {
      const { order } = await paidOrder('PROCESSING');
      const attempt = await forceAttempt(order.id, 'FAILED');
      await forceTransfer(attempt.id, status);
      await expectGuard(
        db.order.update({
          where: { id: order.id },
          data: { status: 'FAILED', statusReason: 'ADAPTER_ERROR' },
        }),
        'may have gone out',
      );
      expect(await statusOf(order.id)).toBe('PROCESSING');
    });

    it('PROCESSING -> HELD and HELD -> CANCELLED are refused', async () => {
      for (const [from, to] of [
        ['PROCESSING', 'HELD'],
        ['HELD', 'CANCELLED'],
      ] as const) {
        const { order } = await paidOrder(from);
        const attempt = await forceAttempt(order.id, 'FAILED');
        await forceTransfer(attempt.id, status);
        await expectGuard(
          db.order.update({ where: { id: order.id }, data: { status: to } }),
          'may have gone out',
        );
      }
    });

    it('the attempt can be closed FAILED only while the order is NEEDS_REVIEW (attempt guard)', async () => {
      const processing = await paidOrder('PROCESSING');
      const live = await forceAttempt(processing.order.id, 'UNKNOWN');
      await forceTransfer(live.id, status);
      await expectGuard(
        db.fulfillmentAttempt.update({ where: { id: live.id }, data: { status: 'FAILED' } }),
        'cannot fail while its TON transfer is not EXPIRED',
      );
      const review = await reviewOrder(status);
      const closed = await moveAttempt(review.attempt.id, 'FAILED');
      expect(closed.status).toBe('FAILED');
    });

    it('NEEDS_REVIEW -> FAILED and FAILED -> REFUNDED pass the guard, and commit only with the owner proof row', async () => {
      const { order, attempt, transfer } = await reviewOrder(status);
      await moveAttempt(attempt.id, 'FAILED');
      // Without any resolution audit row the COMMIT is refused (Order_review_audit_check) ...
      await expectGuard(
        db.order.update({
          where: { id: order.id },
          data: { status: 'FAILED', statusReason: 'CONFIRM_TIMEOUT' },
        }),
        'left NEEDS_REVIEW without its ORDER_REVIEW_RESOLVE audit row',
      );
      // ... a row that only names the kind and the transfer is not the proof that fits it (I-1) ...
      // (A commit-time failure of an interactive transaction carries the message, not the SQLSTATE.)
      await expect(
        db.$transaction(async (tx) => {
          await tx.auditLog.create({
            data: resolveAuditData(order.id, { kind: proofKind, transferId: transfer.id }),
          });
          await tx.order.update({ where: { id: order.id }, data: { status: 'FAILED' } });
        }),
      ).rejects.toThrow(
        `has a ${status} transfer without the owner-only review proof that fits it`,
      );
      // ... the full one commits.
      await db.$transaction(async (tx) => {
        await tx.auditLog.create({ data: resolveAuditData(order.id, build(transfer)) });
        await tx.order.update({ where: { id: order.id }, data: { status: 'FAILED' } });
      });
      expect(await statusOf(order.id)).toBe('FAILED');
      await db.$transaction(async (tx) => {
        await tx.order.update({ where: { id: order.id }, data: { status: 'REFUNDED' } });
        await refundIn(tx, order);
      });
      expect(await statusOf(order.id)).toBe('REFUNDED');
    });

    it('a live attempt still blocks NEEDS_REVIEW -> FAILED: the attempt must be closed first', async () => {
      const { order } = await reviewOrder(status, 'UNKNOWN');
      await expectGuard(
        db.order.update({
          where: { id: order.id },
          data: { status: 'FAILED', statusReason: 'CONFIRM_TIMEOUT' },
        }),
        'may have gone out',
      );
    });

    it('R2f: a NEEDS_REVIEW or resolved order takes no new attempt and no new transfer (the INSERT guards want PROCESSING)', async () => {
      const { order, attempt, transfer } = await reviewOrder(status);
      await expectGuard(addAttempt(order.id, 'SENDING', { attemptNo: 2 }), 'PROCESSING');
      await expectGuard(
        addTransfer(attempt.id, 'SIGNED', { seqno: 99 }),
        'can only be signed for an order that is PROCESSING',
      );
      await moveAttempt(attempt.id, 'FAILED');
      await db.$transaction(async (tx) => {
        await tx.auditLog.create({ data: resolveAuditData(order.id, build(transfer)) });
        await tx.order.update({ where: { id: order.id }, data: { status: 'FAILED' } });
      });
      await expectGuard(addAttempt(order.id, 'SENDING', { attemptNo: 2 }), 'PROCESSING');
    });
  },
);

describe('REFUNDED is checked like FAILED: a payout that shows up between the two stops the refund (N1, N4)', () => {
  const refundTx = (order: { id: string; userId: string }) =>
    db.$transaction(async (tx) => {
      await tx.order.update({ where: { id: order.id }, data: { status: 'REFUNDED' } });
      await refundIn(tx, order);
    });

  it('N1: a late attempt on a FAILED order (forced in) stops the refund', async () => {
    const { order } = await paidOrder('FAILED');
    await forceAttempt(order.id, 'SENDING');
    await expectGuard(refundTx(order), 'may have gone out');
    expect(await statusOf(order.id)).toBe('FAILED');
  });

  it('N4: a transfer that was EXPIRED when the order failed and is found CONFIRMED later stops the refund', async () => {
    const { order } = await paidOrder('PROCESSING');
    const attempt = await addAttempt(order.id, 'SENDING');
    const transfer = await addTransfer(attempt.id, 'EXPIRED');
    await moveAttempt(attempt.id, 'FAILED');
    await db.order.update({
      where: { id: order.id },
      data: { status: 'FAILED', statusReason: 'CONFIRM_TIMEOUT' },
    });
    await moveTransfer(transfer.id, 'CONFIRMED');
    await expectGuard(refundTx(order), 'may have gone out');
    expect(await statusOf(order.id)).toBe('FAILED');
  });
});

describe('DELIVERED -> REFUNDED (audit Y1, L5, Q4)', () => {
  const refundTx = (order: { id: string; userId: string }) =>
    db.$transaction(async (tx) => {
      await tx.order.update({ where: { id: order.id }, data: { status: 'REFUNDED' } });
      await refundIn(tx, order);
    });

  it('an admin may refund a DELIVERED order: its CONFIRMED attempt and transfer are not a "not sent" claim', async () => {
    const { order } = await paidOrder('PROCESSING');
    const attempt = await addAttempt(order.id, 'SENDING');
    await addTransfer(attempt.id, 'CONFIRMED');
    await db.$transaction(async (tx) => {
      await tx.fulfillmentAttempt.update({
        where: { id: attempt.id },
        data: { status: 'CONFIRMED' },
      });
      await tx.order.update({ where: { id: order.id }, data: { status: 'DELIVERED' } });
    });
    await refundTx(order);
    expect(await statusOf(order.id)).toBe('REFUNDED');
  });

  it.each(['SENDING', 'SENT', 'UNKNOWN'] as const)(
    'a %s attempt stops the refund of a DELIVERED order (built by bypassing the guards: the DB would not deliver it)',
    async (status) => {
      const { order } = await paidOrder('PROCESSING');
      await forceAttempt(order.id, status);
      await bypassingGuards((tx) =>
        tx.order.update({
          where: { id: order.id },
          data: { status: 'DELIVERED', deliveredAt: new Date() },
        }),
      );
      await expectGuard(refundTx(order), 'unresolved or bounced');
      expect(await statusOf(order.id)).toBe('DELIVERED');
    },
  );

  it.each(['SIGNED', 'BROADCAST', 'CONSUMED_UNMATCHED', 'BOUNCED'] as const)(
    'a %s transfer stops the refund of a DELIVERED order (Q4: refunded and paid out)',
    async (status) => {
      const { order } = await paidOrder('DELIVERED');
      const attempt = await forceAttempt(order.id, 'FAILED', { attemptNo: 2 });
      await forceTransfer(attempt.id, status);
      await expectGuard(refundTx(order), 'unresolved or bounced');
      expect(await statusOf(order.id)).toBe('DELIVERED');
    },
  );

  it('an EXPIRED transfer does not stop it', async () => {
    const { order } = await paidOrder('DELIVERED');
    const attempt = await forceAttempt(order.id, 'FAILED', { attemptNo: 2 });
    await forceTransfer(attempt.id, 'EXPIRED');
    await refundTx(order);
    expect(await statusOf(order.id)).toBe('REFUNDED');
  });
});

describe('ONCHAIN_FAILED in the database (audit R2a, I4)', () => {
  it('R2a: a made-up ONCHAIN_FAILED on a PROCESSING order opens no door: attempt, order and refund all refuse', async () => {
    const { order } = await paidOrder('PROCESSING');
    const attempt = await addAttempt(order.id, 'SENDING');
    const transfer = await addTransfer(attempt.id, 'BROADCAST');
    await db.tonTransfer.update({
      where: { id: transfer.id },
      data: { status: 'ONCHAIN_FAILED', txHash: uniqueHash(), txLt: 1n },
    });
    await expectGuard(
      db.fulfillmentAttempt.update({ where: { id: attempt.id }, data: { status: 'FAILED' } }),
      'cannot fail while its TON transfer is not EXPIRED',
    );
    await expectGuard(
      db.order.update({
        where: { id: order.id },
        data: { status: 'FAILED', statusReason: 'ADAPTER_ERROR' },
      }),
      'may have gone out',
    );
    expect(await statusOf(order.id)).toBe('PROCESSING');
  });

  it('a made-up CONSUMED_UNMATCHED -> ONCHAIN_FAILED is no way round the unmatched seqno (R2a2)', async () => {
    const { order } = await paidOrder('PROCESSING');
    const attempt = await addAttempt(order.id, 'SENDING');
    const transfer = await addTransfer(attempt.id, 'CONSUMED_UNMATCHED');
    await expectGuard(
      db.tonTransfer.update({
        where: { id: transfer.id },
        data: { status: 'ONCHAIN_FAILED', txHash: uniqueHash(), txLt: 3n },
      }),
      'is not allowed',
    );
  });

  it('ONCHAIN_FAILED needs both our transaction hash and its logical time, and the time cannot be added later (I4)', async () => {
    const { order } = await paidOrder('PROCESSING');
    const attempt = await addAttempt(order.id, 'SENDING');
    const transfer = await addTransfer(attempt.id, 'BROADCAST');
    await expectCheck(
      db.tonTransfer.update({
        where: { id: transfer.id },
        data: { status: 'ONCHAIN_FAILED', txHash: uniqueHash() },
      }),
      'TonTransfer_chain_lt_check',
    );
    await expectCheck(
      db.tonTransfer.update({
        where: { id: transfer.id },
        data: { status: 'ONCHAIN_FAILED', txLt: 4n },
      }),
      'TonTransfer_chain_tx_check',
    );
  });
});
