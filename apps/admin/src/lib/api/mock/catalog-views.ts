// The catalog fixtures with the mock journal's edits applied (S8b): what a read returns after a
// mock catalog write. Every merged record is parsed with its shared schema again, so a patch can
// never teach the UI a shape the real API does not send. Prices come from the shared money module
// only (`pricePreview`), the same function the API's preview uses.
import {
  AdminCategorySchema,
  AdminPricePreviewQuerySchema,
  AdminPricePreviewResponseSchema,
  AdminProductDetailResponseSchema,
  AdminProductRowSchema,
  COST_FX_PAIR,
  pricePreview,
  type AdminCategoryListResponse,
  type AdminProductDetailResponse,
  type AdminProductListResponse,
} from '@repo/shared';
import { mid } from './data-common';
import {
  CATEGORIES,
  MOCK_RATES,
  PRODUCTS,
  UNIT_COST,
  pricePreviewFixture,
  productDetailFixture,
  rowOf,
} from './fixtures-catalog';
import { readJournal, type Journal } from './mock-journal';
import { fail, ok, type MockReply } from './router';

type Catalog = Journal['catalog'];
type AdminCategory = AdminCategoryListResponse[number];
type AdminProductRow = AdminProductListResponse[number];
type Sku = AdminProductDetailResponse['skus'][number];

const catalogOf = (journal?: Journal): Catalog => (journal ?? readJournal()).catalog;

export function categoriesView(journal?: Journal): AdminCategory[] {
  const patches = catalogOf(journal).categories;
  return CATEGORIES.map((category) =>
    AdminCategorySchema.parse({ ...category, ...patches[category.id] }),
  ).sort((a, b) => a.sort - b.sort);
}

export function productDetailView(
  id: string,
  journal?: Journal,
): AdminProductDetailResponse | undefined {
  const base = productDetailFixture(id);
  if (base === undefined) return undefined;
  const catalog = catalogOf(journal);
  const order = catalog.order;
  const sort = order === null ? base.sort : Math.max(order.indexOf(id), 0);
  const created = catalog.newSkus[id] ?? [];
  return AdminProductDetailResponseSchema.parse({
    ...base,
    ...catalog.products[id],
    sort,
    skus: [...base.skus, ...created]
      .map((sku) => ({ ...sku, ...catalog.skus[String(sku.id)] }))
      .sort((a, b) => Number(a.sort) - Number(b.sort)),
    routes: base.routes
      .map((route) => ({ ...route, ...catalog.routes[route.id] }))
      .sort((a, b) => a.priority - b.priority),
  });
}

export function productRowsView(journal?: Journal): AdminProductRow[] {
  return PRODUCTS.flatMap((row) => {
    const detail = productDetailView(row.id, journal);
    return detail === undefined ? [] : [AdminProductRowSchema.parse(rowOf(detail))];
  }).sort((a, b) => a.sort - b.sort);
}

/** The product a package or a route belongs to, with that record as it is now. */
export function skuOwner(skuId: string, journal?: Journal) {
  for (const row of PRODUCTS) {
    const product = productDetailView(row.id, journal);
    const sku = product?.skus.find((one) => one.id === skuId);
    if (product !== undefined && sku !== undefined) return { product, sku };
  }
  return undefined;
}

export function routeOwner(routeId: string, journal?: Journal) {
  for (const row of PRODUCTS) {
    const product = productDetailView(row.id, journal);
    const route = product?.routes.find((one) => one.id === routeId);
    if (product !== undefined && route !== undefined) return { product, route };
  }
  return undefined;
}

function computed(product: AdminProductDetailResponse, sku: Sku, markupBps: number, min: string) {
  const unit = UNIT_COST[product.slug] ?? { currency: 'USDT' as const, minor: 1_000_000n };
  const costMinor = unit.minor * BigInt(sku.quantity);
  const rate = MOCK_RATES[unit.currency];
  const minMargin = BigInt(min);
  const priced = pricePreview({
    costMinor,
    costCurrency: unit.currency,
    rate,
    markupBps,
    minMarginTiyin: minMargin,
  });
  return AdminPricePreviewResponseSchema.parse({
    costCurrency: unit.currency,
    costMinor: costMinor.toString(),
    fxRate: { id: mid('fx', 1), pair: COST_FX_PAIR[unit.currency], rate },
    markupBps,
    minMarginTiyin: minMargin.toString(),
    priceTiyin: priced.priceTiyin.toString(),
    marginTiyin: priced.marginTiyin.toString(),
    belowMinMargin: priced.belowMinMargin,
  });
}

/**
 * `GET /admin/products/:id/price-preview?skuId=` (+ a proposed markup / minimum margin). The Stars
 * packages without an edit keep their fixed fixture numbers (the screen tests); a package whose
 * quantity was changed has no price until the next cost sync, like the API (`PRICE_UNAVAILABLE`).
 */
export function pricePreviewView(productId: string, query: URLSearchParams): MockReply {
  const parsed = AdminPricePreviewQuerySchema.safeParse(Object.fromEntries(query));
  if (!parsed.success || parsed.data.skuId === undefined) {
    return fail('VALIDATION_ERROR', { fields: [{ path: 'skuId', code: 'INVALID' }] });
  }
  const product = productDetailView(productId);
  const sku = product?.skus.find((one) => one.id === parsed.data.skuId);
  if (product === undefined || sku === undefined) return fail('NOT_FOUND');
  const patch = catalogOf().skus[sku.id];
  if (patch !== undefined && 'quantity' in patch) return fail('PRICE_UNAVAILABLE');
  const { markupBps, minMarginTiyin } = parsed.data;
  const proposed = markupBps !== undefined || minMarginTiyin !== undefined;
  if (product.id === mid('prod', 1) && patch === undefined && !proposed) {
    return ok(pricePreviewFixture(sku.id));
  }
  return ok(
    computed(product, sku, markupBps ?? sku.markupBps, minMarginTiyin ?? sku.minMarginTiyin),
  );
}
