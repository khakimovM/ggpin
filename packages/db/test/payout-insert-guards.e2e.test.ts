import { ORDER_STATUSES, TON_NOT_SENT_MARGIN_MS, type OrderStatus } from '@repo/shared';
import { describe, expect, it } from 'vitest';
import type { AttemptStatus, Prisma } from '../src/index';
import { expectCheck, expectGuard, expectPrismaCode } from './check-helpers';
import { db } from './client';
import { createOrder, createUser } from './factories';
import {
  addAttempt,
  addTransfer,
  forceAttempt,
  paidOrder,
  statusOf,
  walkTo,
} from './order-fixtures';

// Audit N1 (review R1): an attempt is born SENDING for a PROCESSING order, a transfer is born SIGNED
// for a SENDING attempt of a PROCESSING order; the reference of an attempt is written only while it
// lives. Audit N2: a transfer is EXPIRED only after validUntil + margin, by the database's clock.
// Audit N7: the chain data exists only on a transfer that was seen on the chain. These are the
// probes of the second audit round (N1, C1b, N1c, B2, B2b, D8) turned into tests.

const attemptRow = (orderId: string, status: AttemptStatus, attemptNo = 1) =>
  db.fulfillmentAttempt.create({
    data: { orderId, attemptNo, adapter: 'FRAGMENT', status, request: {} },
  });

describe('an attempt is born SENDING for an order that is PROCESSING', () => {
  it.each(['SENT', 'UNKNOWN', 'CONFIRMED', 'FAILED'] as const)(
    'an INSERT as %s is refused (N1c)',
    async (status) => {
      const { order } = await paidOrder('PROCESSING');
      await expectGuard(attemptRow(order.id, status), 'is created SENDING');
    },
  );

  it.each(ORDER_STATUSES.filter((s) => s !== 'PROCESSING'))(
    'an order that is %s cannot start a payout (N1a, N1b)',
    async (status: OrderStatus) => {
      const order = await createOrder(await createUser());
      await walkTo(order.id, status);
      // A DELIVERED order already holds its CONFIRMED attempt (walkTo): nothing is added to it.
      const before = await db.fulfillmentAttempt.count({ where: { orderId: order.id } });
      await expectGuard(attemptRow(order.id, 'SENDING', 2), 'order that is PROCESSING');
      expect(await db.fulfillmentAttempt.count({ where: { orderId: order.id } })).toBe(before);
    },
  );

  it('a PROCESSING order can, and an order that does not exist is the foreign key', async () => {
    const { order } = await paidOrder('PROCESSING');
    await attemptRow(order.id, 'SENDING');
    await expectPrismaCode(attemptRow('no-such-order', 'SENDING'), 'P2003');
  });
});

describe('the reference of an attempt is written only while it is alive', () => {
  it.each(['FAILED'] as const)(
    'a %s attempt without a reference cannot get one',
    async (status) => {
      const { order } = await paidOrder('PROCESSING');
      const attempt = await addAttempt(order.id, 'SENDING', { externalRef: null });
      await db.fulfillmentAttempt.update({ where: { id: attempt.id }, data: { status } });
      await expectGuard(
        db.fulfillmentAttempt.update({
          where: { id: attempt.id },
          data: { externalRef: 'late-ref' },
        }),
        'cannot be written on a FAILED attempt',
      );
    },
  );

  it.each(['SENDING', 'SENT', 'UNKNOWN'] as const)('a %s attempt takes it once', async (status) => {
    const { order } = await paidOrder('PROCESSING');
    const attempt = await addAttempt(order.id, status, { externalRef: null });
    await db.fulfillmentAttempt.update({
      where: { id: attempt.id },
      data: { externalRef: 'ref-1' },
    });
  });

  it('the reference and the closing status may arrive in one write', async () => {
    const { order } = await paidOrder('PROCESSING');
    const attempt = await addAttempt(order.id, 'SENDING', { externalRef: null });
    // CONFIRMED only together with the delivery (D-59 N1): the same transaction delivers the order.
    await db.$transaction(async (tx) => {
      await tx.fulfillmentAttempt.update({
        where: { id: attempt.id },
        data: { externalRef: 'ref-1', status: 'CONFIRMED' },
      });
      await tx.order.update({ where: { id: order.id }, data: { status: 'DELIVERED' } });
    });
  });
});

