// Catalog writes (docs/04 «Katalog», plan S8b, D-63 (8)): OWNER only, no step-up code. Every one
// carries the registry's Idempotency-Key (the CSRF header is added by http.ts); the bodies come
// from the editors' builders and are typed by the shared schemas.
import {
  AdminCategoryUpdateResponseSchema,
  AdminProductReorderResponseSchema,
  AdminProductUpdateResponseSchema,
  AdminRouteUpdateResponseSchema,
  AdminSkuResponseSchema,
  type AdminCategoryUpdateBody,
  type AdminProductReorderBody,
  type AdminProductUpdateBody,
  type AdminRouteUpdateBody,
  type AdminSkuCreateBody,
  type AdminSkuUpdateBody,
} from '@repo/shared';
import { apiFetch } from './client';

const id = (value: string) => encodeURIComponent(value);

/** The audit row's target of a reorder (the API writes `Catalog/products`). */
export const REORDER_TARGET_ID = 'products';

export const updateCategory = (
  categoryId: string,
  body: AdminCategoryUpdateBody,
  idempotencyKey: string,
) =>
  apiFetch(
    {
      method: 'PATCH',
      path: `/admin/categories/${id(categoryId)}`,
      body,
      idempotencyKey,
      group: 'catalog',
    },
    AdminCategoryUpdateResponseSchema,
  );

export const updateProduct = (
  productId: string,
  body: AdminProductUpdateBody,
  idempotencyKey: string,
) =>
  apiFetch(
    {
      method: 'PATCH',
      path: `/admin/products/${id(productId)}`,
      body,
      idempotencyKey,
      group: 'catalog',
    },
    AdminProductUpdateResponseSchema,
  );

export const reorderProducts = (body: AdminProductReorderBody, idempotencyKey: string) =>
  apiFetch(
    {
      method: 'POST',
      path: '/admin/products/reorder',
      body,
      idempotencyKey,
      group: 'catalog',
    },
    AdminProductReorderResponseSchema,
  );

export const createSku = (productId: string, body: AdminSkuCreateBody, idempotencyKey: string) =>
  apiFetch(
    {
      method: 'POST',
      path: `/admin/products/${id(productId)}/skus`,
      body,
      idempotencyKey,
      group: 'catalog',
    },
    AdminSkuResponseSchema,
  );

export const updateSku = (skuId: string, body: AdminSkuUpdateBody, idempotencyKey: string) =>
  apiFetch(
    {
      method: 'PATCH',
      path: `/admin/skus/${id(skuId)}`,
      body,
      idempotencyKey,
      group: 'catalog',
    },
    AdminSkuResponseSchema,
  );

export const updateRoute = (routeId: string, body: AdminRouteUpdateBody, idempotencyKey: string) =>
  apiFetch(
    {
      method: 'PATCH',
      path: `/admin/routes/${id(routeId)}`,
      body,
      idempotencyKey,
      group: 'catalog',
    },
    AdminRouteUpdateResponseSchema,
  );
