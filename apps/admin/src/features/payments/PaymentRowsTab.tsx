import { PAYMENT_STATUSES, type AdminPaymentRow } from '@repo/shared';
import { FOCUS_RING, cn, type DataTableColumn } from '@repo/ui';
import { Banknote } from 'lucide-react';
import { Link } from 'react-router';
import { useTranslations } from 'use-intl';
import { listPayments } from '../../lib/api/reads';
import { DATE_PRESETS, fromOfPreset } from '../../lib/date-range';
import { useDrawerParam } from '../../lib/drawer-param';
import { formatDateTime } from '../../lib/format';
import { useListParams } from '../../lib/list-params';
import { qk } from '../../lib/query-keys';
import { FilterPills } from '../common/FilterPills';
import { MoneyCell } from '../common/MoneyCell';
import { PagedTable } from '../common/PagedTable';
import { PaymentStatusTag } from '../common/PaymentStatusTag';
import { SelectFilter } from '../common/SelectFilter';
import { Toolbar } from '../common/Toolbar';
import { ROW_LINK, TEXT_LINK } from '../common/link-style';
import { PaymentActionCell } from './PaymentActionCell';

const SPEC = {
  status: { default: 'all', values: ['all', ...PAYMENT_STATUSES] },
  date: { default: 'all', values: DATE_PRESETS },
} as const;

/** Credited (or cancelled) top-ups: one row per Payment, with its bank message. */
export function PaymentRowsTab() {
  const t = useTranslations();
  const message = useDrawerParam('message');
  const { values, page, set, setPage } = useListParams(SPEC);
  const params = {
    status: values.status === 'all' ? undefined : values.status,
    from: fromOfPreset(values.date, new Date()),
    page,
  };
  const columns: DataTableColumn<AdminPaymentRow>[] = [
    {
      id: 'date',
      header: t('admin.payments.col.date'),
      cell: (row) => formatDateTime(row.createdAt),
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
      id: 'amount',
      header: t('admin.payments.col.amount'),
      align: 'end',
      cell: (row) => <MoneyCell tiyin={row.amountTiyin} />,
    },
    {
      id: 'status',
      header: t('admin.payments.col.status'),
      cell: (row) => <PaymentStatusTag status={row.status} />,
    },
    {
      id: 'message',
      header: t('admin.payments.col.message'),
      cell: (row) =>
        row.bankMessageId ? (
          <button
            type="button"
            onClick={() => message.open(row.bankMessageId ?? '')}
            className={cn(TEXT_LINK, FOCUS_RING)}
          >
            {t('admin.payments.openMessage')}
          </button>
        ) : (
          '—'
        ),
    },
    {
      id: 'actions',
      header: <span className="sr-only">{t('admin.list.actions')}</span>,
      align: 'end',
      cell: (row) => <PaymentActionCell payment={row} />,
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
            label:
              value === 'all' ? t('admin.list.all') : t(`admin.payments.paymentStatus.${value}`),
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
        label={t('admin.payments.tabs.payments')}
        queryKey={qk.payments.list('payments', { ...params, from: values.date })}
        fetch={(signal) => listPayments(params, signal)}
        columns={columns}
        rowKey={(row) => row.id}
        emptyIcon={Banknote}
        emptyTitle={t('admin.payments.empty.payments')}
        onPage={setPage}
        minWidth={820}
      />
    </>
  );
}
