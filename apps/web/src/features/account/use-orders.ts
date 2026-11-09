'use client';

import type { OrderDto, PageMeta } from '@repo/shared';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useLocale } from 'next-intl';
import { listOrders } from '../../lib/api/orders';
import { qk } from '../../lib/query-keys';
import { infiniteFeed, pageFeed, type Feed } from './history-feed';
import { statusesOf, type OrderFilter } from './order-filters';

export const HISTORY_PAGE_SIZE = 20;
const STALE_MS = 15_000;

export interface OrdersPage {
  items: OrderDto[];
  meta: PageMeta;
}

/**
 * `GET /orders` for the history. `status` is the chip's group of raw statuses (one request per
 * chip); the locale is part of the key because every row carries the product name in it.
 *
 * Both list styles are declared and the one the screen does not use is disabled: the Mini App
 * appends pages (`tg`), the web store shows one numbered page (`web`).
 */
export function useOrdersFeed(
  variant: 'tg' | 'web',
  filter: OrderFilter,
  page: number,
): Feed<OrderDto> {
  const locale = useLocale() === 'ru' ? 'ru' : 'uz';
  const status = statusesOf(filter);
  const base = { status, locale, limit: HISTORY_PAGE_SIZE } as const;
  const infinite = useInfiniteQuery({
    queryKey: qk.orders.infinite(base),
    queryFn: ({ pageParam, signal }) => listOrders({ ...base, page: pageParam }, signal),
    initialPageParam: 1,
    getNextPageParam: ({ meta }) =>
      meta.page * meta.limit < meta.total ? meta.page + 1 : undefined,
    staleTime: STALE_MS,
    enabled: variant === 'tg',
  });
  const paged = useQuery({
    queryKey: qk.orders.list({ ...base, page }),
    queryFn: ({ signal }) => listOrders({ ...base, page }, signal),
    placeholderData: keepPreviousData,
    staleTime: STALE_MS,
    enabled: variant === 'web',
  });
  return variant === 'tg' ? infiniteFeed(infinite) : pageFeed(paged);
}
