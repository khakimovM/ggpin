import { describe, it } from 'vitest';
import type { Prisma, TonTransferStatus } from '../src/index';
import { expectCheck, expectGuard, expectPrismaCode } from './check-helpers';
import { db } from './client';
import { createOrder, createUser } from './factories';
import { walkTo } from './order-fixtures';

// Phase 5 (migration 10, part 2): the CHECK constraints and partial unique indexes of TonTransfer,
// each with an accepted and a refused case. The status machine, the write-once chain data and the
// delete guard are in ton-transfer-guard.e2e.test.ts.

let counter = 0;
const next = (): number => ++counter;
const hex64 = (n: number): string => n.toString(16).padStart(64, '0');
const raw = (n: number): string => `0:${hex64(n)}`;

// A payout starts for a PROCESSING order only (the attempt guard of migration 10).
async function attemptFor(): Promise<{ id: string }> {
  const order = await createOrder(await createUser());
  await walkTo(order.id, 'PROCESSING');
  return db.fulfillmentAttempt.create({
    data: { orderId: order.id, attemptNo: 1, adapter: 'FRAGMENT', status: 'SENDING', request: {} },
    select: { id: true },
  });
}

/** Input for a new transfer: SIGNED, the only status a transfer is born with. */
function transfer(
  overrides: Partial<Prisma.TonTransferUncheckedCreateInput> = {},
): Prisma.TonTransferUncheckedCreateInput {
  const n = next();
  return {
    purpose: 'SELFTEST',
    network: 'testnet',
    walletAddress: raw(1),
    seqno: n,
    validUntil: new Date('2026-11-11T10:01:00.000Z'),
    toAddress: raw(2),
    amountNanoTon: 1_000_000_000n,
    payloadHash: hex64(3),
    extMsgHash: hex64(1000 + n),
    bocBase64: 'te6cc',
    status: 'SIGNED',
    ...overrides,
  };
}

/** A transfer moved to `status` the way the sender and the reconciler do. */
async function moved(
  status: TonTransferStatus,
  overrides: Partial<Prisma.TonTransferUncheckedCreateInput> = {},
) {
  const row = await db.tonTransfer.create({ data: transfer(overrides) });
  if (status === 'SIGNED') return row;
  const chain = status === 'CONFIRMED' || status === 'ONCHAIN_FAILED';
  return db.tonTransfer.update({
    where: { id: row.id },
    data: {
      status,
      ...(chain ? { txHash: hex64(5000 + next()) } : {}),
      ...(status === 'CONFIRMED' ? { txLt: 48_123_456_000_001n } : {}),
    },
  });
}

describe('TonTransfer CHECK constraints', () => {
  it('accepts an ORDER transfer with its attempt and a SELFTEST transfer without one', async () => {
    const attempt = await attemptFor();
    await db.tonTransfer.create({
      data: transfer({ purpose: 'ORDER', network: 'mainnet', attemptId: attempt.id }),
    });
    await db.tonTransfer.create({ data: transfer({ walletAddress: raw(9) }) });
  });

  it('refuses an unknown purpose or network', async () => {
    await expectCheck(
      db.tonTransfer.create({ data: transfer({ purpose: 'PAYOUT' }) }),
      'TonTransfer_purpose_check',
    );
    await expectCheck(
      db.tonTransfer.create({ data: transfer({ network: 'devnet' }) }),
      'TonTransfer_network_check',
    );
  });

  it('ORDER needs an attempt and SELFTEST must not have one', async () => {
    const attempt = await attemptFor();
    await expectCheck(
      db.tonTransfer.create({ data: transfer({ purpose: 'ORDER', network: 'mainnet' }) }),
      'TonTransfer_attempt_purpose_check',
    );
    await expectCheck(
      db.tonTransfer.create({ data: transfer({ purpose: 'SELFTEST', attemptId: attempt.id }) }),
      'TonTransfer_attempt_purpose_check',
    );
  });

  it('a self-test lives on the testnet only: it can never touch the real wallet', async () => {
    await expectCheck(
      db.tonTransfer.create({ data: transfer({ purpose: 'SELFTEST', network: 'mainnet' }) }),
      'TonTransfer_selftest_network_check',
    );
    const attempt = await attemptFor();
    await db.tonTransfer.create({
      data: transfer({ purpose: 'ORDER', network: 'testnet', attemptId: attempt.id }),
    });
  });

  it('refuses a negative seqno, a non-positive amount and a negative fee; accepts the edges', async () => {
    await db.tonTransfer.create({ data: transfer({ seqno: 0, walletAddress: raw(11) }) });
    await db.tonTransfer.create({ data: transfer({ amountNanoTon: 1n, walletAddress: raw(12) }) });
    for (const bad of [{ seqno: -1 }, { amountNanoTon: 0n }, { amountNanoTon: -1n }]) {
      await expectCheck(
        db.tonTransfer.create({ data: transfer({ walletAddress: raw(13), ...bad }) }),
        'TonTransfer_values_check',
      );
    }
    // The fee exists only on a transfer seen on the chain (audit N7): it is tested there.
    const fee = (feeNanoTon: bigint) => ({
      status: 'CONFIRMED' as const,
      txHash: hex64(6000 + next()),
      txLt: 1n,
      feeNanoTon,
    });
    const zero = await db.tonTransfer.create({ data: transfer({ walletAddress: raw(14) }) });
    await db.tonTransfer.update({ where: { id: zero.id }, data: fee(0n) });
    const negative = await db.tonTransfer.create({ data: transfer({ walletAddress: raw(15) }) });
    await expectCheck(
      db.tonTransfer.update({ where: { id: negative.id }, data: fee(-1n) }),
      'TonTransfer_values_check',
    );
  });

  it('a transfer seen on the chain has its transaction hash and its logical time', async () => {
    for (const status of ['CONFIRMED', 'ONCHAIN_FAILED', 'BOUNCED'] as const) {
      const row = await db.tonTransfer.create({
        data: transfer({ walletAddress: raw(20 + next()) }),
      });
      // BOUNCED is reached from BROADCAST, never straight from SIGNED.
      if (status === 'BOUNCED') {
        await db.tonTransfer.update({ where: { id: row.id }, data: { status: 'BROADCAST' } });
      }
      await expectCheck(
        db.tonTransfer.update({ where: { id: row.id }, data: { status, txLt: 1n } }),
        'TonTransfer_chain_tx_check',
      );
      await expectCheck(
        db.tonTransfer.update({
          where: { id: row.id },
          data: { status, txHash: hex64(7000 + next()) },
        }),
        'TonTransfer_chain_lt_check',
      );
      await db.tonTransfer.update({
        where: { id: row.id },
        data: { status, txHash: hex64(7000 + next()), txLt: 1n },
      });
    }
    for (const status of ['BROADCAST', 'EXPIRED', 'CONSUMED_UNMATCHED'] as const) {
      await moved(status, { walletAddress: raw(40 + next()) });
    }
  });
});

