import { describe, expect, it } from 'vitest';
import { sumBalance } from '../src/index';
import { db } from './client';
import { expectRefused } from './needs-review-expect';
import {
  OPERATOR,
  PRICE,
  addAttempt,
  addTransfer,
  bouncedProof,
  bypassingGuards,
  moveAttempt,
  paidOrder,
  refunds,
  reviewOrder,
  statusOf,
  tonTxProof,
} from './order-fixtures';
import { resolve } from './order-resolve';

// D-59 N1 (owner decision B), the way out of a late bounce: the transfer was CONFIRMED, the attempt
// is still SENT (an attempt is CONFIRMED only together with the delivery), and the bounce is found
// before the order is delivered. The owner's TON_BOUNCED proof settles it, from PROCESSING through
// NEEDS_REVIEW as well as from NEEDS_REVIEW itself. (Before this decision the CONFIRMED attempt left
// no exit at all: auditor probes STUCK and STUCK-P.)

describe('a bounce found late settles through TON_BOUNCED', () => {
  it('(b) PROCESSING: attempt SENT, transfer CONFIRMED -> BOUNCED, the order goes NEEDS_REVIEW, the owner refunds', async () => {
    const { user, order } = await paidOrder('PROCESSING');
    const attempt = await addAttempt(order.id, 'SENDING');
    const transfer = await addTransfer(attempt.id, 'CONFIRMED');
    await moveAttempt(attempt.id, 'SENT');
    // The classifier finds the bounce while the order is still PROCESSING ...
    const bounced = await db.tonTransfer.update({
      where: { id: transfer.id },
      data: { status: 'BOUNCED' },
    });
    // ... the delivery cannot be confirmed (DB and helper), the order is held for review ...
    await db.order.update({
      where: { id: order.id },
      data: { status: 'NEEDS_REVIEW', statusReason: 'CONFIRM_TIMEOUT' },
    });
    // ... and the owner settles it.
    const result = await resolve({
      orderId: order.id,
      to: 'FAILED',
      proof: bouncedProof(bounced),
      resolver: OPERATOR,
    });
    expect(result.refund).toMatchObject({ outcome: 'REFUNDED', amountTiyin: PRICE });
    expect(await statusOf(order.id)).toBe('REFUNDED');
    expect(await sumBalance(db, user.id)).toBe(0n);
    expect(await refunds(order.id)).toHaveLength(1);
    expect(
      (await db.fulfillmentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status,
    ).toBe('FAILED');
  });

  it("(b') NEEDS_REVIEW already: the bounce is found there, and the same proof refunds", async () => {
    const review = await reviewOrder('CONFIRMED', 'SENT');
    const bounced = await db.tonTransfer.update({
      where: { id: review.transfer.id },
      data: { status: 'BOUNCED' },
    });
    await resolve({
      orderId: review.order.id,
      to: 'FAILED',
      proof: bouncedProof(bounced),
      resolver: OPERATOR,
    });
    expect(await statusOf(review.order.id)).toBe('REFUNDED');
    expect(await sumBalance(db, review.user.id)).toBe(0n);
  });

  it('a delivery proof cannot deliver it: the bounced transfer blocks DELIVERED, whoever carries it', async () => {
    const review = await reviewOrder('CONFIRMED', 'SENT');
    const bounced = await db.tonTransfer.update({
      where: { id: review.transfer.id },
      data: { status: 'BOUNCED' },
    });
    await expectRefused(
      { ...review, transfer: bounced },
      'DELIVERED',
      tonTxProof(bounced),
      OPERATOR,
      'MISMATCH',
      'TON_TX on a bounced transfer',
    );
  });
});

describe('a CONFIRMED attempt in NEEDS_REVIEW cannot exist, and the helper does not trust one that a corrupt database has', () => {
  async function corruptReview() {
    const review = await reviewOrder('CONFIRMED');
    // The database refuses this state at commit; a corrupt or hand-edited one is built by switching
    // its triggers off.
    await bypassingGuards((tx) =>
      tx.fulfillmentAttempt.update({
        where: { id: review.attempt.id },
        data: { status: 'CONFIRMED' },
      }),
    );
    const attempt = await db.fulfillmentAttempt.findUniqueOrThrow({
      where: { id: review.attempt.id },
    });
    return { ...review, attempt };
  }

  it('TON_TX and FRAGMENT_STATUS accept only a live attempt (MISMATCH)', async () => {
    const review = await corruptReview();
    await expectRefused(
      review,
      'DELIVERED',
      tonTxProof(review.transfer),
      OPERATOR,
      'MISMATCH',
      'TON_TX',
    );
    await expectRefused(
      review,
      'DELIVERED',
      {
        kind: 'FRAGMENT_STATUS',
        requestRef: review.attempt.externalRef,
        status: 'DONE',
        observedAt: '2026-11-11T10:06:00.000Z',
        reason: 'Fragment shows the order as completed',
      },
      OPERATOR,
      'MISMATCH',
      'FRAGMENT_STATUS',
    );
  });
});
