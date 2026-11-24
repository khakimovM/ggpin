// Catalog writes of the dev mock (docs/04 «Katalog», S8a): category, product, reorder, a new
// package, a package edit and a route. Like the API: OWNER only, no code, a write that changes
// nothing writes no audit row (`auditId: null`), and the package rules (Premium months, the
// free-quantity range, no second active package of a quantity) and the full-set reorder are
// checked with the shared helpers.
import {
  AdminCategoryUpdateBodySchema,
  AdminCategoryUpdateResponseSchema,
  AdminProductReorderBodySchema,
  AdminProductReorderResponseSchema,
  AdminProductUpdateBodySchema,
  AdminProductUpdateResponseSchema,
  AdminRouteUpdateBodySchema,
  AdminRouteUpdateResponseSchema,
  AdminSkuCreateBodySchema,
  AdminSkuResponseSchema,
  AdminSkuUpdateBodySchema,
  isFullProductSet,
  packageQuantityInRange,
  premiumMonthsAllowed,
  type AdminProductDetailResponse,
} from '@repo/shared';
import {
  categoriesView,
  productDetailView,
  productRowsView,
  routeOwner,
  skuOwner,
} from './catalog-views';
import { mid } from './data-common';
import type { Journal } from './mock-journal';
import { fail, ok, type MockReply, type MockRoute } from './router';
import { fieldError, writeRoute, type WriteContext } from './write-kit';

type Sku = AdminProductDetailResponse['skus'][number];

const patch = (route: MockRoute): MockRoute => ({ ...route, method: 'PATCH' });

/** The fields of `body` (minus the reason) whose value differs from `current`. */
function changes(current: Record<string, unknown>, body: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(body).filter(([key, value]) => key !== 'reason' && current[key] !== value),
  );
}

/** Records the change in the draft and its audit row; or `auditId: null` when nothing changed. */
function applied<T>(
  context: WriteContext<object>,
  changed: Record<string, unknown>,
  write: (journal: Journal) => void,
  row: { action: string; targetType: string; targetId: string },
  answer: (journal: Journal) => T,
): MockReply {
  if (Object.keys(changed).length === 0) {
    return ok({ ...answer(context.journal), auditId: null, applied: false });
  }
  write(context.journal);
  const reason = 'reason' in context.body ? context.body.reason : undefined;
  context.audit({ ...row, reason: typeof reason === 'string' ? reason : null });
  return ok({ ...answer(context.journal), auditId: context.auditId, applied: true });
}

/** The package rules of S8a on the package as it will be (`fieldError` with the API's codes). */
function packageRule(
  product: AdminProductDetailResponse,
  next: { id: string | null; quantity: number; isActive: boolean },
  touched: { quantity: boolean; isActive: boolean },
): MockReply | null {
  if (touched.quantity && !premiumMonthsAllowed(product.slug, next.quantity)) {
    return fieldError('quantity', 'PREMIUM_MONTHS');
  }
  const switchedOn = touched.isActive && next.isActive;
  if ((touched.quantity || switchedOn) && !packageQuantityInRange(product, next.quantity)) {
    return fieldError('quantity', 'QUANTITY_RANGE');
  }
  if (!product.allowCustomQty || !next.isActive || (!touched.quantity && !touched.isActive)) {
    return null;
  }
  const twin = product.skus.some(
    (sku: Sku) => sku.id !== next.id && sku.isActive && sku.quantity === next.quantity,
  );
  return twin ? fieldError('quantity', 'DUPLICATE_PACKAGE') : null;
}

