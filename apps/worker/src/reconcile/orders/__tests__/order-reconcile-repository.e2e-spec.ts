import { createPrismaClient, type PrismaClient } from '@repo/db';
import { RECONCILE_BATCH_LIMIT } from '@repo/shared';
import { buildE2eEnv } from '../../../config/__tests__/e2e-env';
import { OrderReconcileRepository, type ReviewCursor } from '../order-reconcile.repository';

// The reconciler's real lists on the shared test database (which keeps the rows of earlier runs:
// the other e2e files narrow them to their own orders). Only properties that hold whatever else is
// there: ORDER transfers that wait for the chain, oldest first; NEEDS_REVIEW orders after the
// cursor, oldest first; never more than a batch.

const env = buildE2eEnv();
let db: PrismaClient;
let repository: OrderReconcileRepository;

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

  it('lists only ORDER transfers waiting for the chain, oldest first, a batch at most', async () => {
    const listed = await repository.pendingTransfers(1_000);
    expect(listed.length).toBeLessThanOrEqual(RECONCILE_BATCH_LIMIT);
    const rows = await db.tonTransfer.findMany({
      where: { id: { in: listed.map((l) => l.id) } },
      select: { id: true, purpose: true, status: true, createdAt: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const ordered = listed.map((l) => byId.get(l.id));
    for (const row of ordered) {
      expect(row?.purpose).toBe('ORDER');
      expect(['SIGNED', 'BROADCAST']).toContain(row?.status);
    }
    for (let i = 1; i < ordered.length; i += 1) {
      expect(ordered[i]?.createdAt.getTime()).toBeGreaterThanOrEqual(
        ordered[i - 1]?.createdAt.getTime() ?? 0,
      );
    }
    const waiting = await db.tonTransfer.count({
      where: { purpose: 'ORDER', status: { in: ['SIGNED', 'BROADCAST'] } },
    });
    expect(listed.length).toBe(Math.min(waiting, RECONCILE_BATCH_LIMIT));
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
