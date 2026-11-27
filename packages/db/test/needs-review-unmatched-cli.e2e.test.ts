import { describe, expect, it } from 'vitest';
import { sumBalance } from '../src/index';
import { db } from './client';
import { expectPrismaCode } from './check-helpers';
import { expectRefused } from './needs-review-expect';
import {
  OPERATOR,
  PRICE,
  adminResolver,
  createAdmin,
  moveAttempt,
  resolveAuditData,
  reviewOrder,
  statusOf,
  uniqueHash,
  unmatchedProof,
} from './order-fixtures';
import { resolve } from './order-resolve';

// D-59 A3, audit Z2 and Z5: TON_UNMATCHED_RESOLVED comes only from the owner's CLI, and one finding
// (the unknown transaction that consumed the seqno) pays one refund.

describe('Z2: TON_UNMATCHED_RESOLVED is the owner CLI only', () => {
  it('an ADMIN session is refused (ACTOR_MISMATCH) even as an active OWNER with the OTP', async () => {
    const admin = await createAdmin('OWNER');
    const review = await reviewOrder('CONSUMED_UNMATCHED');
    await expectRefused(
      review,
      'FAILED',
      unmatchedProof(review.transfer),
      adminResolver(admin.id),
      'ACTOR_MISMATCH',
      'admin owner',
    );
  });

  it('the CLI passes', async () => {
    const review = await reviewOrder('CONSUMED_UNMATCHED');
    await resolve({
      orderId: review.order.id,
      to: 'FAILED',
      proof: unmatchedProof(review.transfer),
      resolver: OPERATOR,
    });
    expect(await statusOf(review.order.id)).toBe('REFUNDED');
  });

  it('the database demands it too: a raw audit row of an ADMIN resolver does not commit the FAILED order', async () => {
    const review = await reviewOrder('CONSUMED_UNMATCHED');
    await moveAttempt(review.attempt.id, 'FAILED');
    const proof = unmatchedProof(review.transfer);
    const fails = (type: string, written: Parameters<typeof resolveAuditData>[1] = proof) =>
      db.$transaction(async (tx) => {
        await tx.auditLog.create({
          data: resolveAuditData(review.order.id, written, { type }),
        });
        await tx.order.update({ where: { id: review.order.id }, data: { status: 'FAILED' } });
      });
    const refusal =
      'has a CONSUMED_UNMATCHED transfer without the owner-only review proof that fits it';
    await expect(fails('ADMIN')).rejects.toThrow(refusal);
    // A CLI row that names no consuming transaction is refused as well.
    const { consumingTxHash: _omitted, ...withoutHash } = proof;
    await expect(fails('CLI', withoutHash)).rejects.toThrow(refusal);
    await fails('CLI');
    expect(await statusOf(review.order.id)).toBe('FAILED');
  });
});

describe('Z5: one finding, one refund', () => {
  it('a second order cannot use the same consuming transaction (CONSUMING_TX_REUSED)', async () => {
    const first = await reviewOrder('CONSUMED_UNMATCHED');
    const second = await reviewOrder('CONSUMED_UNMATCHED');
    const consumingTxHash = uniqueHash();
    await resolve({
      orderId: first.order.id,
      to: 'FAILED',
      proof: unmatchedProof(first.transfer, { consumingTxHash }),
      resolver: OPERATOR,
    });
    await expectRefused(
      second,
      'FAILED',
      unmatchedProof(second.transfer, { consumingTxHash }),
      OPERATOR,
      'CONSUMING_TX_REUSED',
      'same consuming tx',
    );
    expect(await sumBalance(db, second.user.id)).toBe(-PRICE);
  });

  it('the database backs that up: two resolution audit rows cannot name the same consuming transaction', async () => {
    const row = (targetId: string, consumingTxHash: string) => ({
      actorType: 'CLI',
      action: 'ORDER_REVIEW_RESOLVE',
      targetType: 'Order',
      targetId,
      after: { proof: { kind: 'TON_UNMATCHED_RESOLVED', consumingTxHash } },
    });
    const hash = uniqueHash();
    await db.auditLog.create({ data: row('order-a', hash) });
    await expectPrismaCode(db.auditLog.create({ data: row('order-b', hash) }), 'P2002');
    await db.auditLog.create({ data: row('order-b', uniqueHash()) });
    await db.auditLog.create({ data: { ...row('order-c', hash), action: 'SOMETHING_ELSE' } });
  });
});