describe('a transfer is signed only for a SENDING attempt of a PROCESSING order', () => {
  it.each(['SENT', 'UNKNOWN', 'CONFIRMED', 'FAILED'] as const)(
    'an attempt that is %s cannot get a transfer (N2a)',
    async (status) => {
      const { order } = await paidOrder('PROCESSING');
      // A CONFIRMED attempt of a PROCESSING order is refused at commit (its order must be DELIVERED),
      // so that one is forced in: the test is about the transfer INSERT guard.
      const attempt =
        status === 'CONFIRMED'
          ? await forceAttempt(order.id, 'CONFIRMED')
          : await addAttempt(order.id, status);
      await expectGuard(addTransfer(attempt.id, 'SIGNED'), 'attempt that is SENDING');
      expect(await db.tonTransfer.count()).toBe(0);
    },
  );

  it('a stalled worker whose order was moved on (here NEEDS_REVIEW) cannot sign (N1)', async () => {
    const { order } = await paidOrder('PROCESSING');
    const attempt = await addAttempt(order.id, 'SENDING');
    await db.order.update({
      where: { id: order.id },
      data: { status: 'NEEDS_REVIEW', statusReason: 'CONFIRM_TIMEOUT' },
    });
    await expectGuard(addTransfer(attempt.id, 'SIGNED'), 'order that is PROCESSING');
    expect(await statusOf(order.id)).toBe('NEEDS_REVIEW');
  });

  it('the probe N1: fail, refund, then the late worker writes a reference and a transfer: refused', async () => {
    const { order } = await paidOrder('PROCESSING');
    const attempt = await addAttempt(order.id, 'SENDING', { externalRef: null });
    await db.fulfillmentAttempt.update({ where: { id: attempt.id }, data: { status: 'FAILED' } });
    await db.order.update({
      where: { id: order.id },
      data: { status: 'FAILED', statusReason: 'RECIPIENT_GONE' },
    });
    await expectGuard(
      db.fulfillmentAttempt.update({ where: { id: attempt.id }, data: { externalRef: 'late' } }),
      'cannot be written',
    );
    await expectGuard(addTransfer(attempt.id, 'SIGNED'), 'order that is PROCESSING');
    // And a duplicate job cannot open a new attempt for the failed order.
    await expectGuard(attemptRow(order.id, 'SENDING', 2), 'order that is PROCESSING');
  });

  it('a self-test transfer has no order to check and a transfer for a missing attempt is the foreign key', async () => {
    await db.tonTransfer.create({
      data: {
        purpose: 'SELFTEST',
        network: 'testnet',
        walletAddress: '0:' + 'a'.repeat(64),
        seqno: 1,
        validUntil: new Date('2026-11-11T10:01:00.000Z'),
        toAddress: '0:' + 'c'.repeat(64),
        amountNanoTon: 1n,
        payloadHash: 'd'.repeat(64),
        extMsgHash: 'e'.repeat(64),
        bocBase64: 'te6cc',
        status: 'SIGNED',
      },
    });
    await expectPrismaCode(addTransfer('no-such-attempt', 'SIGNED'), 'P2003');
  });
});

describe('a transfer is EXPIRED only after validUntil + the margin (N2)', () => {
  const selftest = (validUntil: Date, n: number): Prisma.TonTransferUncheckedCreateInput => ({
    purpose: 'SELFTEST',
    network: 'testnet',
    walletAddress: `0:${n.toString(16).padStart(64, 'a')}`,
    seqno: n,
    validUntil,
    toAddress: '0:' + 'c'.repeat(64),
    amountNanoTon: 1n,
    payloadHash: 'd'.repeat(64),
    extMsgHash: n.toString(16).padStart(64, 'b'),
    bocBase64: 'te6cc',
    status: 'SIGNED',
  });
  const databaseNow = async (): Promise<number> => {
    const rows = await db.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
    return rows[0]?.now.getTime() ?? 0;
  };
  const tryExpire = async (offsetMs: number, n: number) => {
    const row = await db.tonTransfer.create({
      data: selftest(new Date((await databaseNow()) + offsetMs), n),
    });
    return db.tonTransfer.update({ where: { id: row.id }, data: { status: 'EXPIRED' } });
  };

  it('the SQL margin and TON_NOT_SENT_MARGIN_MS of @repo/shared are the same number', async () => {
    const rows = await db.$queryRaw<{ ms: number }[]>`SELECT ggpin_ton_not_sent_margin_ms() AS ms`;
    expect(rows[0]?.ms).toBe(TON_NOT_SENT_MARGIN_MS);
  });

  it('B2: one second after validUntil is refused; so is "still valid for 45 more seconds" (B2b)', async () => {
    await expectGuard(tryExpire(-1_000, 1), 'cannot expire before validUntil');
    await expectGuard(tryExpire(45_000, 2), 'cannot expire before validUntil');
    await expectGuard(tryExpire(-(TON_NOT_SENT_MARGIN_MS - 5_000), 3), 'cannot expire before');
  });

  it('past validUntil + margin it expires', async () => {
    expect((await tryExpire(-(TON_NOT_SENT_MARGIN_MS + 5_000), 4)).status).toBe('EXPIRED');
    expect((await tryExpire(-3_600_000, 5)).status).toBe('EXPIRED');
  });

  it('other moves of a young transfer are not held back by the margin', async () => {
    const row = await db.tonTransfer.create({
      data: selftest(new Date((await databaseNow()) + 60_000), 6),
    });
    await db.tonTransfer.update({ where: { id: row.id }, data: { status: 'BROADCAST' } });
    await db.tonTransfer.update({ where: { id: row.id }, data: { status: 'CONSUMED_UNMATCHED' } });
  });
});

