import { describe, expect, it } from 'vitest';
import { expectGuard } from './check-helpers';
import { db } from './client';
import { createOrder, createQuote, createUser } from './factories';
import { PRICE, addAttempt, forceAttempt, orderIn, paidOrder, statusOf } from './order-fixtures';

// Review R4: the two exits that move money or decide an unknown outcome leave their trace in the
// same transaction, checked at COMMIT (deferred constraint triggers). Audit N5: the guard functions
// run with a pinned search_path. Owner decision R3: `providerRef` is fixed at creation.

const refundEntry = (orderId: string, userId: string, kind: 'REFUND' | 'ADJUSTMENT' = 'REFUND') =>
  db.ledgerEntry.create({
    data: { userId, kind, amountTiyin: PRICE, refType: 'ORDER', refId: orderId },
  });

describe('REFUNDED needs its REFUND ledger entry at commit (R4)', () => {
  it('a raw FAILED -> REFUNDED with no ledger entry cannot commit', async () => {
    const { order } = await paidOrder('FAILED');
    await expectGuard(
      db.order.update({ where: { id: order.id }, data: { status: 'REFUNDED' } }),
      'REFUNDED without its REFUND ledger entry',
    );
    expect(await statusOf(order.id)).toBe('FAILED');
  });

  it('with the entry in the same transaction, in either order, it commits', async () => {
    const first = await paidOrder('FAILED');
    await db.$transaction(async (tx) => {
      await tx.order.update({ where: { id: first.order.id }, data: { status: 'REFUNDED' } });
      await tx.ledgerEntry.create({
        data: {
          userId: first.user.id,
          kind: 'REFUND',
          amountTiyin: PRICE,
          refType: 'ORDER',
          refId: first.order.id,
        },
      });
    });
    const second = await paidOrder('FAILED');
    await db.$transaction(async (tx) => {
      await tx.ledgerEntry.create({
        data: {
          userId: second.user.id,
          kind: 'REFUND',
          amountTiyin: PRICE,
          refType: 'ORDER',
          refId: second.order.id,
        },
      });
      await tx.order.update({ where: { id: second.order.id }, data: { status: 'REFUNDED' } });
    });
    expect(await statusOf(first.order.id)).toBe('REFUNDED');
    expect(await statusOf(second.order.id)).toBe('REFUNDED');
  });

  it("another order's entry, or an entry of another kind, does not count", async () => {
    const mine = await paidOrder('FAILED');
    const theirs = await paidOrder('FAILED');
    await db.ledgerEntry.create({
      data: {
        userId: theirs.user.id,
        kind: 'REFUND',
        amountTiyin: PRICE,
        refType: 'ORDER',
        refId: theirs.order.id,
      },
    });
    await expectGuard(
      db.order.update({ where: { id: mine.order.id }, data: { status: 'REFUNDED' } }),
      'REFUNDED without',
    );
    await refundEntry(mine.order.id, mine.user.id, 'ADJUSTMENT');
    await expectGuard(
      db.order.update({ where: { id: mine.order.id }, data: { status: 'REFUNDED' } }),
      'REFUNDED without',
    );
  });

  it('L6: the entry must be for exactly what the order cost (price - discount) and to its own user', async () => {
    const refundWith = async (order: { id: string }, userId: string, amountTiyin: bigint) =>
      db.$transaction(async (tx) => {
        await tx.order.update({ where: { id: order.id }, data: { status: 'REFUNDED' } });
        await tx.ledgerEntry.create({
          data: { userId, kind: 'REFUND', amountTiyin, refType: 'ORDER', refId: order.id },
        });
      });
    const plain = await paidOrder('FAILED');
    const stranger = await paidOrder('FAILED');
    for (const [userId, amount, label] of [
      [plain.user.id, PRICE * 10n, 'ten times the price'],
      [plain.user.id, PRICE + 1n, 'one tiyin more'],
      [plain.user.id, PRICE - 1n, 'one tiyin less'],
      [stranger.user.id, PRICE, "another user's wallet"],
    ] as const) {
      // A commit-time failure of an interactive transaction carries the message, not the SQLSTATE.
      await expect(refundWith(plain.order, userId, amount)).rejects.toThrow('REFUNDED without');
      expect(await statusOf(plain.order.id), label).toBe('FAILED');
    }
    await refundWith(plain.order, plain.user.id, PRICE);
    expect(await statusOf(plain.order.id)).toBe('REFUNDED');
    // With a discount the refund is price - discount: the full price is too much.
    const discounted = await paidOrder('FAILED', 1_200_000n);
    await expect(refundWith(discounted.order, discounted.user.id, PRICE)).rejects.toThrow(
      'REFUNDED without',
    );
    await refundWith(discounted.order, discounted.user.id, PRICE - 1_200_000n);
    expect(await statusOf(discounted.order.id)).toBe('REFUNDED');
  });

  it('a DELIVERED order refunded by an admin needs the entry too', async () => {
    const { order } = await paidOrder('DELIVERED');
    await expectGuard(
      db.order.update({ where: { id: order.id }, data: { status: 'REFUNDED' } }),
      'REFUNDED without',
    );
  });
});

