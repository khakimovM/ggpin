'use client';

import type { LedgerItem } from '@repo/shared';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { getLedger } from '../../lib/api/me';
import { qk } from '../../lib/query-keys';
import { infiniteFeed, pageFeed, type Feed } from './history-feed';
import { HISTORY_PAGE_SIZE } from './use-orders';

const STALE_MS = 15_000;

/**
 * `GET /me/ledger` (newest first) for the "Moliya" tab; the panel is mounted only while that tab is open.
 */
export function useLedgerFeed(variant: 'tg' | 'web', page: number): Feed<LedgerItem> {
  const base = { limit: HISTORY_PAGE_SIZE } as const;
  const infinite = useInfiniteQuery({
    queryKey: qk.wallet.ledgerInfinite(base),
    queryFn: ({ pageParam, signal }) => getLedger({ ...base, page: pageParam }, signal),
    initialPageParam: 1,
    getNextPageParam: ({ meta }) =>
      meta.page * meta.limit < meta.total ? meta.page + 1 : undefined,
    staleTime: STALE_MS,
    enabled: variant === 'tg',
  });
  const paged = useQuery({
    queryKey: qk.wallet.ledger({ ...base, page }),
    queryFn: ({ signal }) => getLedger({ ...base, page }, signal),
    placeholderData: keepPreviousData,
    staleTime: STALE_MS,
    enabled: variant === 'web',
  });
  return variant === 'tg' ? infiniteFeed(infinite) : pageFeed(paged);
}
