import { randomBytes } from 'node:crypto';
import { createPrismaClient, type PrismaClient } from '@repo/db';
import { RECONCILE_BATCH_LIMIT } from '@repo/shared';
import { buildE2eEnv } from '../../../config/__tests__/e2e-env';
import { processingOrder } from '../../../ton/__tests__/ton-e2e.fixtures';
import { dryRunTonWallet } from '../../../ton/ton-wallet';
import { OrderReconcileRepository, type ReviewCursor } from '../order-reconcile.repository';

// The reconciler's real lists on the shared test database (which keeps the rows of earlier runs:
// the other e2e files narrow them to their own orders). Only properties that hold whatever else is
// there: this wallet's ORDER transfers that wait for the chain (never another wallet's), oldest first; NEEDS_REVIEW orders after the
// cursor, oldest first; never more than a batch.

const env = buildE2eEnv();
let db: PrismaClient;
let repository: OrderReconcileRepository;

const hex = (): string => randomBytes(32).toString('hex');

/** An unresolved (SIGNED) ORDER transfer of an order of its own, on this network and wallet. */
async function pendingRow(network: string, walletAddress: string): Promise<string> {
  const fixture = await processingOrder(db);
  const row = await db.tonTransfer.create({
    data: {
      purpose: 'ORDER',
      attemptId: fixture.attemptId,
      network,
      walletAddress,
      seqno: 0,
      validUntil: new Date(Date.now() + 60_000),
      toAddress: `0:${hex()}`,
      amountNanoTon: 1n,
      payloadHash: hex(),
      extMsgHash: hex(),
      bocBase64: 'te6cc',
      status: 'SIGNED',
    },
    select: { id: true },
  });
  return row.id;
}

const after = (a: ReviewCursor, b: ReviewCursor): boolean =>
  a.createdAt.getTime() > b.createdAt.getTime() ||
  (a.createdAt.getTime() === b.createdAt.getTime() && a.id > b.id);

beforeAll(() => {
  db = createPrismaClient(env.DATABASE_URL);
  repository = new OrderReconcileRepository({ client: db });
});

afterAll(async () => {
  await db.$disconnect();
});

describe('OrderReconcileRepository (real queries)', () => {
  it('reads the database clock', async () => {
    const now = await repository.databaseNowMs();
    expect(Math.abs(now - Date.now())).toBeLessThan(60_000);
  });

  it('lists only the own wallet unresolved ORDER transfers: foreign rows never take the batch (CR3)', async () => {
    // TonTransfer rows are never deleted (a DB guard): these three stay, as other suites' rows do.
    const own = dryRunTonWallet('testnet').rawAddress;
    const otherWallet = await pendingRow('testnet', dryRunTonWallet('testnet').rawAddress);
    const otherNetwork = await pendingRow('mainnet', dryRunTonWallet('testnet').rawAddress);
    const mine = await pendingRow('testnet', own);
    const wallet = { network: 'testnet', rawAddress: own };
    // Oldest first, one place: without the filter it is an older row of another wallet.
    expect((await repository.pendingTransfers(wallet, 1)).map((row) => row.id)).toEqual([mine]);
    const listed = await repository.pendingTransfers(wallet, 1_000);
    expect(listed).toEqual([
      expect.objectContaining({ id: mine, network: 'testnet', walletAddress: own }),
    ]);
    expect(listed.map((row) => row.id)).not.toContain(otherWallet);
    expect(listed.map((row) => row.id)).not.toContain(otherNetwork);
    const foreign = await repository.foreignPendingCount(wallet);
    const pending = await db.tonTransfer.count({
      where: { purpose: 'ORDER', status: { in: ['SIGNED', 'BROADCAST'] } },
    });
    expect(foreign).toBeGreaterThanOrEqual(2);
    expect(foreign).toBe(pending - 1);
  });

  it('never more than a batch', async () => {
    const wallet = { network: 'testnet', rawAddress: dryRunTonWallet('testnet').rawAddress };
    expect(await repository.pendingTransfers(wallet, 10_000)).toEqual([]);
    expect(RECONCILE_BATCH_LIMIT).toBeLessThanOrEqual(100);
  });

  it('walks NEEDS_REVIEW orders after the cursor, oldest first, without skipping one', async () => {
    const all = await db.order.findMany({
      where: { status: 'NEEDS_REVIEW' },
      select: { id: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const walked: ReviewCursor[] = [];
    let cursor: ReviewCursor | null = null;
    for (let page = 0; page < 50; page += 1) {
      const rows: ReviewCursor[] = await repository.reviewPage(cursor, 7);
      expect(rows.length).toBeLessThanOrEqual(7);
      for (const row of rows) if (cursor !== null) expect(after(row, cursor)).toBe(true);
      walked.push(...rows);
      if (rows.length < 7) break;
      cursor = rows[rows.length - 1] ?? null;
    }
    const seen = walked.map((row) => row.id);
    expect(seen).toEqual(all.slice(0, seen.length).map((row) => row.id));
    expect(new Set(seen).size).toBe(seen.length);
    expect(await repository.reviewPage(null, 10_000)).toHaveLength(
      Math.min(all.length, RECONCILE_BATCH_LIMIT),
    );
  });
});
