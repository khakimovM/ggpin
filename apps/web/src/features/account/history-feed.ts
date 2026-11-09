import type { PageMeta } from '@repo/shared';
import type { InfiniteData, UseInfiniteQueryResult, UseQueryResult } from '@tanstack/react-query';

// One shape for both list styles of the history: the Mini App appends pages ("Yana yuklash"), the
// web store shows one numbered page at a time. The panels read this, so they do not care which.

interface Page<T> {
  items: T[];
  meta: PageMeta;
}

export interface Feed<T> {
  /** `pending`: first load; `error`: nothing to show and the load failed; `ready`: rows (maybe none). */
  status: 'pending' | 'error' | 'ready';
  items: T[];
  total: number;
  page: number;
  limit: number;
  /** A refetch or a page change is running (the previous rows stay on screen). */
  fetching: boolean;
  refetch: () => void;
  hasMore: boolean;
  loadMore: () => void;
  loadingMore: boolean;
  /** Appending the next page failed; the rows already loaded stay. */
  moreFailed: boolean;
}

const NONE = { total: 0, page: 1, limit: 20 } as const;

/**
 * Pages are cut by offset, so a row written between two loads shifts the next page and shows up
 * twice (the newest entry again at the top of page 2). Every row has a server id: the first one
 * seen wins, so the list never repeats a row or a React key.
 */
function uniqueById<T extends { id: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

export function infiniteFeed<T extends { id: string }>(
  query: UseInfiniteQueryResult<InfiniteData<Page<T>, unknown>>,
): Feed<T> {
  const pages = query.data?.pages ?? [];
  const last = pages[pages.length - 1];
  const items = uniqueById(pages.flatMap((entry) => entry.items));
  return {
    status: query.data !== undefined ? 'ready' : query.isError ? 'error' : 'pending',
    items,
    total: last?.meta.total ?? NONE.total,
    page: last?.meta.page ?? NONE.page,
    limit: last?.meta.limit ?? NONE.limit,
    fetching: query.isFetching && !query.isFetchingNextPage,
    refetch: () => void query.refetch(),
    hasMore: query.hasNextPage,
    loadMore: () => void query.fetchNextPage(),
    loadingMore: query.isFetchingNextPage,
    moreFailed: query.isFetchNextPageError,
  };
}

export function pageFeed<T extends { id: string }>(query: UseQueryResult<Page<T>>): Feed<T> {
  const data = query.data;
  return {
    status: data !== undefined ? 'ready' : query.isError ? 'error' : 'pending',
    items: data?.items ?? [],
    total: data?.meta.total ?? NONE.total,
    page: data?.meta.page ?? NONE.page,
    limit: data?.meta.limit ?? NONE.limit,
    fetching: query.isFetching,
    refetch: () => void query.refetch(),
    hasMore: false,
    loadMore: () => undefined,
    loadingMore: false,
    moreFailed: false,
  };
}
