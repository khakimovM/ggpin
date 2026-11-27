import type { AdminE2e } from './admin-e2e.api';

type Db = ReturnType<AdminE2e['db']>;

// The catalog rows the admin fixtures write on the shared *_test database (`oo-` open orders,
// `ar-` read world), removed when a suite starts (a killed earlier run) and when it closes, as far
// as the database guards allow, never around them:
//   * An order is never deleted (Order_no_delete, D-60), and it holds its quote, cost snapshot, FX
//     rate, pack and product by foreign key (Restrict). So a product that has orders stays, with
//     its pack, routes and category: that is the persistent `<prefix>fixture` catalog every run
//     reuses (admin-fixture-orders.ts), an inactive product, so the product count stays flat.
//     Its orders are isolated by the prefix: nothing else reads that product.
//   * What no order holds goes: quotes without an order, cost snapshots no quote references (the
//     read world's fresh one and the price preview's future-dated one), unused fixture FX rates,
//     and every row of a prefixed product without orders (an earlier run's leftovers).
// One transaction, foreign-key order. Ledger entries, payments, bank messages and users are not
// touched: append-only (DB triggers) or restricted by them, and no catalog row depends on them.

/** The FX rate `source` the fixtures wrote before the persistent catalog (earlier runs). */
export const FIXTURE_FX_SOURCE = 'e2e';

/** The `source` of a prefix's fresh, unreferenced FX rate (the read world's price input). */
export function freshFxSource(prefix: string): string {
  return `${prefix}fresh`;
}

export async function purgeFixtureCatalog(db: Db, prefix: string): Promise<void> {
  const products = await db.product.findMany({
    where: {
      OR: [{ slug: { startsWith: prefix } }, { category: { slug: { startsWith: prefix } } }],
    },
    select: { id: true, _count: { select: { orders: true } } },
  });
  const productIds = products.map((row) => row.id);
  const orphanIds = products.filter((row) => row._count.orders === 0).map((row) => row.id);
  const byProduct = { productId: { in: productIds } };
  const byOrphan = { productId: { in: orphanIds } };
  const quotes = await db.quote.findMany({
    where: { ...byProduct, order: { is: null } },
    select: { fxRateId: true },
  });
  const fxRateIds = [...new Set(quotes.map((row) => row.fxRateId))];
  await db.$transaction([
    db.quote.deleteMany({ where: { ...byProduct, order: { is: null } } }),
    db.costSnapshot.deleteMany({ where: { ...byProduct, quotes: { none: {} } } }),
    db.fxRate.deleteMany({
      where: {
        OR: [
          // An earlier run's rate under a removed quote.
          { id: { in: fxRateIds }, source: FIXTURE_FX_SOURCE },
          // The read world's fresh rate (never under a quote).
          { source: freshFxSource(prefix) },
        ],
        quotes: { none: {} },
        orders: { none: {} },
      },
    }),
    db.sku.deleteMany({ where: byOrphan }),
    db.productRoute.deleteMany({ where: byOrphan }),
    db.product.deleteMany({ where: { id: { in: orphanIds } } }),
    db.category.deleteMany({ where: { slug: { startsWith: prefix }, products: { none: {} } } }),
  ]);
}

/** Call once per suite file, after `useAdminE2e()`: purges `prefix` rows before and after it. */
export function purgeFixtureCatalogAround(t: AdminE2e, prefix: string): void {
  beforeAll(() => purgeFixtureCatalog(t.db(), prefix));
  // The harness runs closers before it deletes its own users.
  t.onClose(() => purgeFixtureCatalog(t.db(), prefix));
}