describe('the chain data exists only on a transfer seen on the chain (N7)', () => {
  const hex = (n: number) => n.toString(16).padStart(64, '0');
  let n = 1000;
  const fresh = (seq: number) =>
    db.tonTransfer.create({
      data: {
        purpose: 'SELFTEST',
        network: 'testnet',
        walletAddress: `0:${hex(seq)}`,
        seqno: seq,
        validUntil: new Date('2026-11-11T10:01:00.000Z'),
        toAddress: '0:' + 'c'.repeat(64),
        amountNanoTon: 1n,
        payloadHash: 'd'.repeat(64),
        extMsgHash: hex(900 + seq),
        bocBase64: 'te6cc',
        status: 'SIGNED',
      },
    });

  it.each([
    ['txHash', { txHash: 'a'.repeat(64) }],
    ['txLt', { txLt: 1n }],
    ['feeNanoTon', { feeNanoTon: 1n }],
    ['confirmedAt', { confirmedAt: new Date() }],
  ])(
    '%s on a SIGNED, BROADCAST, EXPIRED or CONSUMED_UNMATCHED row is refused (D8)',
    async (_label, data) => {
      for (const status of ['SIGNED', 'BROADCAST', 'EXPIRED', 'CONSUMED_UNMATCHED'] as const) {
        const row = await fresh(++n);
        await expectCheck(
          db.tonTransfer.update({ where: { id: row.id }, data: { status, ...data } }),
          'TonTransfer_chain_fields_check',
        );
      }
    },
  );

  it('CONFIRMED, ONCHAIN_FAILED and BOUNCED need the transaction hash AND its logical time (audit I4, A1)', async () => {
    let seq = 0;
    for (const [status, from] of [
      ['CONFIRMED', 'SIGNED'],
      ['ONCHAIN_FAILED', 'SIGNED'],
      ['BOUNCED', 'BROADCAST'],
    ] as const) {
      const row = await fresh(++seq);
      if (from === 'BROADCAST') {
        await db.tonTransfer.update({ where: { id: row.id }, data: { status: 'BROADCAST' } });
      }
      await expectCheck(
        db.tonTransfer.update({
          where: { id: row.id },
          data: { status, txHash: 'a'.repeat(64) },
        }),
        'TonTransfer_chain_lt_check',
      );
      await expectCheck(
        db.tonTransfer.update({ where: { id: row.id }, data: { status, txLt: 5n } }),
        'TonTransfer_chain_tx_check',
      );
      const done = await db.tonTransfer.update({
        where: { id: row.id },
        data: {
          status,
          txHash: String(seq).repeat(64),
          txLt: 5n,
          confirmedAt: new Date(),
          feeNanoTon: 3n,
        },
      });
      expect(done.status).toBe(status);
    }
  });

  it('the chain data arrives on the edge that finds the transaction (late find, consumed seqno)', async () => {
    const late = await fresh(3);
    await db.tonTransfer.update({ where: { id: late.id }, data: { status: 'CONSUMED_UNMATCHED' } });
    await db.tonTransfer.update({
      where: { id: late.id },
      data: { status: 'CONFIRMED', txHash: 'c'.repeat(64), txLt: 9n },
    });
    const expired = await fresh(4);
    await db.tonTransfer.update({ where: { id: expired.id }, data: { status: 'EXPIRED' } });
    await db.tonTransfer.update({
      where: { id: expired.id },
      data: { status: 'CONFIRMED', txHash: 'd'.repeat(64), txLt: 10n },
    });
  });
});
