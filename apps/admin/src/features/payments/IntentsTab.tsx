import { INTENT_STATUSES, type AdminIntentListResponse } from '@repo/shared';
import type { DataTableColumn } from '@repo/ui';
import { Receipt } from 'lucide-react';
import { Link } from 'react-router';
import { useTranslations } from 'use-intl';
import { listIntents } from '../../lib/api/reads';
import { DATE_PRESETS, fromOfPreset } from '../../lib/date-range';
import { formatDateTime } from '../../lib/format';
import { useListParams } from '../../lib/list-params';
import { qk } from '../../lib/query-keys';
import { FilterPills } from '../common/FilterPills';
import { MoneyCell } from '../common/MoneyCell';
import { PagedTable } from '../common/PagedTable';
import { SelectFilter } from '../common/SelectFilter';
import { Tag, type TagTone } from '../common/Tag';
import { Toolbar } from '../common/Toolbar';
import { ROW_LINK } from '../common/link-style';

type AdminIntentRow = AdminIntentListResponse[number];
type IntentStatus = AdminIntentRow['status'];

const TONE: Record<IntentStatus, TagTone> = {
  PENDING: 'warn',
  PAID: 'ok',
  CANCELLED: 'mute',
  EXPIRED: 'mute',
};

const SPEC = {
  status: { default: 'all', values: ['all', ...INTENT_STATUSES] },
  date: { default: 'all', values: DATE_PRESETS },
} as const;

/** Top-up requests (P2P intents): the unique amount a user was asked to send to our card. */
export function IntentsTab() {
  const t = useTranslations();
  const { values, page, set, setPage } = useListParams(SPEC);
  const params = {
    status: values.status === 'all' ? undefined : values.status,
    from: fromOfPreset(values.date, new Date()),
    page,
  };
  const columns: DataTableColumn<AdminIntentRow>[] = [
    {
      id: 'date',
      header: t('admin.payments.col.date'),
      cell: (row) => formatDateTime(row.createdAt),
    },
    {
      id: 'id',
      header: t('admin.list.col.id'),
      cell: (row) => row.id,
      className: 'font-mono text-[11px]',
    },
    {
      id: 'user',
      header: t('admin.payments.col.user'),
      cell: (row) => (
        <Link to={`/users/${row.userId}`} className={ROW_LINK}>
          {row.userId}
        </Link>
      ),
      className: 'font-mono text-[11px]',
    },
    {
      id: 'card',
      header: t('admin.payments.col.card'),
      cell: (row) => (row.card ? `${row.card.bank} •${row.card.last4}` : '—'),
    },
    {
      id: 'amount',
      header: t('admin.payments.col.uniqueAmount'),
      align: 'end',
      cell: (row) => <MoneyCell tiyin={row.amountTiyin} />,
    },
    {
      id: 'expires',
      header: t('admin.payments.col.expires'),
      cell: (row) => formatDateTime(row.expiresAt),
      className: 'text-foreground-secondary',
    },
    {
      id: 'status',
      header: t('admin.payments.col.status'),
      cell: (row) => <Tag tone={TONE[row.status]}>{row.status}</Tag>,
    },
  ];
  return (
    <>
      <Toolbar>
        <FilterPills
          label={t('admin.payments.col.status')}
          value={values.status}
          onChange={(status) => set({ status })}
          options={SPEC.status.values.map((value) => ({
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
      </Toolbar>
      <PagedTable
        label={t('admin.payments.tabs.intents')}
        queryKey={qk.payments.list('intents', { ...params, from: values.date })}
        fetch={(signal) => listIntents(params, signal)}
        columns={columns}
        rowKey={(row) => row.id}
        emptyIcon={Receipt}
        emptyTitle={t('admin.payments.empty.intents')}
        onPage={setPage}
        minWidth={960}
      />
    </>
  );
}
