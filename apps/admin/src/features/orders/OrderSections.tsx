import type { AdminOrderDetailResponse, OrderStatus } from '@repo/shared';
import { DataTable, Timeline, type DataTableColumn, type TimelineTone } from '@repo/ui';
import { History } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { formatDateTime, formatMinor, shortHash } from '../../lib/format';
import { ListEmpty } from '../common/ListStates';
import { MoneyCell } from '../common/MoneyCell';
import { Panel } from '../common/Panel';
import { camelKey } from '../../lib/camel-key';
import { UNKNOWN_ENUM_KEY, enumKey, eventActorKey } from '../../lib/enum-text';
import { Tag } from '../common/Tag';

type Order = AdminOrderDetailResponse;
type Attempt = Order['attempts'][number];
type Entry = Order['ledger'][number];

/** A machine reason code: upper case with at least one underscore. */
const REASON_CODE = /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/;

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
  // A reason code (LOW_BALANCE, ADAPTER_ERROR) in words. An unknown code gets the general word
  // and keeps the code itself in monospace for diagnosis (CR A7); a note an admin wrote (no
  // underscore code) stays exactly as written.
  const describe = (createdAt: string, note: string | null): ReactNode => {
    const time = formatDateTime(createdAt);
    if (note === null || note === '') return time;
    if (!REASON_CODE.test(note)) return `${time} · ${note}`;
    const key = enumKey('orderReason', note);
    if (key !== UNKNOWN_ENUM_KEY) return `${time} · ${t(key)}`;
    return (
      <>
        {time} · {t(key)} <code className="font-mono text-[11px]">{note}</code>
      </>
    );
  };
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
          {t(enumKey('attemptStatus', a.status))}
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
      cell: (e) => <Tag tone="mute">{t(`admin.ledger.kind.${camelKey(e.kind)}`)}</Tag>,
    },
    {
      id: 'ref',
      header: t('admin.ledger.col.ref'),
      cell: (e) => t(`admin.ledger.refType.${camelKey(e.refType)}`),
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
            title: `${t(enumKey('orderStatus', event.to))} · ${t(eventActorKey(event.actor))}`,
            description: describe(event.createdAt, event.note),
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
            TON · {t(enumKey('tonStatus', transfer.status))} ·{' '}
            {formatMinor('TON', transfer.amountNanoTon)} TON · seqno {transfer.seqno}
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