export const catalogWriteRoutes: readonly MockRoute[] = [
  patch(
    writeRoute({
      pattern: '/admin/categories/:id',
      permission: 'catalog.categoryUpdate',
      body: AdminCategoryUpdateBodySchema,
      response: AdminCategoryUpdateResponseSchema,
      run: (context) => {
        const id = context.params.id ?? '';
        const current = categoriesView(context.journal).find((one) => one.id === id);
        if (current === undefined) return fail('NOT_FOUND');
        const changed = changes(current, context.body);
        return applied(
          context,
          changed,
          (journal) => {
            journal.catalog.categories[id] = { ...journal.catalog.categories[id], ...changed };
          },
          { action: 'CATEGORY_UPDATE', targetType: 'Category', targetId: id },
          (journal) => ({ category: categoriesView(journal).find((one) => one.id === id) }),
        );
      },
    }),
  ),
  patch(
    writeRoute({
      pattern: '/admin/products/:id',
      permission: 'catalog.productUpdate',
      body: AdminProductUpdateBodySchema,
      response: AdminProductUpdateResponseSchema,
      run: (context) => {
        const id = context.params.id ?? '';
        const current = productDetailView(id, context.journal);
        if (current === undefined) return fail('NOT_FOUND');
        const changed = changes(current, context.body);
        return applied(
          context,
          changed,
          (journal) => {
            journal.catalog.products[id] = { ...journal.catalog.products[id], ...changed };
          },
          { action: 'PRODUCT_UPDATE', targetType: 'Product', targetId: id },
          (journal) => ({ product: productDetailView(id, journal) }),
        );
      },
    }),
  ),
  writeRoute({
    pattern: '/admin/products/reorder',
    permission: 'catalog.productReorder',
    body: AdminProductReorderBodySchema,
    response: AdminProductReorderResponseSchema,
    run: (context) => {
      const now = productRowsView(context.journal).map((row) => row.id);
      const asked = context.body.productIds;
      if (!isFullProductSet(now, asked)) return fieldError('productIds', 'PRODUCT_SET_MISMATCH');
      const same = now.every((id, index) => asked[index] === id);
      return applied(
        context,
        same ? {} : { order: asked },
        (journal) => {
          journal.catalog.order = [...asked];
        },
        { action: 'PRODUCT_REORDER', targetType: 'Catalog', targetId: 'products' },
        (journal) => ({
          products: productRowsView(journal).map((row) => ({ id: row.id, sort: row.sort })),
        }),
      );
    },
  }),
  writeRoute({
    pattern: '/admin/products/:id/skus',
    permission: 'catalog.skuCreate',
    body: AdminSkuCreateBodySchema,
    response: AdminSkuResponseSchema,
    run: (context) => {
      const productId = context.params.id ?? '';
      const product = productDetailView(productId, context.journal);
      if (product === undefined) return fail('NOT_FOUND');
      const { reason: _reason, ...fields } = context.body;
      const refused = packageRule(
        product,
        { id: null, quantity: fields.quantity, isActive: fields.isActive },
        { quantity: true, isActive: true },
      );
      if (refused !== null) return refused;
      const made = Object.values(context.journal.catalog.newSkus).flat().length;
      const sku = { id: mid('skunew', made + 1), tab: null, supplierSku: null, ...fields };
      context.journal.catalog.newSkus[productId] = [
        ...(context.journal.catalog.newSkus[productId] ?? []),
        sku,
      ];
      context.audit({
        action: 'SKU_CREATE',
        targetType: 'Product',
        targetId: productId,
        reason: context.body.reason ?? null,
      });
      return ok({ sku, auditId: context.auditId, applied: true });
    },
  }),
  patch(
    writeRoute({
      pattern: '/admin/skus/:id',
      permission: 'catalog.skuUpdate',
      body: AdminSkuUpdateBodySchema,
      response: AdminSkuResponseSchema,
      run: (context) => {
        const id = context.params.id ?? '';
        const owner = skuOwner(id, context.journal);
        if (owner === undefined) return fail('NOT_FOUND');
        const changed = changes(owner.sku, context.body);
        const next = { ...owner.sku, ...changed };
        const refused = packageRule(owner.product, next, {
          quantity: 'quantity' in changed,
          isActive: 'isActive' in changed,
        });
        if (refused !== null) return refused;
        return applied(
          context,
          changed,
          (journal) => {
            journal.catalog.skus[id] = { ...journal.catalog.skus[id], ...changed };
          },
          { action: 'SKU_UPDATE', targetType: 'Sku', targetId: id },
          (journal) => ({ sku: skuOwner(id, journal)?.sku }),
        );
      },
    }),
  ),
  patch(
    writeRoute({
      pattern: '/admin/routes/:id',
      permission: 'catalog.routeUpdate',
      body: AdminRouteUpdateBodySchema,
      response: AdminRouteUpdateResponseSchema,
      run: (context) => {
        const id = context.params.id ?? '';
        const owner = routeOwner(id, context.journal);
        if (owner === undefined) return fail('NOT_FOUND');
        const changed = changes(owner.route, context.body);
        return applied(
          context,
          changed,
          (journal) => {
            journal.catalog.routes[id] = { ...journal.catalog.routes[id], ...changed };
          },
          { action: 'ROUTE_UPDATE', targetType: 'ProductRoute', targetId: id },
          (journal) => ({ route: routeOwner(id, journal)?.route }),
        );
      },
    }),
  ),
];