describe('leaving NEEDS_REVIEW needs the ORDER_REVIEW_RESOLVE audit row at commit (R4)', () => {
  const audit = (orderId: string, action = 'ORDER_REVIEW_RESOLVE', targetType = 'Order') =>
    db.auditLog.create({
      data: { actorType: 'SYSTEM', action, targetType, targetId: orderId },
    });

  it.each(['FAILED', 'DELIVERED'] as const)(
    'a raw NEEDS_REVIEW -> %s with no audit row cannot commit',
    async (to) => {
      const { order } = await paidOrder('NEEDS_REVIEW');
      // DELIVERED is judged by the delivery rule first (audit Y1): give the order its confirmed attempt.
      if (to === 'DELIVERED') await forceAttempt(order.id, 'CONFIRMED');
      await expectGuard(
        db.order.update({
          where: { id: order.id },
          data: {
            status: to,
            ...(to === 'DELIVERED'
              ? { deliveredAt: new Date() }
              : { statusReason: 'ADAPTER_ERROR' }),
          },
        }),
        'without its ORDER_REVIEW_RESOLVE audit row',
      );
      expect(await statusOf(order.id)).toBe('NEEDS_REVIEW');
    },
  );

  it('an audit row of another order, action or target type does not count', async () => {
    const mine = await paidOrder('NEEDS_REVIEW');
    const other = await paidOrder('NEEDS_REVIEW');
    for (const row of [
      () => audit(other.order.id),
      () => audit(mine.order.id, 'ORDER_REFUND'),
      () => audit(mine.order.id, 'ORDER_REVIEW_RESOLVE', 'Payment'),
    ]) {
      await row();
      await expectGuard(
        db.order.update({
          where: { id: mine.order.id },
          data: { status: 'FAILED', statusReason: 'ADAPTER_ERROR' },
        }),
        'without its ORDER_REVIEW_RESOLVE',
      );
    }
  });

  it('with its audit row in the same transaction it commits', async () => {
    const { order } = await paidOrder('NEEDS_REVIEW');
    await forceAttempt(order.id, 'CONFIRMED');
    await db.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { status: 'DELIVERED', deliveredAt: new Date() },
      });
      await tx.auditLog.create({
        data: {
          actorType: 'SYSTEM',
          action: 'ORDER_REVIEW_RESOLVE',
          targetType: 'Order',
          targetId: order.id,
        },
      });
    });
    expect(await statusOf(order.id)).toBe('DELIVERED');
  });

  it('other exits of the machine do not ask for it', async () => {
    const { order } = await paidOrder('PROCESSING');
    await db.order.update({
      where: { id: order.id },
      data: { status: 'HELD', statusReason: 'LOW_BALANCE' },
    });
    expect(await statusOf(order.id)).toBe('HELD');
  });
});

describe('the guard functions run with a pinned search_path (N5)', () => {
  it('every ggpin_* function of the schema carries search_path = public, pg_temp', async () => {
    const rows = await db.$queryRaw<{ proname: string; cfg: string[] | null }[]>`
      SELECT p.proname, p.proconfig AS cfg FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname LIKE 'ggpin%'`;
    // 9 guards of phase 4 and the 12 of this migration.
    expect(rows.length).toBeGreaterThanOrEqual(21);
    for (const row of rows) {
      expect(row.cfg ?? [], row.proname).toContain('search_path=public, pg_temp');
    }
  });

  it('C3t: a TEMP table named like a guarded table does not blind the guard', async () => {
    const { order } = await paidOrder('PROCESSING');
    await addAttempt(order.id, 'UNKNOWN');
    await expectGuard(
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `CREATE TEMP TABLE "FulfillmentAttempt" ("orderId" text, "status" text) ON COMMIT DROP`,
        );
        await tx.$executeRawUnsafe(
          `UPDATE "Order" SET "status" = 'HELD', "statusReason" = 'LOW_BALANCE' WHERE "id" = $1`,
          order.id,
        );
      }),
      'may have gone out',
    );
    expect(await statusOf(order.id)).toBe('PROCESSING');
  });
});

describe('providerRef is fixed when the quote and the order are created (owner decision R3)', () => {
  it('Quote: written at INSERT; an UPDATE to another value, from NULL, or to NULL is refused', async () => {
    const user = await createUser();
    const withRef = await createQuote(user.id, { providerRef: 'tg-user-77' });
    const without = await createQuote(user.id);
    expect(withRef.providerRef).toBe('tg-user-77');
    expect(without.providerRef).toBeNull();
    for (const data of [{ providerRef: 'tg-user-78' }, { providerRef: null }]) {
      await expectGuard(db.quote.update({ where: { id: withRef.id }, data }), 'immutable');
    }
    await expectGuard(
      db.quote.update({ where: { id: without.id }, data: { providerRef: 'tg-user-77' } }),
      'immutable',
    );
    // The same value is not a change, and the rest of the quote still behaves as before.
    await db.quote.update({
      where: { id: withRef.id },
      data: { providerRef: 'tg-user-77', usedAt: new Date() },
    });
  });

  it('Order: copied at creation; an UPDATE to another value, from NULL, or to NULL is refused', async () => {
    const user = await createUser();
    const withRef = await createOrder(user, undefined, { providerRef: 'tg-user-77' });
    const without = await createOrder(user);
    expect(withRef.providerRef).toBe('tg-user-77');
    expect(without.providerRef).toBeNull();
    for (const data of [{ providerRef: 'tg-user-78' }, { providerRef: null }]) {
      await expectGuard(db.order.update({ where: { id: withRef.id }, data }), 'immutable');
    }
    await expectGuard(
      db.order.update({ where: { id: without.id }, data: { providerRef: 'tg-user-77' } }),
      'immutable',
    );
    await db.order.update({ where: { id: withRef.id }, data: { providerRef: 'tg-user-77' } });
    expect((await orderIn(user, 'QUEUED', { providerRef: 'x' })).providerRef).toBe('x');
  });
});
