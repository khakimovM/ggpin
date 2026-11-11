'use client';

import type { CatalogCategory } from '@repo/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useLocale } from 'next-intl';
import { getCategories } from '../../lib/api/catalog';
import { qk } from '../../lib/query-keys';

const CATEGORIES_STALE_MS = 5 * 60_000;

/** The categories that have a product, in the language of the screen. Public data. */
export function useCategories(): UseQueryResult<CatalogCategory[]> {
  const locale = useLocale();
  return useQuery({
    queryKey: qk.catalog.categories(locale),
    queryFn: ({ signal }) => getCategories(locale, signal),
    staleTime: CATEGORIES_STALE_MS,
  });
}
