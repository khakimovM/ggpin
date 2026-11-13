import { describe, expect, it } from 'vitest';
import type { AttemptStatus, Prisma, TonTransferStatus } from '../src/index';
import { expectCheck, expectGuard, expectPrismaCode } from './check-helpers';
import { db } from './client';
import { createOrder, createUser } from './factories';
import { addTransfer, forceAttempt, walkTo } from './order-fixtures';

// Audit M5: one live attempt per order, a forward-only status, a fixed identity, a write-once
// reference, no deletes. Audit H2 part 3: "failed" needs the TON transfer to be provably EXPIRED
// (or failed on the chain, owner decision R2). Audit N1 / review R1: an attempt is born SENDING for
// an order that is PROCESSING, and its reference is written only while it is alive.

const STATUSES: readonly AttemptStatus[] = ['SENDING', 'SENT', 'UNKNOWN', 'CONFIRMED', 'FAILED'];

// The agreed machine (migration 10), written out again so the test is its own reference.
const EDGES: Readonly<Record<AttemptStatus, readonly AttemptStatus[]>> = {
  SENDING: ['SENT', 'UNKNOWN', 'CONFIRMED', 'FAILED'],
  SENT: ['UNKNOWN', 'CONFIRMED', 'FAILED'],
  UNKNOWN: ['CONFIRMED', 'FAILED'],
  CONFIRMED: [],
  FAILED: [],
};

let counter = 0;
const next = (): number => ++counter;

/** An order a payout may start for: PROCESSING. */
async function processingOrder() {
  const order = await createOrder(await createUser());
  await walkTo(order.id, 'PROCESSING');
  return order;
}

const insert = (orderId: string, attemptNo: number, status: AttemptStatus, ref: string | null) =>
  db.fulfillmentAttempt.create({
    data: { orderId, attemptNo, adapter: 'FRAGMENT', status, request: {}, externalRef: ref },
  });

/**
 * CONFIRMED means "delivery confirmed" (D-59 N1): the attempt becomes CONFIRMED in the SAME
 * transaction in which its order becomes DELIVERED, or the commit is refused.
 */
function confirmWithDelivery(row: { id: string; orderId: string }) {
  return db.$transaction(async (tx) => {
    const confirmed = await tx.fulfillmentAttempt.update({
      where: { id: row.id },
      data: { status: 'CONFIRMED' },
    });
    await tx.order.update({ where: { id: row.orderId }, data: { status: 'DELIVERED' } });
    return confirmed;
  });
}

/** An attempt in `status`: born SENDING (the only way in), then moved by the edge SENDING has to it. */
async function make(
  orderId: string,
  attemptNo: number,
  status: AttemptStatus,
  externalRef: string | null = null,
) {
  const row = await insert(orderId, attemptNo, 'SENDING', externalRef);
  if (status === 'SENDING') return row;
  if (status === 'CONFIRMED') return confirmWithDelivery(row);
  return db.fulfillmentAttempt.update({ where: { id: row.id }, data: { status } });
}

/** An attempt moved to `status` by the single edge SENDING has to it (it has a reference). */
async function attemptIn(status: AttemptStatus) {
  return make((await processingOrder()).id, 1, status, `ref-${next()}`);
}

describe('one live attempt per order, CONFIRMED included', () => {
  it.each(['SENDING', 'SENT', 'UNKNOWN', 'CONFIRMED'] as const)(
    'a %s attempt blocks a second live attempt of the order',
    async (status) => {
      const order = await processingOrder();
      // A CONFIRMED attempt of a PROCESSING order is a state the database refuses at commit (its order
      // would have to be DELIVERED), so it is forced in: this test is about the unique index alone.
      if (status === 'CONFIRMED')
        await forceAttempt(order.id, 'CONFIRMED', { externalRef: 'ref-live' });
      else await make(order.id, 1, status, null);
      // A second attempt is born SENDING, which the live one already forbids.
      await expectPrismaCode(insert(order.id, 2, 'SENDING', null), 'P2002');
      await expectPrismaCode(insert(order.id, 3, 'SENDING', `ref-${next()}`), 'P2002');
    },
  );

  it('a failed attempt does not block, and a new live one follows it', async () => {
    const order = await processingOrder();
    const first = await make(order.id, 1, 'SENDING', 'ref-a');
    await db.fulfillmentAttempt.update({ where: { id: first.id }, data: { status: 'FAILED' } });
    await make(order.id, 2, 'FAILED');
    await make(order.id, 3, 'SENDING', 'ref-b');
  });

  it('other orders are independent', async () => {
    const a = await processingOrder();
    const b = await processingOrder();
    await make(a.id, 1, 'SENDING');
    await make(b.id, 1, 'SENDING');
  });

  it('CONFIRMED needs an external reference', async () => {
    const refused = await processingOrder();
    await expectCheck(make(refused.id, 1, 'CONFIRMED'), 'FulfillmentAttempt_confirmed_ref_check');
    const accepted = await processingOrder();
    await make(accepted.id, 1, 'CONFIRMED', `ref-${next()}`);
  });
});

