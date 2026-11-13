import { describe, expect, it } from 'vitest';
import type { TonTransferStatus } from '../src/index';
import { DeliveryNotProvenError, transitionOrder } from '../src/index';
import { db } from './client';
import { expectGuard } from './check-helpers';
import {
  addAttempt,
  addTransfer,
  captureError,
  moveAttempt,
  paidOrder,
  resolveAuditData,
  statusOf,
} from './order-fixtures';

// D-59 N1 (owner decision B) and Z3: an attempt is CONFIRMED only together with the delivery, and a
// CONFIRMED attempt whose OWN transfer did not pay is the owner's MANUAL word only. The deferred check
// FulfillmentAttempt_confirmed_check runs at COMMIT, in the transaction that confirms the attempt.

const NOT_DELIVERED = 'is CONFIRMED but its order is not DELIVERED';

/** A PROCESSING order whose SENDING attempt (and its own transfer in `transfer`, if any) exists. */
async function processingWith(transfer?: TonTransferStatus) {
  const { order } = await paidOrder('PROCESSING');
  const attempt = await addAttempt(order.id, 'SENDING');
  if (transfer !== undefined) await addTransfer(attempt.id, transfer);
  return { order, attempt };
}

/** Confirms the attempt and delivers the order in ONE transaction, the legal way. */
const confirmAndDeliver = (
  orderId: string,
  attemptId: string,
  before?: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<void>,
) =>
  db.$transaction(async (tx) => {
    if (before !== undefined) await before(tx);
    await tx.fulfillmentAttempt.update({ where: { id: attemptId }, data: { status: 'CONFIRMED' } });
    await tx.order.update({ where: { id: orderId }, data: { status: 'DELIVERED' } });
  });

/**
 * The same, but the order guards are switched off for the DELIVERED write only (the attempt's own
 * deferred check was queued before), so the check of the attempt's own transfer is reached for the
 * states the order guard would refuse first.
 */
