import type { AdminOrderDetailResponse, OrderStatus } from '@repo/shared';
import { DataTable, Timeline, type DataTableColumn, type TimelineTone } from '@repo/ui';
import { History } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { formatDateTime, formatMinor, shortHash } from '../../lib/format';
import { ListEmpty } from '../common/ListStates';
import { MoneyCell } from '../common/MoneyCell';
import { Panel } from '../common/Panel';
import { Tag } from '../common/Tag';

type Order = AdminOrderDetailResponse;
type Attempt = Order['attempts'][number];
type Entry = Order['ledger'][number];

const TONE: Partial<Record<OrderStatus, TimelineTone>> = {
  NEEDS_REVIEW: 'warning',
  HELD: 'warning',
  FAILED: 'danger',
  CANCELLED: 'muted',
  REFUNDED: 'refund',
};

/** Timeline, fulfilment attempts and ledger entries of one order (AdminOps.dc.html `order`). */
export function OrderHistory({ order }: { order: Order }) {
  const t = useTranslations();
  const last = order.events.length - 1;
  const attempts: DataTableColumn<Attempt>[] = [
    { id: 'no', header: '#', cell: (a) => a.attemptNo },
    {
      id: 'adapter',
      header: t('admin.orders.col.adapter'),
      cell: (a) => a.adapter,
      className: 'font-mono text-[11px]',
    },
    {
      id: 'status',
      header: t('admin.orders.col.status'),
      cell: (a) => (
        <Tag
          tone={
            a.status === 'CONFIRMED'
              ? 'ok'
              : a.status === 'FAILED' || a.status === 'UNKNOWN'
                ? 'bad'
                : 'info'
          }
        >
          {a.status}
        </Tag>
      ),
    },
    {
      id: 'ref',
      header: t('admin.orders.detail.externalRef'),
      cell: (a) => a.externalRef ?? '—',
      className: 'font-mono text-[11px]',
    },
    {
      id: 'error',
      header: t('admin.orders.detail.error'),
      cell: (a) => a.error ?? '—',
      className: 'text-danger-text',
    },
    { id: 'time', header: t('admin.orders.col.date'), cell: (a) => formatDateTime(a.createdAt) },
  ];
  const ledger: DataTableColumn<Entry>[] = [
    { id: 'time', header: t('admin.ledger.col.date'), cell: (e) => formatDateTime(e.createdAt) },
    {
      id: 'kind',
      header: t('admin.ledger.col.kind'),
      cell: (e) => <Tag tone="mute">{e.kind}</Tag>,
    },
    {
      id: 'ref',
      header: t('admin.ledger.col.ref'),
      cell: (e) => e.refType,
      className: 'font-mono text-[11px]',
    },
    {
      id: 'amount',
      header: t('admin.ledger.col.amount'),
      align: 'end',
      cell: (e) => <MoneyCell tiyin={e.amountTiyin} signed />,
    },
  ];
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Panel title={t('admin.orders.detail.timeline')}>
        <Timeline
          ariaLabel={t('admin.orders.detail.timeline')}
          stateLabels={{
            done: t('admin.orders.detail.stepDone'),
            active: t('admin.orders.detail.stepCurrent'),
            pending: t('admin.orders.detail.stepPending'),
          }}
          currentLabel={t('admin.orders.detail.stepCurrent')}
          items={order.events.map((event, index) => ({
            id: `${index}`,
            state: index === last ? 'active' : 'done',
            tone: index === last ? TONE[event.to] : undefined,
            title: `${event.to} · ${event.actor}`,
            description: [formatDateTime(event.createdAt), event.note].filter(Boolean).join(' · '),
          }))}
        />
      </Panel>
      <Panel title={t('admin.orders.detail.attempts')}>
        <DataTable
          label={t('admin.orders.detail.attempts')}
          columns={attempts}
          rows={order.attempts}
          rowKey={(a) => a.id}
          state={order.attempts.length === 0 ? 'empty' : 'data'}
          framed={false}
          minWidth={640}
          loadingLabel={t('admin.states.loading')}
          empty={<ListEmpty icon={History} title={t('admin.orders.detail.noAttempts')} />}
        />
        {order.tonTransfers.map((transfer) => (
          <p
            key={transfer.id}
            className="m-0 rounded-[10px] bg-surface px-3 py-2 font-mono text-[11px] leading-4 break-all"
          >
            TON {transfer.status} · {formatMinor('TON', transfer.amountNanoTon)} TON · seqno{' '}
            {transfer.seqno}
            {transfer.txHash ? ` · tx ${shortHash(transfer.txHash)}` : ''}
          </p>
        ))}
      </Panel>
      <Panel title={t('admin.orders.detail.ledger')}>
        <DataTable
          label={t('admin.orders.detail.ledger')}
          columns={ledger}
          rows={order.ledger}
          rowKey={(e) => e.id}
          state={order.ledger.length === 0 ? 'empty' : 'data'}
          framed={false}
          loadingLabel={t('admin.states.loading')}
          empty={<ListEmpty icon={History} title={t('admin.orders.detail.noLedger')} />}
        />
      </Panel>
    </div>
  );
}
