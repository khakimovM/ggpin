import { describe, expect, it } from 'vitest';
import { DeliveryNotProvenError, ReviewProofError, transitionOrder } from '../src/index';
import type { TonTransferStatus } from '../src/index';
import { db } from './client';
import { expectGuard } from './check-helpers';
import { createOrder, createUser } from './factories';
import {
  OPERATOR,
  addAttempt,
  addTransfer,
  captureError,
  forceAttempt,
  forceTransfer,
  manualProof,
  paidOrder,
  resolveAuditData,
  statusOf,
} from './order-fixtures';
import { resolve } from './order-resolve';

// Audit Y1, L5 (review P1, P1b, auditor Q4), Y11: DELIVERED means a confirmed payout. The SQL
// guard of `Order` and `transitionOrder` agree: at least one CONFIRMED attempt, no attempt that
// still waits for its outcome, every transfer CONFIRMED, EXPIRED or ONCHAIN_FAILED.

const REFUSED = 'is refused: it needs a CONFIRMED attempt';
const deliver = (orderId: string) =>
  db.order.update({ where: { id: orderId }, data: { status: 'DELIVERED' } });
const viaHelper = (orderId: string) =>
  db.$transaction((tx) =>
    transitionOrder(tx, { orderId, from: 'PROCESSING', to: 'DELIVERED', actor: 'system' }),
  );

/** A PROCESSING order whose first attempt failed, so a second (CONFIRMED or live) may follow. */
async function processingWithFailedFirst() {
  const base = await paidOrder('PROCESSING');
  await forceAttempt(base.order.id, 'FAILED');
  return base;
}

describe('the SQL guard: PROCESSING -> DELIVERED needs a confirmed payout', () => {
  it('P1: a SENDING attempt with a SIGNED transfer cannot be delivered', async () => {
    const { order } = await paidOrder('PROCESSING');
    const attempt = await addAttempt(order.id, 'SENDING');
    await addTransfer(attempt.id, 'SIGNED');
    await expectGuard(deliver(order.id), REFUSED);
    expect(await statusOf(order.id)).toBe('PROCESSING');
  });

  it('no attempt at all cannot be delivered', async () => {
    const { order } = await paidOrder('PROCESSING');
    await expectGuard(deliver(order.id), REFUSED);
  });

  it.each(['SENDING', 'SENT', 'UNKNOWN'] as const)(
    'a %s attempt, not confirmed, cannot be delivered',
    async (status) => {
      const { order } = await paidOrder('PROCESSING');
      await addAttempt(order.id, status);
      await expectGuard(deliver(order.id), REFUSED);
    },
  );

  it('a FAILED attempt alone cannot be delivered', async () => {
    const { order } = await paidOrder('PROCESSING');
    await forceAttempt(order.id, 'FAILED');
    await expectGuard(deliver(order.id), REFUSED);
  });

  it.each(['SIGNED', 'BROADCAST', 'CONSUMED_UNMATCHED', 'BOUNCED'] as const)(
    'a CONFIRMED attempt does not help while a transfer of the order is %s',
    async (status) => {
      const { order } = await processingWithFailedFirst();
      const failed = await db.fulfillmentAttempt.findFirstOrThrow({ where: { orderId: order.id } });
      await forceTransfer(failed.id, status);
      await forceAttempt(order.id, 'CONFIRMED', { attemptNo: 2 });
      await expectGuard(deliver(order.id), REFUSED);
      expect(await statusOf(order.id)).toBe('PROCESSING');
    },
  );

  it.each([
    'CONFIRMED',
    'EXPIRED',
    'ONCHAIN_FAILED',
  ] as const satisfies readonly TonTransferStatus[])(
    'a CONFIRMED attempt with a %s transfer is delivered, and deliveredAt is the database clock (Y11)',
    async (status) => {
      const { order } = await processingWithFailedFirst();
      const failed = await db.fulfillmentAttempt.findFirstOrThrow({ where: { orderId: order.id } });
      await forceTransfer(failed.id, status);
      await forceAttempt(order.id, 'CONFIRMED', { attemptNo: 2 });
      const before = Date.now();
      // A caller-supplied delivery time is overwritten: it cannot be backdated.
      const delivered = await db.order.update({
        where: { id: order.id },
        data: { status: 'DELIVERED', deliveredAt: new Date('2020-01-01T00:00:00.000Z') },
      });
      expect(delivered.deliveredAt).not.toBeNull();
      expect(Math.abs((delivered.deliveredAt?.getTime() ?? 0) - before)).toBeLessThan(60_000);
    },
  );

  it('NEEDS_REVIEW -> DELIVERED is judged the same way (the review path must close its attempts first)', async () => {
    const { order } = await paidOrder('NEEDS_REVIEW');
    const attempt = await forceAttempt(order.id, 'UNKNOWN');
    await expectGuard(deliver(order.id), REFUSED);
    // Leaving NEEDS_REVIEW also needs the audit row of the resolution, at COMMIT; the attempt is
    // confirmed in the same transaction as the delivery (D-59 N1).
    await db.$transaction(async (tx) => {
      await tx.fulfillmentAttempt.update({
        where: { id: attempt.id },
        data: { status: 'CONFIRMED' },
      });
      await tx.auditLog.create({ data: resolveAuditData(order.id, { kind: 'MANUAL' }) });
      await tx.order.update({ where: { id: order.id }, data: { status: 'DELIVERED' } });
    });
    expect(await statusOf(order.id)).toBe('DELIVERED');
  });
});

