import {
  freshCostSnapshotWindow,
  latestCostSnapshot,
  latestCostSnapshotsBetween,
  type PrismaClient,
} from '@repo/db';
import { COST_MAX_AGE_MS, MAX_CLOCK_SKEW_MS } from '@repo/shared';
import type { PrismaService } from '../../../infra/prisma/prisma.service';
import { isFresh, latestAcceptedAt } from '../price-sources';
import { PricingRepository } from '../pricing.repository';

// Phase 5 S9g: the API price book and the worker's recipient check select CostSnapshot rows by ONE
// rule (@repo/db pricing/cost-snapshots.ts). The worker reads `latestCostSnapshotsBetween` over
// `freshCostSnapshotWindow(now)` (its side: apps/worker .../recipient-product.repository.spec).
// Here: the API sends the very same queries, and its own freshness test (isFresh with
// COST_MAX_AGE_MS, latestAcceptedAt) accepts exactly the rows inside that window.

const NOW = new Date('2026-06-01T12:00:00.000Z');
const at = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs);

function fakeClient() {
  const findFirst = jest.fn((_args: unknown) => Promise.resolve(null));
  const findMany = jest.fn((_args: unknown) => Promise.resolve([]));
  return { client: { costSnapshot: { findFirst, findMany } }, findFirst, findMany };
}

describe('CostSnapshot selection shared with the worker (S9g)', () => {
  it('the fresh window is exactly what isFresh and latestAcceptedAt accept', () => {
    const { since, until } = freshCostSnapshotWindow(NOW);
    expect(until).toEqual(latestAcceptedAt(NOW));
    const offsets = [
      -COST_MAX_AGE_MS - 1,
      -COST_MAX_AGE_MS,
      -COST_MAX_AGE_MS + 1,
      0,
      MAX_CLOCK_SKEW_MS - 1,
      MAX_CLOCK_SKEW_MS,
      MAX_CLOCK_SKEW_MS + 1,
    ];
    for (const offset of offsets) {
      const createdAt = at(offset);
      const inWindow = createdAt >= since && createdAt <= until;
      expect([offset, isFresh(createdAt, NOW, COST_MAX_AGE_MS)]).toEqual([offset, inWindow]);
    }
  });

  it('PricingRepository sends the shared @repo/db queries, argument for argument', async () => {
    const api = fakeClient();
    const repository = new PricingRepository({ client: api.client } as unknown as PrismaService);
    const shared = fakeClient();
    const db = shared.client as unknown as PrismaClient;
    const { since, until } = freshCostSnapshotWindow(NOW);

    await repository.latestCostSnapshot('p1', null, latestAcceptedAt(NOW));
    await repository.latestCostSnapshot('p1', 'sku1', latestAcceptedAt(NOW));
    await repository.latestCostSnapshotsBetween(['p1', 'p2'], since, until);
    await latestCostSnapshot(db, 'p1', null, latestAcceptedAt(NOW));
    await latestCostSnapshot(db, 'p1', 'sku1', latestAcceptedAt(NOW));
    await latestCostSnapshotsBetween(db, ['p1', 'p2'], since, until);

    expect(api.findFirst.mock.calls).toEqual(shared.findFirst.mock.calls);
    expect(api.findMany.mock.calls).toEqual(shared.findMany.mock.calls);
    expect(api.findMany.mock.calls).toEqual([
      [
        {
          where: { productId: { in: ['p1', 'p2'] }, createdAt: { gte: since, lte: until } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        },
      ],
    ]);
  });
});
