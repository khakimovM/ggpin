import { describe, expect, it } from 'vitest';
import type { Prisma, TonTransferStatus } from '../src/index';
import { expectGuard } from './check-helpers';
import { db } from './client';

// Audit F5 / M1: a transfer is born SIGNED, its signed message never changes, its status follows
// the machine, the chain data is written once, and the row is never deleted. All GG001.

const STATUSES: readonly TonTransferStatus[] = [
  'SIGNED',
  'BROADCAST',
  'CONFIRMED',
  'ONCHAIN_FAILED',
  'EXPIRED',
  'CONSUMED_UNMATCHED',
  'BOUNCED',
];

// The agreed machine (migration 10), written out again so the test is its own reference.
// Owner decisions A1/A2 (D-59): BOUNCED comes from BROADCAST (the classifier) and from CONFIRMED (a
// bounce found late); CONSUMED_UNMATCHED can only be resolved by finding OUR transaction (CONFIRMED),
// never by a made-up ONCHAIN_FAILED; ONCHAIN_FAILED and BOUNCED are final.
const EDGES: Readonly<Record<TonTransferStatus, readonly TonTransferStatus[]>> = {
  SIGNED: ['BROADCAST', 'EXPIRED', 'CONFIRMED', 'ONCHAIN_FAILED', 'CONSUMED_UNMATCHED'],
  BROADCAST: ['EXPIRED', 'CONFIRMED', 'ONCHAIN_FAILED', 'CONSUMED_UNMATCHED', 'BOUNCED'],
  CONSUMED_UNMATCHED: ['CONFIRMED'],
  EXPIRED: ['CONFIRMED'],
  CONFIRMED: ['BOUNCED'],
  ONCHAIN_FAILED: [],
  BOUNCED: [],
};

/** The statuses that carry OUR transaction (hash and logical time). */
const CHAIN: readonly TonTransferStatus[] = ['CONFIRMED', 'ONCHAIN_FAILED', 'BOUNCED'];

let counter = 0;
const next = (): number => ++counter;
const hex64 = (n: number): string => n.toString(16).padStart(64, '0');

function transfer(overrides: Partial<Prisma.TonTransferUncheckedCreateInput> = {}) {
  const n = next();
  return {
    purpose: 'SELFTEST',
    network: 'testnet',
    walletAddress: `0:${hex64(n)}`, // a wallet of its own: one unresolved message per wallet
    seqno: n,
    validUntil: new Date('2026-11-11T10:01:00.000Z'),
    toAddress: `0:${hex64(2)}`,
    amountNanoTon: 1_000_000_000n,
    payloadHash: hex64(3),
    extMsgHash: hex64(1000 + n),
    bocBase64: 'te6cc',
    status: 'SIGNED',
    ...overrides,
  } satisfies Prisma.TonTransferUncheckedCreateInput;
}

/** A row in `status`: created SIGNED, then moved by the single edge SIGNED has to it. */
async function rowIn(status: TonTransferStatus) {
  const row = await db.tonTransfer.create({ data: transfer() });
  if (status === 'SIGNED') return row;
  // BOUNCED is reached from BROADCAST (or CONFIRMED), not from SIGNED.
  const from =
    status === 'BOUNCED'
      ? await db.tonTransfer.update({ where: { id: row.id }, data: { status: 'BROADCAST' } })
      : row;
  return db.tonTransfer.update({
    where: { id: from.id },
    data: {
      status,
      ...(CHAIN.includes(status)
        ? { txHash: hex64(9000 + next()), txLt: 48_123_456_000_001n }
        : {}),
    },
  });
}

describe('a transfer is born SIGNED', () => {
  it.each(STATUSES.filter((s) => s !== 'SIGNED'))(
    'an INSERT as %s is refused (GG001)',
    async (status) => {
      await expectGuard(
        db.tonTransfer.create({
          data: transfer({
            status,
            ...(CHAIN.includes(status) ? { txHash: hex64(1), txLt: 1n } : {}),
          }),
        }),
        'is created SIGNED',
      );
    },
  );

  it('an INSERT as SIGNED is accepted', async () => {
    await db.tonTransfer.create({ data: transfer() });
  });
});

