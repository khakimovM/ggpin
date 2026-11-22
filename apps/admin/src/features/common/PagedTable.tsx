import type { PageMeta } from '@repo/shared';
import { DataTable, type DataTableColumn } from '@repo/ui';
import { keepPreviousData, useQuery, type QueryKey } from '@tanstack/react-query';
import type { LucideIcon } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { ListEmpty, LoadError } from '../common/ListStates';
import { Pager } from '../common/Pager';
import { tableState } from '../common/table-state';

interface Props<Row> {
  label: string;
  queryKey: QueryKey;
  fetch: (signal: AbortSignal) => Promise<{ items: Row[]; meta: PageMeta }>;
  columns: readonly DataTableColumn<Row>[];
  rowKey: (row: Row) => string;
  emptyIcon: LucideIcon;
  emptyTitle: string;
  onPage: (page: number, options?: { replace?: boolean }) => void;
  minWidth?: number;
  onRowClick?: (row: Row) => void;
  framed?: boolean;
}

/** One paginated list with its four states (the tabs of a user, the payment lists). */
export function PagedTable<Row>({
  label,
  queryKey,
  fetch,
  columns,
  rowKey,
  emptyIcon,
  emptyTitle,
  onPage,
  minWidth,
  onRowClick,
  framed = true,
}: Props<Row>) {
  const t = useTranslations();
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => fetch(signal),
    placeholderData: keepPreviousData,
  });
  return (
    <DataTable
      label={label}
      columns={columns}
      rows={query.data?.items ?? []}
      rowKey={rowKey}
      state={tableState(query, query.data?.items.length)}
      minWidth={minWidth}
      onRowClick={onRowClick}
      framed={framed}
      loadingLabel={t('admin.states.loading')}
      empty={<ListEmpty icon={emptyIcon} title={emptyTitle} />}
      error={
        <LoadError
          error={query.error}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      }
      footer={
        query.data && query.data.meta.total > 0 ? (
          <Pager meta={query.data.meta} onPage={onPage} />
        ) : null
      }
    />
  );
}
