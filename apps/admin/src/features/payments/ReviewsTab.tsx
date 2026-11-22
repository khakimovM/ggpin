import { PAYMENT_REVIEW_STATUSES, REVIEW_KINDS, type AdminReviewRow } from '@repo/shared';
import { FOCUS_RING, cn, type DataTableColumn } from '@repo/ui';
import { FileCheck2 } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { listReviews } from '../../lib/api/reads';
import { useDrawerParam } from '../../lib/drawer-param';
import { formatDateTime } from '../../lib/format';
import { useListParams } from '../../lib/list-params';
import { qk } from '../../lib/query-keys';
import { FilterPills } from '../common/FilterPills';
import { MoneyCell } from '../common/MoneyCell';
import { PagedTable } from '../common/PagedTable';
import { SelectFilter } from '../common/SelectFilter';
import { Tag } from '../common/Tag';
import { Toolbar } from '../common/Toolbar';
import { camelKey } from '../../lib/camel-key';

const SPEC = {
  status: { default: 'OPEN', values: PAYMENT_REVIEW_STATUSES },
  kind: { default: 'all', values: ['all', ...REVIEW_KINDS] },
} as const;

/** Bank messages that were not credited automatically and wait for the owner (D-37). */
export function ReviewsTab() {
  const t = useTranslations();
  const drawer = useDrawerParam('review');
  const { values, page, set, setPage } = useListParams(SPEC);
  const params = {
    status: values.status,
    kind: values.kind === 'all' ? undefined : values.kind,
    page,
  };
  const columns: DataTableColumn<AdminReviewRow>[] = [
    {
      id: 'date',
      header: t('admin.payments.col.date'),
      cell: (row) => (
        <button
          type="button"
          onClick={() => drawer.open(row.id)}
          className={cn('rounded-xs font-extrabold text-foreground hover:underline', FOCUS_RING)}
        >
          {formatDateTime(row.createdAt)}
        </button>
      ),
    },
    {
      id: 'kind',
      header: t('admin.payments.col.kind'),
      cell: (row) => <Tag tone="warn">{row.kind}</Tag>,
    },
    {
      id: 'why',
      header: t('admin.payments.col.reason'),
      cell: (row) => t(`admin.payments.reviewKind.${camelKey(row.kind)}`),
      className: 'text-foreground-secondary',
    },
    {
      id: 'card',
      header: t('admin.payments.col.card'),
      cell: (row) => (row.card ? `${row.card.bank} •${row.card.last4}` : '—'),
    },
    {
      id: 'amount',
      header: t('admin.payments.col.amount'),
      align: 'end',
      cell: (row) => (row.amountTiyin ? <MoneyCell tiyin={row.amountTiyin} /> : '—'),
    },
    {
      id: 'status',
      header: t('admin.payments.col.status'),
      cell: (row) => (
        <Tag tone={row.status === 'OPEN' ? 'warn' : 'ok'}>
          {row.resolution ?? t(`admin.payments.reviewStatus.${row.status}`)}
        </Tag>
      ),
    },
  ];
  return (
    <>
      <Toolbar>
        <FilterPills
          label={t('admin.payments.col.status')}
          value={values.status}
          onChange={(status) => set({ status })}
          options={PAYMENT_REVIEW_STATUSES.map((value) => ({
            value,
            label: t(`admin.payments.reviewStatus.${value}`),
          }))}
        />
        <SelectFilter
          label={t('admin.payments.col.kind')}
          value={values.kind}
          onChange={(kind) => set({ kind })}
          options={SPEC.kind.values.map((value) => ({
            value,
            label:
              value === 'all'
                ? t('admin.list.all')
                : t(`admin.payments.reviewKind.${camelKey(value)}`),
          }))}
        />
      </Toolbar>
      <PagedTable
        label={t('admin.payments.tabs.reviews')}
        queryKey={qk.payments.list('reviews', params)}
        fetch={(signal) => listReviews(params, signal)}
        columns={columns}
        rowKey={(row) => row.id}
        emptyIcon={FileCheck2}
        emptyTitle={t('admin.payments.empty.reviews')}
        onPage={setPage}
        onRowClick={(row) => drawer.open(row.id)}
        minWidth={900}
      />
    </>
  );
}