describe('the status machine (every pair)', () => {
  const pairs = STATUSES.flatMap((from) =>
    STATUSES.filter((to) => to !== from).map((to) => [from, to] as const),
  );

  it.each(pairs)('%s -> %s', async (from, to) => {
    const row = await rowIn(from);
    const attempt = db.tonTransfer.update({
      where: { id: row.id },
      data: {
        status: to,
        ...(CHAIN.includes(to)
          ? { txHash: row.txHash ?? hex64(8000 + next()), txLt: row.txLt ?? 48_123_456_000_001n }
          : {}),
      },
    });
    if (EDGES[from].includes(to)) {
      expect((await attempt).status).toBe(to);
    } else {
      await expectGuard(attempt, 'is not allowed');
    }
  });

  it('the SQL function and the table above agree on every pair (no drift)', async () => {
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        const [row] = await db.$queryRaw<{ ok: boolean }[]>`
          SELECT ggpin_ton_transfer_edge_allowed(${from}::"TonTransferStatus", ${to}::"TonTransferStatus") AS ok`;
        expect(row?.ok, `${from} -> ${to}`).toBe(EDGES[from].includes(to));
      }
    }
  });

  it('ONCHAIN_FAILED and BOUNCED are final, EXPIRED can only be overturned by a late transaction', () => {
    expect(EDGES.ONCHAIN_FAILED).toEqual([]);
    expect(EDGES.BOUNCED).toEqual([]);
    expect(EDGES.EXPIRED).toEqual(['CONFIRMED']);
  });

  it('CONSUMED_UNMATCHED never becomes ONCHAIN_FAILED or EXPIRED: a made-up failure must not make it refundable (audit R2a2, R2c)', async () => {
    for (const to of ['ONCHAIN_FAILED', 'EXPIRED'] as const) {
      const row = await rowIn('CONSUMED_UNMATCHED');
      await expectGuard(
        db.tonTransfer.update({
          where: { id: row.id },
          data: {
            status: to,
            ...(to === 'ONCHAIN_FAILED' ? { txHash: hex64(9500 + next()), txLt: 5n } : {}),
          },
        }),
        'is not allowed',
      );
    }
  });
});

describe('the signed message is immutable and createdAt does not move', () => {
  it('every identity field is refused, one by one', async () => {
    const row = await db.tonTransfer.create({ data: transfer() });
    const changes: Prisma.TonTransferUncheckedUpdateInput[] = [
      { purpose: 'ORDER' },
      { network: 'mainnet' },
      { walletAddress: `0:${hex64(777)}` },
      { seqno: row.seqno + 1 },
      { validUntil: new Date('2030-01-01T00:00:00.000Z') },
      { toAddress: `0:${hex64(778)}` },
      { amountNanoTon: row.amountNanoTon + 1n },
      { payloadHash: hex64(779) },
      { extMsgHash: hex64(780) },
      { bocBase64: 'te6ccOther' },
      { createdAt: new Date(0) },
    ];
    for (const data of changes) {
      await expectGuard(db.tonTransfer.update({ where: { id: row.id }, data }), 'immutable');
    }
  });

  it('createdAt cannot be moved back to hide how old a transfer is (P5d)', async () => {
    const row = await db.tonTransfer.create({ data: transfer() });
    await expectGuard(
      db.tonTransfer.update({
        where: { id: row.id },
        data: { createdAt: new Date(row.createdAt.getTime() - 25 * 3_600_000) },
      }),
      'createdAt',
    );
  });

  it('a rewrite with the current value is not a change', async () => {
    const row = await db.tonTransfer.create({ data: transfer() });
    await db.tonTransfer.update({
      where: { id: row.id },
      data: {
        seqno: row.seqno,
        toAddress: row.toAddress,
        createdAt: row.createdAt,
        status: 'BROADCAST',
      },
    });
  });
});

describe('the chain data is written once', () => {
  it('txHash, txLt, feeNanoTon and confirmedAt are set once and then fixed', async () => {
    const row = await rowIn('SIGNED');
    const done = await db.tonTransfer.update({
      where: { id: row.id },
      data: {
        status: 'CONFIRMED',
        txHash: hex64(555),
        txLt: 48_123_456_000_001n,
        feeNanoTon: 5_000_000n,
        confirmedAt: new Date('2026-11-11T10:02:00.000Z'),
      },
    });
    const changes: Prisma.TonTransferUncheckedUpdateInput[] = [
      { txHash: hex64(556) },
      { txHash: null },
      { txLt: 1n },
      { txLt: null },
      { feeNanoTon: 6_000_000n },
      { feeNanoTon: null },
      { confirmedAt: new Date('2030-01-01T00:00:00.000Z') },
      { confirmedAt: null },
    ];
    for (const data of changes) {
      await expectGuard(db.tonTransfer.update({ where: { id: row.id }, data }), 'written once');
    }
    // Writing the same values again, or filling a field that was still empty, is fine.
    await db.tonTransfer.update({
      where: { id: row.id },
      data: { txHash: done.txHash, txLt: done.txLt },
    });
  });

  it('a field that was empty can be filled later (the fee arrives after the confirmation)', async () => {
    const row = await rowIn('CONFIRMED');
    expect(row.feeNanoTon).toBeNull();
    await db.tonTransfer.update({ where: { id: row.id }, data: { feeNanoTon: 4_000_000n } });
  });
});

describe('a transfer is never deleted', () => {
  it.each(STATUSES)('DELETE of a %s row is refused (GG001), the row stays', async (status) => {
    const row = await rowIn(status);
    await expectGuard(db.tonTransfer.delete({ where: { id: row.id } }), 'never deleted');
    expect(await db.tonTransfer.count({ where: { id: row.id } })).toBe(1);
  });

  it('a fence row cannot be deleted to free the wallet (P5 / D5)', async () => {
    const row = await rowIn('SIGNED');
    await expectGuard(db.tonTransfer.delete({ where: { id: row.id } }), 'never deleted');
    await expect(
      db.tonTransfer.create({ data: transfer({ walletAddress: row.walletAddress }) }),
    ).rejects.toThrow();
  });
});
