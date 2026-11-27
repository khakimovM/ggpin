import { COST_MAX_AGE_MS, MAX_CLOCK_SKEW_MS } from '@repo/shared';
import type { CostSnapshot } from '../generated/prisma/client.js';
import type { Tx } from '../ledger/ledger.js';

// Which CostSnapshot rows may back a price, in ONE place for the API's price book (quotes and
// catalog prices) and the worker's recipient check (phase 5 S9g, D-62 (4)), so the two can never
// pick different rows. Reads only: the price sync appends rows, nothing changes or deletes them.
//
// - "Newest" is `createdAt DESC, id DESC`: two rows with the same timestamp have a fixed order.
// - A row stamped more than MAX_CLOCK_SKEW_MS in the future is ignored (it must not become the
//   newest price and hide the correct one); a row older than COST_MAX_AGE_MS is stale. Both
//   bounds are inclusive: a row exactly COST_MAX_AGE_MS old is still fresh.

const NEWEST_FIRST = [{ createdAt: 'desc' }, { id: 'desc' }] as const;

/** The key of one priced unit: a pack (`skuId`) or the product-level row (`skuId: null`). */
export function costSnapshotKey(productId: string, skuId: string | null): string {
  return `${productId}:${skuId ?? ''}`;
}

/**
 * The `createdAt` range of the cost snapshots that are fresh at `now` (both ends inclusive). The
 * API's `isFresh(createdAt, now, COST_MAX_AGE_MS)` and `latestAcceptedAt(now)` describe the same
 * range (asserted by the API's cost-snapshot-selection spec).
 */
export function freshCostSnapshotWindow(now: Date): { readonly since: Date; readonly until: Date } {
  return {
    since: new Date(now.getTime() - COST_MAX_AGE_MS),
    until: new Date(now.getTime() + MAX_CLOCK_SKEW_MS),
  };
}

/** `skuId: null` selects the product-level snapshot (Stars), not "any snapshot". */
export function latestCostSnapshot(
  db: Tx,
  productId: string,
  skuId: string | null,
  notAfter: Date,
): Promise<CostSnapshot | null> {
  return db.costSnapshot.findFirst({
    where: { productId, skuId, createdAt: { lte: notAfter } },
    orderBy: [...NEWEST_FIRST],
  });
}

/**
 * Newest snapshot per (productId, skuId) among rows created within [since, until], keyed by
 * `costSnapshotKey`. The window keeps the read bounded (the sync appends a row every few minutes
 * forever). The map's iteration order is newest first: its first entry is the newest row of all.
 */
export async function latestCostSnapshotsBetween(
  db: Tx,
  productIds: readonly string[],
  since: Date,
  until: Date,
): Promise<ReadonlyMap<string, CostSnapshot>> {
  const rows = await db.costSnapshot.findMany({
    where: { productId: { in: [...productIds] }, createdAt: { gte: since, lte: until } },
    orderBy: [...NEWEST_FIRST],
  });
  const newest = new Map<string, CostSnapshot>();
  for (const row of rows) {
    const key = costSnapshotKey(row.productId, row.skuId);
    if (!newest.has(key)) newest.set(key, row);
  }
  return newest;
}