describe('transitionOrder: the same rule, under the order lock (review P1b)', () => {
  it('SENDING attempt + SIGNED transfer: DeliveryNotProvenError, nothing written', async () => {
    const { order } = await paidOrder('PROCESSING');
    const attempt = await addAttempt(order.id, 'SENDING');
    await addTransfer(attempt.id, 'SIGNED');
    const error = await captureError(viaHelper(order.id));
    expect(error).toBeInstanceOf(DeliveryNotProvenError);
    expect(await statusOf(order.id)).toBe('PROCESSING');
    expect(await db.orderEvent.count({ where: { orderId: order.id } })).toBe(0);
  });

  it('no attempt, an unresolved attempt, a bounced transfer: all refused with a reason', async () => {
    const none = await paidOrder('PROCESSING');
    expect(await captureError(viaHelper(none.order.id))).toMatchObject({
      detail: 'no attempt is CONFIRMED',
    });
    const waiting = await paidOrder('PROCESSING');
    await addAttempt(waiting.order.id, 'UNKNOWN');
    expect(await captureError(viaHelper(waiting.order.id))).toMatchObject({
      detail: 'attempt is UNKNOWN',
    });
    const bounced = await processingWithFailedFirst();
    const failed = await db.fulfillmentAttempt.findFirstOrThrow({
      where: { orderId: bounced.order.id },
    });
    await forceTransfer(failed.id, 'BOUNCED');
    await forceAttempt(bounced.order.id, 'CONFIRMED', { attemptNo: 2 });
    expect(await captureError(viaHelper(bounced.order.id))).toMatchObject({
      detail: 'transfer is BOUNCED',
    });
  });

  it('a CONFIRMED attempt with a CONFIRMED transfer delivers; the database stamps deliveredAt', async () => {
    const { order } = await paidOrder('PROCESSING');
    const attempt = await addAttempt(order.id, 'SENDING');
    await addTransfer(attempt.id, 'CONFIRMED');
    await db.$transaction(async (tx) => {
      await tx.fulfillmentAttempt.update({
        where: { id: attempt.id },
        data: { status: 'CONFIRMED' },
      });
      await transitionOrder(tx, {
        orderId: order.id,
        from: 'PROCESSING',
        to: 'DELIVERED',
        actor: 'system',
      });
    });
    const row = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.status).toBe('DELIVERED');
    expect(row.deliveredAt).not.toBeNull();
    expect(await db.orderEvent.count({ where: { orderId: order.id } })).toBe(1);
  });
});

