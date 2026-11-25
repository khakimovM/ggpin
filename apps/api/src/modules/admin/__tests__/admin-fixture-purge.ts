import type { AdminE2e } from './admin-e2e.api';

type Db = ReturnType<AdminE2e['db']>;

// The catalog-and-order rows the admin fixtures write on the shared *_test database (`oo-`
// open-orders, `ar-` read world). Like catalogKit's `acw-` purge: every row under the prefix goes
// when a suite starts (a killed earlier run) and when it closes, so the product count stays flat
// and the reorder suites (< 500 products) keep working. e2e runs in band, so no other suite's rows
// are in use. One transaction, foreign-key order: order -> quote -> cost snapshot -> FX rate ->
// package -> route -> product -> category.
//
// Not touched: ledger entries, payments, bank messages and users. They are append-only (DB
// triggers) or restricted by them, and none references a catalog row or an order by foreign key
// (a ledger entry names its order only in refType/refId). An order that has events or attempts
// (append-only, Restrict) makes the delete fail loudly instead of being skipped.

/** The FX rate `source` both fixtures write; only these rates, and only unused ones, are removed. */
export const FIXTURE_FX_SOURCE = 'e2e';

export async function purgeFixtureCatalog(db: Db, prefix: string): Promise<void> {
  const products = await db.product.findMany({
    where: {
      OR: [{ slug: { startsWith: prefix } }, { category: { slug: { startsWith: prefix } } }],
    },
    select: { id: true },
  });
  const productIds = products.map((row) => row.id);
  const byProduct = { productId: { in: productIds } };
  const [quotes, orders] = await Promise.all([
    db.quote.findMany({ where: byProduct, select: { fxRateId: true } }),
    db.order.findMany({ where: byProduct, select: { fxRateId: true } }),
  ]);
  const fxRateIds = [...new Set([...quotes, ...orders].map((row) => row.fxRateId))];
  await db.$transaction([
    db.order.deleteMany({ where: byProduct }),
    db.quote.deleteMany({ where: byProduct }),
    db.costSnapshot.deleteMany({ where: byProduct }),
    db.fxRate.deleteMany({
      where: {
        id: { in: fxRateIds },
        source: FIXTURE_FX_SOURCE,
        quotes: { none: {} },
        orders: { none: {} },
      },
    }),
    db.sku.deleteMany({ where: byProduct }),
    db.productRoute.deleteMany({ where: byProduct }),
    db.product.deleteMany({ where: { id: { in: productIds } } }),
    db.category.deleteMany({ where: { slug: { startsWith: prefix } } }),
  ]);
}

/** Call once per suite file, after `useAdminE2e()`: purges `prefix` rows before and after it. */
export function purgeFixtureCatalogAround(t: AdminE2e, prefix: string): void {
  beforeAll(() => purgeFixtureCatalog(t.db(), prefix));
  // The harness runs closers before it deletes its own users.
  t.onClose(() => purgeFixtureCatalog(t.db(), prefix));
}