const confirmWithDeliveryUnguarded = (orderId: string, attemptId: string) =>
  db.$transaction(async (tx) => {
    await tx.fulfillmentAttempt.update({ where: { id: attemptId }, data: { status: 'CONFIRMED' } });
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
    await tx.order.update({
      where: { id: orderId },
      data: { status: 'DELIVERED', deliveredAt: new Date() },
    });
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'origin'`);
  });

describe('N1: an attempt is CONFIRMED only together with the delivery', () => {
  it.each(['PROCESSING', 'NEEDS_REVIEW'] as const)(
    'confirming the attempt of a %s order alone does not commit (GG001)',
    async (status) => {
      const { order, attempt } = await processingWith();
      if (status === 'NEEDS_REVIEW') {
        await db.order.update({
          where: { id: order.id },
          data: { status, statusReason: 'CONFIRM_TIMEOUT' },
        });
      }
      await expectGuard(moveAttempt(attempt.id, 'CONFIRMED'), NOT_DELIVERED);
      expect(
        (await db.fulfillmentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status,
      ).toBe('SENDING');
      expect(await statusOf(order.id)).toBe(status);
    },
  );

  it('confirming it and delivering the order in one transaction commits, in either statement order', async () => {
    const first = await processingWith('CONFIRMED');
    await confirmAndDeliver(first.order.id, first.attempt.id);
    expect(await statusOf(first.order.id)).toBe('DELIVERED');
    // Order first, attempt second: the order guard wants the attempt CONFIRMED already, so the
    // attempt is confirmed in an earlier statement of the same transaction, then the order moves.
    const second = await processingWith();
    await db.$transaction(async (tx) => {
      await tx.fulfillmentAttempt.update({
        where: { id: second.attempt.id },
        data: { status: 'CONFIRMED' },
      });
      await tx.order.update({ where: { id: second.order.id }, data: { status: 'DELIVERED' } });
    });
    expect(await statusOf(second.order.id)).toBe('DELIVERED');
  });

  it('a delivered order refunded by an admin keeps its CONFIRMED attempt: the check does not fire again', async () => {
    const { order, attempt } = await processingWith('CONFIRMED');
    await confirmAndDeliver(order.id, attempt.id);
    await db.$transaction(async (tx) => {
      await tx.order.update({ where: { id: order.id }, data: { status: 'REFUNDED' } });
      await tx.ledgerEntry.create({
        data: {
          userId: order.userId,
          kind: 'REFUND',
          amountTiyin: order.priceTiyin - order.discountTiyin,
          refType: 'ORDER',
          refId: order.id,
        },
      });
    });
    expect(await statusOf(order.id)).toBe('REFUNDED');
    expect(
      (await db.fulfillmentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status,
    ).toBe('CONFIRMED');
  });
});

describe("Z3: the attempt's OWN transfer decides whether it may be CONFIRMED", () => {
  it('no transfer (a supplier attempt) or a CONFIRMED one: fine', async () => {
    const none = await processingWith();
    await confirmAndDeliver(none.order.id, none.attempt.id);
    const paid = await processingWith('CONFIRMED');
    await confirmAndDeliver(paid.order.id, paid.attempt.id);
    expect(await statusOf(none.order.id)).toBe('DELIVERED');
    expect(await statusOf(paid.order.id)).toBe('DELIVERED');
  });

  it.each(['SIGNED', 'BROADCAST', 'CONSUMED_UNMATCHED', 'BOUNCED'] as const)(
    'a %s own transfer: never, with any audit row (Q3b, order guard switched off)',
    async (status) => {
      const { order, attempt } = await processingWith(status);
      await db.auditLog.create({
        data: resolveAuditData(order.id, { kind: 'MANUAL', evidence: 'x', reason: 'y' }),
      });
      await expect(confirmWithDeliveryUnguarded(order.id, attempt.id)).rejects.toThrow(
        `cannot be CONFIRMED beside its ${status} TON transfer`,
      );
      expect(await statusOf(order.id)).toBe('PROCESSING');
    },
  );

  it.each(['EXPIRED', 'ONCHAIN_FAILED'] as const)(
    'a %s own transfer: refused without the owner MANUAL proof, accepted with it (Q3, Q3b)',
    async (status) => {
      const { order, attempt } = await processingWith(status);
      const refused = 'without the owner MANUAL proof';
      // Raw path, no audit row at all.
      await expect(confirmAndDeliver(order.id, attempt.id)).rejects.toThrow(refused);
      // An audit row that is not the owner's MANUAL proof does not count.
      const manual = { kind: 'MANUAL', evidence: 'receipt', reason: 'owner delivered by hand' };
      const wrong: [string, Parameters<typeof resolveAuditData>[2]][] = [
        ['no otp', { otpVerified: false }],
        ['a SUPPORT role', { role: 'SUPPORT' }],
      ];
      for (const [label, options] of wrong) {
        await expect(
          confirmAndDeliver(order.id, attempt.id, async (tx) => {
            await tx.auditLog.create({ data: resolveAuditData(order.id, manual, options) });
          }),
          label,
        ).rejects.toThrow(refused);
      }
      await expect(
        confirmAndDeliver(order.id, attempt.id, async (tx) => {
          await tx.auditLog.create({
            data: resolveAuditData(order.id, { kind: 'TON_TX', reason: 'y' }),
          });
        }),
      ).rejects.toThrow(refused);
      expect(await statusOf(order.id)).toBe('PROCESSING');
      // The owner's MANUAL proof in the same transaction: accepted.
      await confirmAndDeliver(order.id, attempt.id, async (tx) => {
        await tx.auditLog.create({ data: resolveAuditData(order.id, manual) });
      });
      expect(await statusOf(order.id)).toBe('DELIVERED');
    },
  );

  it('the helper reaches the same verdict as the database (transitionOrder, no MANUAL proof)', async () => {
    for (const status of ['EXPIRED', 'ONCHAIN_FAILED'] as const) {
      const { order, attempt } = await processingWith(status);
      const error = await captureError(
        db.$transaction(async (tx) => {
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
        }),
      );
      expect(error, status).toBeInstanceOf(DeliveryNotProvenError);
      expect((error as DeliveryNotProvenError).detail).toContain(`own transfer is ${status}`);
      expect(await statusOf(order.id)).toBe('PROCESSING');
    }
  });
});