describe('resolveNeedsReview: MANUAL -> DELIVERED closes the attempt as CONFIRMED, or is refused', () => {
  it('an order with no attempt at all cannot be delivered by evidence (MISMATCH)', async () => {
    const { order } = await paidOrder('NEEDS_REVIEW');
    await db.order.update({ where: { id: order.id }, data: { statusReason: 'CONFIRM_TIMEOUT' } });
    const error = await captureError(
      resolve({ orderId: order.id, to: 'DELIVERED', proof: manualProof, resolver: OPERATOR }),
    );
    expect(error).toBeInstanceOf(ReviewProofError);
    expect((error as ReviewProofError).problem).toBe('MISMATCH');
    expect(await statusOf(order.id)).toBe('NEEDS_REVIEW');
  });

  it('the unresolved attempt is closed CONFIRMED in the same transaction as DELIVERED', async () => {
    const { order } = await paidOrder('PROCESSING');
    const attempt = await addAttempt(order.id, 'SENDING');
    await db.order.update({
      where: { id: order.id },
      data: { status: 'NEEDS_REVIEW', statusReason: 'CONFIRM_TIMEOUT' },
    });
    await resolve({ orderId: order.id, to: 'DELIVERED', proof: manualProof, resolver: OPERATOR });
    expect(await statusOf(order.id)).toBe('DELIVERED');
    expect(
      (await db.fulfillmentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status,
    ).toBe('CONFIRMED');
  });
});

describe('Z1 (probe Q1): deliveredAt is set by the move to DELIVERED and never changes', () => {
  const ROW = 'deliveredAt is set only by the move to DELIVERED and never changes';

  it('an order is created without a delivery time, and its creation time is the database clock (review 5 #1)', async () => {
    const user = await createUser();
    await expectGuard(
      createOrder(user, undefined, { deliveredAt: new Date('2020-01-01T00:00:00.000Z') }),
      'is created without deliveredAt',
    );
    const backdated = await createOrder(user, undefined, {
      createdAt: new Date('2020-01-01T00:00:00.000Z'),
    });
    expect(backdated.deliveredAt).toBeNull();
    expect(Math.abs(backdated.createdAt.getTime() - Date.now())).toBeLessThan(10 * 60_000);
  });

  it('a DELIVERED order cannot get another delivery time, nor none', async () => {
    const { order } = await paidOrder('DELIVERED');
    const before = (await db.order.findUniqueOrThrow({ where: { id: order.id } })).deliveredAt;
    for (const deliveredAt of [new Date('2020-01-01T00:00:00.000Z'), new Date(), null]) {
      await expectGuard(db.order.update({ where: { id: order.id }, data: { deliveredAt } }), ROW);
    }
    // Writing the very value it has, or any other column, is not a change.
    await db.order.update({ where: { id: order.id }, data: { deliveredAt: before } });
    await db.order.update({ where: { id: order.id }, data: { statusReason: null } });
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).deliveredAt).toEqual(
      before,
    );
  });

  it.each(['PAID', 'QUEUED', 'PROCESSING', 'HELD', 'NEEDS_REVIEW', 'FAILED'] as const)(
    'an order that is %s cannot be given a delivery time',
    async (status) => {
      const { order } = await paidOrder(status);
      await expectGuard(
        db.order.update({ where: { id: order.id }, data: { deliveredAt: new Date() } }),
        ROW,
      );
    },
  );

  it('DELIVERED -> REFUNDED keeps the delivery time: changing it or clearing it is refused, leaving it passes', async () => {
    const refund = (
      order: { id: string; userId: string; priceTiyin: bigint },
      deliveredAt?: Date | null,
    ) =>
      db.$transaction(async (tx) => {
        await tx.order.update({
          where: { id: order.id },
          data: { status: 'REFUNDED', ...(deliveredAt === undefined ? {} : { deliveredAt }) },
        });
        await tx.ledgerEntry.create({
          data: {
            userId: order.userId,
            kind: 'REFUND',
            amountTiyin: order.priceTiyin,
            refType: 'ORDER',
            refId: order.id,
          },
        });
      });
    const { order } = await paidOrder('DELIVERED');
    await expect(refund(order, null)).rejects.toThrow(ROW);
    await expect(refund(order, new Date('2020-01-01T00:00:00.000Z'))).rejects.toThrow(ROW);
    const kept = (await db.order.findUniqueOrThrow({ where: { id: order.id } })).deliveredAt;
    await refund(order);
    const row = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.status).toBe('REFUNDED');
    expect(row.deliveredAt).toEqual(kept);
  });
});
