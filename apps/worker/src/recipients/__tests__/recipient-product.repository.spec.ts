import {
  freshCostSnapshotWindow,
  latestCostSnapshotsBetween,
  type CostSnapshot,
  type PrismaClient,
} from '@repo/db';
import { COST_MAX_AGE_MS, MAX_CLOCK_SKEW_MS } from '@repo/shared';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import { RecipientProductRepository } from '../recipient-product.repository';

// Phase 5 S9g: which cost snapshot names the currency of a recipient check. The read is @repo/db's
// `latestCostSnapshotsBetween` over `freshCostSnapshotWindow(now)`, the very query and window of
// the API's catalog prices (its side: apps/api .../pricing/__tests__/cost-snapshot-selection.spec);
// the real-database proof of the window is validate-recipient-currency.e2e-spec.ts.

const NOW = new Date('2026-06-01T12:00:00.000Z');
/** Stars: custom quantity, no packs. Premium: fixed packs sku1 and sku2 (both active). */
const STARS = { id: 'p1', allowCustomQty: true, skus: [] };
const PREMIUM = { id: 'p1', allowCustomQty: false, skus: [{ id: 'sku1' }, { id: 'sku2' }] };

function row(id: string, skuId: string | null, currency = 'TON', adapter = 'FRAGMENT') {
  const snapshot: CostSnapshot = {
    id,
    productId: 'p1',
    skuId,
    adapter,
    currency,
    basisQuantity: 1,
    costMinor: 1n,
    source: 'fixture',
    createdAt: NOW,
  };
  return snapshot;
}

/** Rows already in the database's order (createdAt DESC, id DESC). */
function repositoryWith(rows: readonly CostSnapshot[]) {
  const findMany = jest.fn((_args: unknown) => Promise.resolve([...rows]));
  const client = { costSnapshot: { findMany } };
  const prisma = { client } as unknown as PrismaService;
  return { repository: new RecipientProductRepository(prisma), findMany, client };
}

describe('RecipientProductRepository.pricedBy', () => {
  it('sends exactly the query of the shared @repo/db read over the fresh window', async () => {
    const mine = repositoryWith([]);
    await mine.repository.pricedBy(STARS, NOW);
    const shared = repositoryWith([]);
    const { since, until } = freshCostSnapshotWindow(NOW);
    await latestCostSnapshotsBetween(
      shared.client as unknown as PrismaClient,
      ['p1'],
      since,
      until,
    );
    expect(mine.findMany.mock.calls).toEqual(shared.findMany.mock.calls);
    // Spelled out once, so a change of the shared window is a visible change here too.
    expect(mine.findMany.mock.calls).toEqual([
      [
        {
          where: {
            productId: { in: ['p1'] },
            createdAt: {
              gte: new Date(NOW.getTime() - COST_MAX_AGE_MS),
              lte: new Date(NOW.getTime() + MAX_CLOCK_SKEW_MS),
            },
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        },
      ],
    ]);
  });

  it('no fresh row -> null', async () => {
    const { repository } = repositoryWith([]);
    await expect(repository.pricedBy(STARS, NOW)).resolves.toBeNull();
  });

  it('the newest row names adapter and currency (custom quantity: the product-level row)', async () => {
    const { repository } = repositoryWith([
      row('new', null, 'USDT', 'RESELLER_STARS'),
      row('old', null, 'TON', 'FRAGMENT'),
    ]);
    await expect(repository.pricedBy(STARS, NOW)).resolves.toEqual({
      kind: 'priced',
      snapshotId: 'new',
      adapter: 'RESELLER_STARS',
      currency: 'USDT',
    });
  });

  it('a fixed-pack product skips a product-level row (the API never prices it from one)', async () => {
    const rows = [row('stray', null, 'USDT', 'RESELLER_STARS'), row('pack', 'sku1', 'TON')];
    const { repository } = repositoryWith(rows);
    await expect(repository.pricedBy(PREMIUM, NOW)).resolves.toEqual({
      kind: 'priced',
      snapshotId: 'pack',
      adapter: 'FRAGMENT',
      currency: 'TON',
    });
    const only = repositoryWith([row('stray', null)]);
    await expect(only.repository.pricedBy(PREMIUM, NOW)).resolves.toBeNull();
  });

  it('two active packs in different currencies -> mixed (fail closed), whichever is newer', async () => {
    const usdtNewer = repositoryWith([
      row('p2', 'sku2', 'USDT', 'RESELLER_STARS'),
      row('p1', 'sku1', 'TON', 'FRAGMENT'),
    ]);
    await expect(usdtNewer.repository.pricedBy(PREMIUM, NOW)).resolves.toEqual({
      kind: 'mixed',
      currencies: ['USDT', 'TON'],
    });
    const tonNewer = repositoryWith([row('p1', 'sku1', 'TON'), row('p2', 'sku2', 'USDT')]);
    await expect(tonNewer.repository.pricedBy(PREMIUM, NOW)).resolves.toMatchObject({
      kind: 'mixed',
    });
  });

  it('two active packs in one currency -> the newest row, as before', async () => {
    const { repository } = repositoryWith([
      row('p2', 'sku2', 'USDT', 'RESELLER_STARS'),
      row('p1', 'sku1', 'USDT', 'RESELLER_STARS'),
    ]);
    await expect(repository.pricedBy(PREMIUM, NOW)).resolves.toEqual({
      kind: 'priced',
      snapshotId: 'p2',
      adapter: 'RESELLER_STARS',
      currency: 'USDT',
    });
  });

  it('a row of an inactive pack backs no quote: it neither names nor mixes the currency', async () => {
    const rows = [row('gone', 'sku_old', 'TON'), row('p1', 'sku1', 'USDT', 'RESELLER_STARS')];
    const { repository } = repositoryWith(rows);
    await expect(repository.pricedBy(PREMIUM, NOW)).resolves.toMatchObject({
      kind: 'priced',
      snapshotId: 'p1',
      currency: 'USDT',
    });
  });

  it('custom quantity: an active pack row in another currency than the product row -> mixed', async () => {
    const rows = [row('unit', null, 'USDT', 'RESELLER_STARS'), row('pack', 'sku1', 'TON')];
    const { repository } = repositoryWith(rows);
    await expect(repository.pricedBy({ ...STARS, skus: [{ id: 'sku1' }] }, NOW)).resolves.toEqual({
      kind: 'mixed',
      currencies: ['USDT', 'TON'],
    });
  });

  it('a currency the API cannot price fails closed (mixed), never null and never a guess (S9g L1)', async () => {
    const { repository } = repositoryWith([row('odd', null, 'BTC')]);
    await expect(repository.pricedBy(STARS, NOW)).resolves.toEqual({
      kind: 'mixed',
      currencies: [],
    });
  });
});