describe('the attempt status only goes forward (every pair)', () => {
  const pairs = STATUSES.flatMap((from) =>
    STATUSES.filter((to) => to !== from).map((to) => [from, to] as const),
  );

  it.each(pairs)('%s -> %s', async (from, to) => {
    const row = await attemptIn(from);
    const move =
      to === 'CONFIRMED'
        ? confirmWithDelivery(row)
        : db.fulfillmentAttempt.update({ where: { id: row.id }, data: { status: to } });
    if (EDGES[from].includes(to)) {
      expect((await move).status).toBe(to);
    } else {
      await expectGuard(move, 'is not allowed');
    }
  });

  it('the SQL function and the table above agree on every pair (no drift)', async () => {
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        const [row] = await db.$queryRaw<{ ok: boolean }[]>`
          SELECT ggpin_attempt_edge_allowed(${from}::"AttemptStatus", ${to}::"AttemptStatus") AS ok`;
        expect(row?.ok, `${from} -> ${to}`).toBe(EDGES[from].includes(to));
      }
    }
  });
});

describe('FAILED claims that nothing was paid: the TON transfer must be provably EXPIRED (H2 part 3)', () => {
  it.each([
    'SIGNED',
    'BROADCAST',
    'CONFIRMED',
    'CONSUMED_UNMATCHED',
    'ONCHAIN_FAILED',
    'BOUNCED',
  ] as const)(
    'an attempt whose transfer is %s cannot fail while its order is PROCESSING',
    async (status: TonTransferStatus) => {
      const attempt = await attemptIn('SENDING');
      await addTransfer(attempt.id, status);
      await expectGuard(
        db.fulfillmentAttempt.update({ where: { id: attempt.id }, data: { status: 'FAILED' } }),
        'cannot fail',
      );
      expect(
        (await db.fulfillmentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status,
      ).toBe('SENDING');
    },
  );

  it.each(['ONCHAIN_FAILED', 'BOUNCED', 'CONSUMED_UNMATCHED'] as const)(
    'an attempt whose transfer is %s can fail only once its order is NEEDS_REVIEW: the owner-only proof is the way out (A4)',
    async (status: TonTransferStatus) => {
      const attempt = await attemptIn('SENDING');
      await addTransfer(attempt.id, status);
      await db.order.update({
        where: { id: attempt.orderId },
        data: { status: 'NEEDS_REVIEW', statusReason: 'CONFIRM_TIMEOUT' },
      });
      await db.fulfillmentAttempt.update({ where: { id: attempt.id }, data: { status: 'FAILED' } });
    },
  );

  it('an attempt with an EXPIRED transfer, or with none, can fail', async () => {
    const proven = await attemptIn('SENDING');
    await addTransfer(proven.id, 'EXPIRED');
    await db.fulfillmentAttempt.update({ where: { id: proven.id }, data: { status: 'FAILED' } });
    const bare = await attemptIn('SENT');
    await db.fulfillmentAttempt.update({ where: { id: bare.id }, data: { status: 'FAILED' } });
  });

  it('the other forward moves do not look at the transfer', async () => {
    const attempt = await attemptIn('SENDING');
    await addTransfer(attempt.id, 'CONFIRMED');
    await confirmWithDelivery(attempt);
  });
});

describe('the identity and the reference of an attempt', () => {
  it('order, attemptNo, adapter, request and createdAt are immutable (GG001)', async () => {
    const row = await attemptIn('SENDING');
    const other = await createOrder(await createUser());
    const changes: Prisma.FulfillmentAttemptUncheckedUpdateInput[] = [
      { orderId: other.id },
      { attemptNo: row.attemptNo + 1 },
      { adapter: 'RESELLER_STARS' },
      { request: { to: 'elsewhere' } },
      { createdAt: new Date(0) },
    ];
    for (const data of changes) {
      await expectGuard(db.fulfillmentAttempt.update({ where: { id: row.id }, data }), 'immutable');
    }
  });

  it('the reference is written once: it can be set, then never changed or cleared', async () => {
    const order = await processingOrder();
    const row = await make(order.id, 1, 'SENDING');
    await db.fulfillmentAttempt.update({
      where: { id: row.id },
      data: { externalRef: 'ref-first' },
    });
    for (const externalRef of ['ref-second', null]) {
      await expectGuard(
        db.fulfillmentAttempt.update({ where: { id: row.id }, data: { externalRef } }),
        'written once',
      );
    }
    await db.fulfillmentAttempt.update({
      where: { id: row.id },
      data: { externalRef: 'ref-first', status: 'SENT' },
    });
  });

  it('the response, the cost and the error stay writable', async () => {
    const row = await attemptIn('SENDING');
    await db.fulfillmentAttempt.update({
      where: { id: row.id },
      data: { response: { ok: true }, costMinor: 235_000_000n, error: 'none' },
    });
  });
});

describe('an attempt is never deleted', () => {
  it.each(STATUSES)('DELETE of a %s attempt is refused (GG001), the row stays', async (status) => {
    const row = await attemptIn(status);
    await expectGuard(db.fulfillmentAttempt.delete({ where: { id: row.id } }), 'never deleted');
    expect(await db.fulfillmentAttempt.count({ where: { id: row.id } })).toBe(1);
  });
});
