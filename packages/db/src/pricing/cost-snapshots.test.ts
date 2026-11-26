import { COST_MAX_AGE_MS, MAX_CLOCK_SKEW_MS } from '@repo/shared';
import { describe, expect, it, vi } from 'vitest';
import type { CostSnapshot } from '../generated/prisma/client.js';
import type { Tx } from '../ledger/index.js';
import {
  costSnapshotKey,
  freshCostSnapshotWindow,
  latestCostSnapshot,
  latestCostSnapshotsBetween,
} from './cost-snapshots.js';

// The one CostSnapshot selection rule of the API price book and the worker recipient check (S9g).

const NOW = new Date('2026-06-01T12:00:00.000Z');

function row(id: string, skuId: string | null, createdAt: Date): CostSnapshot {
  return {
    id,
    productId: 'p1',
    skuId,
    adapter: 'FRAGMENT',
    currency: 'TON',
    basisQuantity: 1,
    costMinor: 1n,
    source: 'fixture',
    createdAt,
  };
}

function fakeDb(rows: readonly CostSnapshot[] = []) {
  const findMany = vi.fn(() => Promise.resolve([...rows]));
  const findFirst = vi.fn(() => Promise.resolve(rows[0] ?? null));
  return { db: { costSnapshot: { findMany, findFirst } } as unknown as Tx, findMany, findFirst };
}

describe('freshCostSnapshotWindow', () => {
  it('is [now - COST_MAX_AGE_MS, now + MAX_CLOCK_SKEW_MS]', () => {
    expect(freshCostSnapshotWindow(NOW)).toEqual({
      since: new Date(NOW.getTime() - COST_MAX_AGE_MS),
      until: new Date(NOW.getTime() + MAX_CLOCK_SKEW_MS),
    });
  });
});

describe('latestCostSnapshot', () => {
  it('reads the newest row of exactly that key, created no later than notAfter', async () => {
    const { db, findFirst } = fakeDb();
    await latestCostSnapshot(db, 'p1', null, NOW);
    expect(findFirst).toHaveBeenCalledWith({
      where: { productId: 'p1', skuId: null, createdAt: { lte: NOW } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  });
});

describe('latestCostSnapshotsBetween', () => {
  it('reads the window newest first (ties by id) and keeps the first row of every key', async () => {
    const since = new Date(NOW.getTime() - 1_000);
    // Already in the database's order, as the query asks for it.
    const rows = [
      row('c', 'sku1', NOW),
      row('b', null, NOW),
      row('a', 'sku1', since),
      row('z', null, since),
    ];
    const { db, findMany } = fakeDb(rows);
    const newest = await latestCostSnapshotsBetween(db, ['p1'], since, NOW);
    expect(findMany).toHaveBeenCalledWith({
      where: { productId: { in: ['p1'] }, createdAt: { gte: since, lte: NOW } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    expect([...newest.entries()].map(([key, value]) => [key, value.id])).toEqual([
      [costSnapshotKey('p1', 'sku1'), 'c'],
      [costSnapshotKey('p1', null), 'b'],
    ]);
  });
});
