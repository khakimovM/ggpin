'use client';

import type { OrderDetail } from '@repo/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useLocale } from 'next-intl';
import { getOrder } from '../../lib/api/orders';
import { qk } from '../../lib/query-keys';
import { orderPollInterval } from './order-status';

/**
 * `GET /orders/:id`, asked again every two seconds while the order can still change by itself and
 * never once it has settled. TanStack pauses the interval while the page is hidden
 * (`refetchIntervalInBackground` is off) and a refetch on return catches up. No SSE: polling is
 * enough, and it works the same in the Mini App webview.
 */
export function useOrder(id: string): UseQueryResult<OrderDetail> {
  const locale = useLocale();
  return useQuery({
    queryKey: qk.orders.detail(id, locale),
    queryFn: ({ signal }) => getOrder(id, locale, signal),
    refetchInterval: (query) => orderPollInterval(query.state.data?.status),
    // A settled order does not change; an active one is kept fresh by the interval.
    staleTime: 0,
  });
}
