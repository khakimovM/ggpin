'use client';

import type { CatalogListMeta, CatalogProductListItem } from '@repo/shared';
import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useLocale } from 'next-intl';
import { getProducts } from '../../lib/api/catalog';
import { qk } from '../../lib/query-keys';

// The catalog is a handful of products: one page of the API maximum shows all of them, grouped
// by category on the client. (A paging UI arrives when the catalog outgrows it.)
export const CATALOG_PAGE_SIZE = 100;
const PRODUCTS_STALE_MS = 60_000;

export interface ProductsFilter {
  /** Category slug; ignored while a search text is given (a search covers the whole catalog). */
  category?: string;
  /** Already sanitised (see sanitizeSearch); empty or undefined means no search. */
  q?: string;
  page?: number;
}

/** Products for the current language, always asked with `locale`. Public data. */
export function useProducts({
  category,
  q,
  page = 1,
}: ProductsFilter): UseQueryResult<{ items: CatalogProductListItem[]; meta: CatalogListMeta }> {
  const locale = useLocale();
  const search = q === undefined || q === '' ? undefined : q;
  const params = {
    locale,
    page,
    limit: CATALOG_PAGE_SIZE,
    ...(search === undefined ? (category === undefined ? {} : { category }) : { q: search }),
  };
  return useQuery({
    queryKey: qk.catalog.products(params),
    queryFn: ({ signal }) => getProducts(params, signal),
    staleTime: PRODUCTS_STALE_MS,
    // While a new filter loads, the previous grid stays on screen instead of a skeleton flash.
    placeholderData: keepPreviousData,
  });
}
