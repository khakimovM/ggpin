import {
  ORDER_STATUSES,
  ORDER_STATUS_REASONS,
  ORDER_TRANSITIONS,
  type OrderStatus,
} from '@repo/shared';
import { describe, expect, it } from 'vitest';
import type { AttemptStatus, TonTransferStatus } from '../src/index';
import { expectCheck, expectGuard } from './check-helpers';
import { db } from './client';
import { createOrder, createUser } from './factories';
import {
  PRICE,
  addAttempt,
  addTransfer,
  deliverLegally,
  forceAttempt,
  forceTransfer,
  moveAttempt,
  statusOf,
  walkTo,
} from './order-fixtures';

// Audit F4, H2(3), F8: the database knows which Order status edges exist, refuses to fail, hold or
// cancel an order whose payout may have gone out, and keeps the reason list closed. All GG001 / CHECK.

// The union over every actor of ORDER_TRANSITIONS: who may take an edge is application code.
const edgeExists = (from: OrderStatus, to: OrderStatus): boolean =>
  Object.hasOwn(ORDER_TRANSITIONS[from], to);

async function orderIn(status: OrderStatus) {
  const order = await createOrder(await createUser());
  await walkTo(order.id, status);
  return order;
}

/**
 * The move of the pair test, with what the two commit-time checks of R4 want next to it: the REFUND
 * entry for REFUNDED, the audit row for leaving NEEDS_REVIEW. An edge that does not exist still
 * fails on the status UPDATE itself.
 */
function moveOrder(order: { id: string; userId: string }, from: OrderStatus, to: OrderStatus) {
  return db.$transaction(async (tx) => {
    const row = await tx.order.update({
      where: { id: order.id },
      data: { status: to, ...(to === 'DELIVERED' ? { deliveredAt: new Date() } : {}) },
    });
    if (to === 'REFUNDED') {
      await tx.ledgerEntry.create({
        data: {
          userId: order.userId,
          kind: 'REFUND',
          amountTiyin: PRICE,
          refType: 'ORDER',
          refId: order.id,
        },
      });
    }
    if (from === 'NEEDS_REVIEW' && (to === 'FAILED' || to === 'DELIVERED')) {
      await tx.auditLog.create({
        data: {
          actorType: 'SYSTEM',
          action: 'ORDER_REVIEW_RESOLVE',
          targetType: 'Order',
          targetId: order.id,
        },
      });
    }
    return row;
  });
}

describe('an order is born PAID (F4)', () => {
  it.each(ORDER_STATUSES.filter((s) => s !== 'PAID'))(
    'an INSERT as %s is refused (GG001)',
    async (status) => {
      await expectGuard(
        createOrder(await createUser(), undefined, {
          status,
          ...(status === 'DELIVERED' ? { deliveredAt: new Date() } : {}),
        }),
        'is created PAID',
      );
    },
  );

  it('an INSERT as PAID is accepted', async () => {
    const order = await createOrder(await createUser());
    expect(order.status).toBe('PAID');
  });
});

describe('the status edges (every pair, F4)', () => {
  const pairs = ORDER_STATUSES.flatMap((from) =>
    ORDER_STATUSES.filter((to) => to !== from).map((to) => [from, to] as const),
  );

  it.each(pairs)('%s -> %s', async (from, to) => {
    const order = await orderIn(from);
    // DELIVERED means a confirmed payout (audit Y1): the edge into it is judged by the delivery rule
    // (order-delivery-guard.e2e.test.ts), so the pair test gives the order its CONFIRMED attempt.
    if (to === 'DELIVERED' && edgeExists(from, to)) await forceAttempt(order.id, 'CONFIRMED');
    const move = moveOrder(order, from, to);
    if (edgeExists(from, to)) {
      expect((await move).status).toBe(to);
    } else {
      await expectGuard(move, 'is not allowed');
      expect(await statusOf(order.id)).toBe(from);
    }
  });

  it('the SQL function equals ORDER_TRANSITIONS of @repo/shared on every pair (no drift)', async () => {
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        const [row] = await db.$queryRaw<{ ok: boolean }[]>`
          SELECT ggpin_order_edge_allowed(${from}::"OrderStatus", ${to}::"OrderStatus") AS ok`;
        expect(row?.ok, `${from} -> ${to}`).toBe(edgeExists(from, to));
      }
    }
  });

  it('P2: the direct writes of the review are refused: FAILED->REFUNDED is an edge but REFUNDED->PAID is not', async () => {
    const refunded = await orderIn('REFUNDED');
    await expectGuard(
      db.order.update({ where: { id: refunded.id }, data: { status: 'PAID' } }),
      'is not allowed',
    );
    const review = await orderIn('NEEDS_REVIEW');
    // NEEDS_REVIEW -> FAILED is a legal EDGE; who may take it, and with which proof, is application
    // code, but the database does not let it commit without the audit row of the resolution (R4).
    await expectGuard(
      db.order.update({ where: { id: review.id }, data: { status: 'FAILED' } }),
      'without its ORDER_REVIEW_RESOLVE audit row',
    );
    await moveOrder(review, 'NEEDS_REVIEW', 'FAILED');
  });

  it('an update that leaves the status alone is not a transition', async () => {
    const order = await orderIn('HELD');
    await db.order.update({
      where: { id: order.id },
      data: { statusReason: 'LOW_BALANCE', status: 'HELD' },
    });
  });
});