describe('TonTransfer partial unique indexes and plain uniques', () => {
  it('a wallet has one unresolved message: SIGNED and BROADCAST both count', async () => {
    await db.tonTransfer.create({ data: transfer() });
    await expectPrismaCode(db.tonTransfer.create({ data: transfer() }), 'P2002');
    const second = await db.tonTransfer.create({ data: transfer({ walletAddress: raw(2) }) });
    await db.tonTransfer.update({ where: { id: second.id }, data: { status: 'BROADCAST' } });
    await expectPrismaCode(
      db.tonTransfer.create({ data: transfer({ walletAddress: raw(2) }) }),
      'P2002',
    );
  });

  it('the fence is per network: the same account on the other network is another wallet (F14)', async () => {
    await db.tonTransfer.create({ data: transfer({ network: 'testnet' }) });
    const attempt = await attemptFor();
    await db.tonTransfer.create({
      data: transfer({ purpose: 'ORDER', network: 'mainnet', attemptId: attempt.id }),
    });
    await expectPrismaCode(
      db.tonTransfer.create({ data: transfer({ network: 'testnet' }) }),
      'P2002',
    );
  });

  it('a resolved message frees the wallet for the next one', async () => {
    await moved('CONFIRMED');
    await db.tonTransfer.create({ data: transfer() });
  });

  it('EXPIRED and CONSUMED_UNMATCHED are not unresolved', async () => {
    await moved('EXPIRED');
    await moved('CONSUMED_UNMATCHED', { seqno: 500 });
    await db.tonTransfer.create({ data: transfer({ seqno: 501 }) });
  });

  it('a seqno belongs to one live message; an EXPIRED one never holds it', async () => {
    await moved('CONFIRMED', { seqno: 7 });
    await expectPrismaCode(db.tonTransfer.create({ data: transfer({ seqno: 7 }) }), 'P2002');
    await moved('EXPIRED', { seqno: 7, walletAddress: raw(70) });
    // Another wallet, or the other network, is independent.
    await db.tonTransfer.create({ data: transfer({ seqno: 7, walletAddress: raw(71) }) });
    const attempt = await attemptFor();
    await db.tonTransfer.create({
      data: transfer({ seqno: 7, purpose: 'ORDER', network: 'mainnet', attemptId: attempt.id }),
    });
  });

  it('one transfer per attempt, one per message hash, one per transaction hash', async () => {
    const attempt = await attemptFor();
    const order = { purpose: 'ORDER', network: 'mainnet', attemptId: attempt.id } as const;
    await moved('EXPIRED', order);
    await expectPrismaCode(
      db.tonTransfer.create({ data: transfer({ ...order, walletAddress: raw(80) }) }),
      'P2002',
    );
    const ext = hex64(90_001);
    await moved('EXPIRED', { extMsgHash: ext, walletAddress: raw(81) });
    await expectPrismaCode(
      db.tonTransfer.create({ data: transfer({ extMsgHash: ext, walletAddress: raw(82) }) }),
      'P2002',
    );
    const tx = hex64(90_002);
    const a = await db.tonTransfer.create({ data: transfer({ walletAddress: raw(83) }) });
    await db.tonTransfer.update({
      where: { id: a.id },
      data: { status: 'CONFIRMED', txHash: tx, txLt: 1n },
    });
    const b = await db.tonTransfer.create({ data: transfer({ walletAddress: raw(84) }) });
    await expectPrismaCode(
      db.tonTransfer.update({
        where: { id: b.id },
        data: { status: 'CONFIRMED', txHash: tx, txLt: 1n },
      }),
      'P2002',
    );
  });

  it('the attempt cannot be deleted from under its transfer', async () => {
    const attempt = await attemptFor();
    await db.tonTransfer.create({
      data: transfer({ purpose: 'ORDER', network: 'mainnet', attemptId: attempt.id }),
    });
    // The attempt table has its own delete guard (GG001); the foreign key would refuse as well.
    await expectGuard(db.fulfillmentAttempt.delete({ where: { id: attempt.id } }), 'never deleted');
  });
});
