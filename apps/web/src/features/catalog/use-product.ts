'use client';

import type { CatalogProductDetail } from '@repo/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useLocale } from 'next-intl';
import { getProduct } from '../../lib/api/catalog';
import { qk } from '../../lib/query-keys';

/** One product with its SKUs, in the language of the screen (used by the product page, S6). */
export function useProduct(slug: string): UseQueryResult<CatalogProductDetail> {
  const locale = useLocale();
  return useQuery({
    queryKey: qk.catalog.product(slug, locale),
    queryFn: ({ signal }) => getProduct(slug, locale, signal),
    staleTime: 60_000,
  });
}