describe('no failing, holding or cancelling while a payout may have gone out (H2 part 3)', () => {
  const ATTEMPTS: readonly AttemptStatus[] = ['SENDING', 'SENT', 'UNKNOWN', 'CONFIRMED'];
  const TRANSFERS: readonly TonTransferStatus[] = ['SIGNED', 'BROADCAST', 'CONFIRMED'];

  it.each(ATTEMPTS)('an order with a %s attempt cannot go FAILED or HELD', async (status) => {
    for (const to of ['FAILED', 'HELD'] as const) {
      const order = await orderIn('PROCESSING');
      // A CONFIRMED attempt of a PROCESSING order is refused at commit (D-59 N1): forced in.
      if (status === 'CONFIRMED') await forceAttempt(order.id, status);
      else await addAttempt(order.id, status);
      await expectGuard(
        db.order.update({ where: { id: order.id }, data: { status: to } }),
        'may have gone out',
      );
      expect(await statusOf(order.id)).toBe('PROCESSING');
    }
  });

  it.each(TRANSFERS)(
    'an order whose attempt failed but whose transfer is %s cannot go FAILED or HELD',
    async (status) => {
      for (const to of ['FAILED', 'HELD'] as const) {
        const order = await orderIn('PROCESSING');
        // A FAILED attempt next to a live transfer is a state the attempt guard refuses: forced.
        const attempt = await forceAttempt(order.id, 'FAILED');
        await forceTransfer(attempt.id, status);
        await expectGuard(
          db.order.update({ where: { id: order.id }, data: { status: to } }),
          'may have gone out',
        );
      }
    },
  );

  it('an order that is only QUEUED or HELD cannot be CANCELLED with a live attempt either', async () => {
    const queued = await orderIn('QUEUED');
    await forceAttempt(queued.id, 'SENDING');
    await expectGuard(
      db.order.update({ where: { id: queued.id }, data: { status: 'CANCELLED' } }),
      'may have gone out',
    );
    const held = await orderIn('HELD');
    await forceAttempt(held.id, 'UNKNOWN');
    await expectGuard(
      db.order.update({ where: { id: held.id }, data: { status: 'CANCELLED' } }),
      'may have gone out',
    );
  });

  it('a provably unsent order can fail, hold and be cancelled (FAILED attempt, EXPIRED transfer, or nothing)', async () => {
    const proven = await orderIn('PROCESSING');
    const attempt = await addAttempt(proven.id, 'SENDING');
    await addTransfer(attempt.id, 'EXPIRED');
    await moveAttempt(attempt.id, 'FAILED');
    await db.order.update({ where: { id: proven.id }, data: { status: 'FAILED' } });
    const bare = await orderIn('PROCESSING');
    await db.order.update({ where: { id: bare.id }, data: { status: 'HELD' } });
    await db.order.update({ where: { id: bare.id }, data: { status: 'CANCELLED' } });
  });

  it('leaving PROCESSING for DELIVERED or NEEDS_REVIEW is exactly when a payout exists: not blocked', async () => {
    const delivering = await orderIn('PROCESSING');
    await deliverLegally(delivering.id);
    const unknown = await orderIn('PROCESSING');
    await addAttempt(unknown.id, 'UNKNOWN');
    await db.order.update({ where: { id: unknown.id }, data: { status: 'NEEDS_REVIEW' } });
  });

  it('every transfer but EXPIRED blocks HELD, failed-on-chain and consumed ones included (audit N1)', async () => {
    // Failed-on-chain is the one exception, and only for FAILED / REFUNDED (owner decision R2, in
    // order-status-guard-onchain.e2e.test.ts); a consumed seqno blocks FAILED as well.
    for (const status of ['ONCHAIN_FAILED', 'CONSUMED_UNMATCHED'] as const) {
      const order = await orderIn('PROCESSING');
      const attempt = await forceAttempt(order.id, 'FAILED');
      await forceTransfer(attempt.id, status);
      await expectGuard(
        db.order.update({ where: { id: order.id }, data: { status: 'HELD' } }),
        'may have gone out',
      );
    }
  });
});

describe('the reason list is closed (F8)', () => {
  it('accepts NULL and every reason of @repo/shared', async () => {
    const order = await orderIn('HELD');
    for (const statusReason of [...ORDER_STATUS_REASONS, null]) {
      await db.order.update({ where: { id: order.id }, data: { statusReason } });
    }
  });

  it('refuses free text, another case, blanks and look-alikes', async () => {
    const order = await orderIn('HELD');
    for (const statusReason of [
      'whatever',
      '',
      ' ',
      'low_balance',
      'LOW_BALANCE ',
      'LOW BALANCE',
      'PRICE_ABOVE_MAX\n',
    ]) {
      await expectCheck(
        db.order.update({ where: { id: order.id }, data: { statusReason } }),
        'Order_status_reason_check',
      );
    }
  });

  it('the CHECK lists exactly ORDER_STATUS_REASONS (no drift)', async () => {
    const [row] = await db.$queryRaw<{ def: string }[]>`
      SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
      WHERE c.conname = 'Order_status_reason_check'`;
    const literals = [...(row?.def ?? '').matchAll(/'([A-Z_]+)'::text/g)].map((m) => m[1]);
    expect([...literals].sort()).toEqual([...ORDER_STATUS_REASONS].sort());
  });
});
