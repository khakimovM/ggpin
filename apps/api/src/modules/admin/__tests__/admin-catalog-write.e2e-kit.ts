import { randomBytes, randomUUID } from 'node:crypto';
import type { AdminE2e, Res } from './admin-e2e.api';
import type { Session } from './admin-write.e2e-kit';

// Rows of the admin catalog write e2e (S8a) on the shared *_test database: every category has its
// own `acw-<tag>` slug and so has every product (or it sits in an `acw-` category, the Premium
// stand-in), and is never active unless a suite says so (the store suites list active products
// only). Each suite removes ALL `acw-` rows when it starts (a killed earlier run) and when it
// closes (review M1), in foreign-key order: quote -> cost snapshot -> FX rate -> package ->
// route -> product -> category, like catalog-e2e.helpers.ts. e2e runs in band, so no other
// suite's rows can be in use while one purges.

const API = '/api/v1/admin';
const PREFIX = 'acw-';
/** The `source` of the FX rates a suite writes: the purge removes only these. */
export const ACW_FX_SOURCE = 'e2e-acw';

/** Deletes every row the catalog write suites made (also those of a killed earlier run). */
export async function purgeCatalogRows(db: ReturnType<AdminE2e['db']>): Promise<void> {
  const products = await db.product.findMany({
    where: {
      OR: [{ slug: { startsWith: PREFIX } }, { category: { slug: { startsWith: PREFIX } } }],
    },
    select: { id: true },
  });
  const productIds = products.map((row) => row.id);
  await db.quote.deleteMany({ where: { productId: { in: productIds } } });
  await db.costSnapshot.deleteMany({ where: { productId: { in: productIds } } });
  await db.fxRate.deleteMany({
    where: { source: ACW_FX_SOURCE, quotes: { none: {} }, orders: { none: {} } },
  });
  await db.sku.deleteMany({ where: { productId: { in: productIds } } });
  await db.productRoute.deleteMany({ where: { productId: { in: productIds } } });
  await db.product.deleteMany({ where: { id: { in: productIds } } });
  await db.category.deleteMany({ where: { slug: { startsWith: PREFIX } } });
}

export interface CatalogRows {
  readonly categoryId: string;
  readonly productId: string;
  readonly skuId: string;
  readonly routeId: string;
}

export interface ProductOptions {
  readonly allowCustomQty?: boolean;
  readonly slug?: string;
  readonly isActive?: boolean;
  /** The first package's quantity (default 50). */
  readonly quantity?: number;
}

/** Call once per suite file, after `useAdminE2e()` (its app boots first). */
export function catalogKit(t: AdminE2e) {
  const tag = () => randomBytes(5).toString('hex');
  beforeAll(() => purgeCatalogRows(t.db()));
  // The harness runs closers before it deletes the users a quote references.
  t.onClose(() => purgeCatalogRows(t.db()));

  const category = async (): Promise<string> => {
    const id = tag();
    const row = await t.db().category.create({
      data: { slug: `acw-${id}`, nameUz: `ACW kat ${id}`, nameRu: `ACW кат ${id}` },
      select: { id: true },
    });
    return row.id;
  };

  /** A product with one package (markup 15 %) and one FRAGMENT route. */
  const product = async (options: ProductOptions = {}): Promise<CatalogRows> => {
    const id = tag();
    const categoryId = await category();
    const row = await t.db().product.create({
      data: {
        slug: options.slug ?? `acw-${id}`,
        categoryId,
        nameUz: `ACW mahsulot ${id}`,
        nameRu: `ACW товар ${id}`,
        imageUrl: '/assets/products/acw.png',
        deliveryType: 'TG_USERNAME',
        inputSchema: [{ key: 'username', type: 'username' }],
        allowCustomQty: options.allowCustomQty ?? false,
        isActive: options.isActive ?? false,
        ...(options.allowCustomQty === true ? { minQty: 50, maxQty: 10_000 } : {}),
      },
      select: { id: true },
    });
    const quantity = options.quantity ?? 50;
    const sku = await t.db().sku.create({
      data: {
        productId: row.id,
        labelUz: `${String(quantity)} ta`,
        labelRu: `${String(quantity)} шт`,
        quantity,
        markupBps: 1500,
      },
      select: { id: true },
    });
    const route = await t.db().productRoute.create({
      data: { productId: row.id, adapter: 'FRAGMENT', priority: 1 },
      select: { id: true },
    });
    return { categoryId, productId: row.id, skuId: sku.id, routeId: route.id };
  };

  const send = (
    who: Session,
    method: 'POST' | 'PATCH',
    path: string,
    body: object,
    key: string | null = randomUUID(),
  ): Promise<Res> =>
    t.request(
      method,
      `${API}/${path}`,
      t.spa({ cookie: who.cookie, ...(key === null ? {} : { 'idempotency-key': key }) }),
      undefined,
      body,
    );

  const patch = (who: Session, path: string, body: object, key?: string | null) =>
    send(who, 'PATCH', path, body, key);
  const post = (who: Session, path: string, body: object, key?: string | null) =>
    send(who, 'POST', path, body, key);

  const audits = (action: string, targetId: string) =>
    t.db().auditLog.findMany({ where: { action, targetId }, orderBy: { createdAt: 'asc' } });

  return { category, product, patch, post, audits };
}

/** A valid new-package body; override what the case needs. */
export function packageBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    labelUz: '75 ta',
    labelRu: '75 шт',
    quantity: 75,
    markupBps: 1200,
    minMarginTiyin: '0',
    isActive: true,
    sort: 3,
    ...overrides,
  };
}
