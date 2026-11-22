import type { DataTableState } from '@repo/ui';

interface QueryLike {
  isPending: boolean;
  isError: boolean;
}

/**
 * The view state of a list query. A failed refetch with rows already on screen keeps the rows
 * (TanStack keeps `data`); only a first load that failed shows the error state.
 */
export function tableState(query: QueryLike, rowCount: number | undefined): DataTableState {
  if (rowCount !== undefined) return rowCount === 0 ? 'empty' : 'data';
  if (query.isError) return 'error';
  return 'loading';
}
