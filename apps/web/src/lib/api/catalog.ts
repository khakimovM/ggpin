import {
  CatalogCategorySchema,
  CatalogProductDetailSchema,
  CatalogProductListItemSchema,
  type CatalogCategory,
  type CatalogListMeta,
  type CatalogProductDetail,
  type CatalogProductListItem,
  type Locale,
} from '@repo/shared';
import { apiFetch, apiFetchList } from './client';
import { resourceId } from './path';

// The catalog is public (`@PublicCache`): no cookie, no token, and the HTTP cache may serve it
// (`cache: 'default'`; every other request defaults to `no-store`).

export interface ProductListParams {
  category?: string;
  q?: string;
  locale: Locale;
  page?: number;
  limit?: number;
}

export function getCategories(locale: Locale, signal?: AbortSignal): Promise<CatalogCategory[]> {
  return apiFetch(
    {
      path: '/catalog/categories',
      query: { locale },
      session: 'anonymous',
      cache: 'default',
      signal,
    },
    CatalogCategorySchema.array(),
  );
}

export function getProducts(
  params: ProductListParams,
  signal?: AbortSignal,
): Promise<{ items: CatalogProductListItem[]; meta: CatalogListMeta }> {
  const { category, q, locale, page, limit } = params;
  return apiFetchList(
    {
      path: '/catalog/products',
      query: { category, q, locale, page, limit },
      session: 'anonymous',
      cache: 'default',
      signal,
    },
    CatalogProductListItemSchema,
  );
}

export async function getProduct(
  slug: string,
  locale: Locale,
  signal?: AbortSignal,
): Promise<CatalogProductDetail> {
  return apiFetch(
    {
      path: `/catalog/products/${resourceId(slug)}`,
      query: { locale },
      session: 'anonymous',
      cache: 'default',
      signal,
    },
    CatalogProductDetailSchema,
  );
}
