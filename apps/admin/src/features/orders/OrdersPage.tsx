import type { AdminOrderRow } from '@repo/shared';
import { DataTable, type DataTableColumn } from '@repo/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ShoppingBag } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { useTranslations } from 'use-intl';
import { listOrders } from '../../lib/api/people';
import { DATE_PRESETS, fromOfPreset } from '../../lib/date-range';
import { formatCost, formatDateTime } from '../../lib/format';
import { useListParams } from '../../lib/list-params';
import { qk } from '../../lib/query-keys';
import { ClearFilters } from '../common/ClearFilters';
import { FilterPills } from '../common/FilterPills';
import { ListEmpty, LoadError } from '../common/ListStates';
import { MockNote } from '../common/MockNote';
import { MoneyCell } from '../common/MoneyCell';
import { OrderStatusTag } from '../common/OrderStatusTag';
import { PageHeader } from '../common/PageHeader';
import { Pager } from '../common/Pager';
import { SearchField } from '../common/SearchField';
import { SectionGate } from '../common/SectionGate';
import { SelectFilter } from '../common/SelectFilter';
import { tableState } from '../common/table-state';
import { Toolbar } from '../common/Toolbar';
import { ROW_LINK } from '../common/link-style';

// The design's status pills: the operator's usual views, each one API status filter.
const STATUS_VIEWS = ['all', 'NEEDS_REVIEW', 'PROCESSING', 'DELIVERED', 'FAILED'] as const;

const SPEC = {
  status: { default: 'all', values: STATUS_VIEWS },
  date: { default: 'all', values: DATE_PRESETS },
  q: { default: '', maxLength: 64 },
} as const;

function Orders() {
  const t = useTranslations();
  const navigate = useNavigate();
  const { values, page, set, setPage, reset } = useListParams(SPEC);
  const params = {
    status: values.status === 'all' ? undefined : values.status,
    from: fromOfPreset(values.date, new Date()),
    q: values.q || undefined,
    page,
  };
  const query = useQuery({
    queryKey: qk.orders.list({ ...params, from: values.date }),
    queryFn: ({ signal }) => listOrders(params, signal),
    placeholderData: keepPreviousData,
  });
  const columns: DataTableColumn<AdminOrderRow>[] = [
    {
      id: 'n',
      header: '#',
      cell: (o) => (
        <Link to={`/orders/${o.id}`} className={ROW_LINK}>
          #{o.number}
        </Link>
      ),
    },
    {
      id: 'date',
      header: t('admin.orders.col.date'),
      cell: (o) => formatDateTime(o.createdAt),
      className: 'whitespace-nowrap',
    },
    {
      id: 'user',
      header: t('admin.orders.col.user'),
      cell: (o) => (o.user.username ? `@${o.user.username}` : o.user.id),
    },
    {
      id: 'product',
      header: t('admin.orders.col.product'),
      cell: (o) => [o.product.name, o.sku?.label].filter(Boolean).join(' · '),
    },
    {
      id: 'recipient',
      header: t('admin.orders.col.recipient'),
      cell: (o) => o.recipient.displayName ?? '—',
      className: 'text-foreground-secondary',
    },
    {
      id: 'price',
      header: t('admin.orders.col.price'),
      align: 'end',
      cell: (o) => <MoneyCell tiyin={o.totalTiyin} bare />,
    },
    {
      id: 'cost',
      header: t('admin.orders.col.cost'),
      align: 'end',
      cell: (o) => formatCost(o.costCurrency, o.costMinor),
      className: 'text-foreground-secondary whitespace-nowrap',
    },
    {
      id: 'profit',
      header: t('admin.orders.col.profit'),
      align: 'end',
      cell: (o) => (o.profitTiyin === null ? '—' : <MoneyCell tiyin={o.profitTiyin} bare />),
    },
    {
      id: 'status',
      header: t('admin.orders.col.status'),
      cell: (o) => <OrderStatusTag status={o.status} />,
    },
    {
      id: 'adapter',
      header: t('admin.orders.col.adapter'),
      cell: (o) => o.adapter ?? '—',
      className: 'font-mono text-[11px]',
    },
  ];
  const rows = query.data?.items;
  return (
    <>
      <PageHeader title={t('admin.nav.orders')} />
      <MockNote />
      <Toolbar>
        <FilterPills
          label={t('admin.orders.col.status')}
          value={values.status}
          onChange={(status) => set({ status })}
          options={STATUS_VIEWS.map((value) => ({
            value,
            label: value === 'all' ? t('admin.list.all') : value,
          }))}
        />
        <SelectFilter
          label={t('admin.list.date.label')}
          value={values.date}
          onChange={(date) => set({ date })}
          options={DATE_PRESETS.map((value) => ({ value, label: t(`admin.list.date.${value}`) }))}
        />
        <span className="ml-auto max-sm:w-full">
          <SearchField
            label={t('admin.orders.search')}
            placeholder={t('admin.orders.searchPlaceholder')}
            value={values.q}
            onChange={(q) => set({ q })}
          />
        </span>
      </Toolbar>
      <DataTable
        label={t('admin.nav.orders')}
        columns={columns}
        rows={rows ?? []}
        rowKey={(o) => o.id}
        state={tableState(query, rows?.length)}
        minWidth={1080}
        onRowClick={(o) => void navigate(`/orders/${o.id}`)}
        loadingLabel={t('admin.states.loading')}
        empty={
          <ListEmpty
            icon={ShoppingBag}
            title={t('admin.orders.empty')}
            description={t('admin.list.emptyFiltered')}
            action={<ClearFilters onClear={reset} />}
          />
        }
        error={
          <LoadError
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        }
        footer={query.data ? <Pager meta={query.data.meta} onPage={setPage} /> : null}
      />
    </>
  );
}

export function OrdersPage() {
  const t = useTranslations();
  return (
    <SectionGate permission="orders.read" title={t('admin.nav.orders')}>
      <Orders />
    </SectionGate>
  );
}
