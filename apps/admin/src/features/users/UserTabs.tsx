import type {
  AdminOrderRow,
  AdminPaymentRow,
  AdminUserLedgerResponse,
  AdminUserReferralsResponse,
  AdminUserSessionsResponse,
} from '@repo/shared';
import type { DataTableColumn } from '@repo/ui';
import { Coins, History, KeyRound, ShoppingBag, Ticket, UserPlus, Wallet } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useTranslations } from 'use-intl';
import {
  listUserLedger,
  listUserOrders,
  listUserPayments,
  listUserReferrals,
  listUserSessions,
} from '../../lib/api/people';
import { formatDateTime } from '../../lib/format';
import { readPage, writePage } from '../../lib/list-params';
import { qk } from '../../lib/query-keys';
import { ListEmpty } from '../common/ListStates';
import { MoneyCell } from '../common/MoneyCell';
import { OrderStatusTag } from '../common/OrderStatusTag';
import { PagedTable } from '../common/PagedTable';
import { PaymentStatusTag } from '../common/PaymentStatusTag';
import { Tag } from '../common/Tag';
import { UnderlineTabs } from '../common/UnderlineTabs';
import { camelKey } from '../../lib/camel-key';
import { ROW_LINK } from '../common/link-style';

export const USER_TAB_IDS = [
  'orders',
  'ledger',
  'payments',
  'referrals',
  'sessions',
  'coins',
  'codes',
] as const;
type TabId = (typeof USER_TAB_IDS)[number];

type Ledger = AdminUserLedgerResponse[number];
type Referral = AdminUserReferralsResponse[number];
type Session = AdminUserSessionsResponse[number];

const MONO = 'font-mono text-[11px] text-foreground-secondary';

/** The tabs of a user's page; the tab and its page live in the URL (`?tab=ledger&page=2`). */
export function UserTabs({ userId }: { userId: string }) {
  const t = useTranslations();
  const [search, setSearch] = useSearchParams();
  const raw = search.get('tab');
  const tab: TabId = USER_TAB_IDS.find((id) => id === raw) ?? 'orders';
  const page = readPage(search);
  const onPage = (next: number) => setSearch((current) => writePage(current, next));
  const label = t(`admin.users.tabs.${tab}`);
  const common = {
    label,
    queryKey: qk.users.tab(userId, tab, { page }),
    onPage,
    framed: false,
  } as const;

  const orders: DataTableColumn<AdminOrderRow>[] = [
    {
      id: 'n',
      header: '#',
      cell: (o) => (
        <Link to={`/orders/${o.id}`} className={ROW_LINK}>
          #{o.number}
        </Link>
      ),
    },
    { id: 'date', header: t('admin.orders.col.date'), cell: (o) => formatDateTime(o.createdAt) },
    {
      id: 'product',
      header: t('admin.orders.col.product'),
      cell: (o) => [o.product.name, o.sku?.label].filter(Boolean).join(' · '),
    },
    {
      id: 'total',
      header: t('admin.orders.col.price'),
      align: 'end',
      cell: (o) => <MoneyCell tiyin={o.totalTiyin} />,
    },
    {
      id: 'status',
      header: t('admin.orders.col.status'),
      cell: (o) => <OrderStatusTag status={o.status} />,
    },
  ];
  const ledger: DataTableColumn<Ledger>[] = [
    { id: 'date', header: t('admin.ledger.col.date'), cell: (e) => formatDateTime(e.createdAt) },
    {
      id: 'kind',
      header: t('admin.ledger.col.kind'),
      cell: (e) => <Tag tone="mute">{t(`admin.ledger.kind.${camelKey(e.kind)}`)}</Tag>,
    },
    {
      id: 'ref',
      header: t('admin.ledger.col.ref'),
      cell: (e) => `${t(`admin.ledger.refType.${camelKey(e.refType)}`)} · ${e.refId}`,
      className: MONO,
    },
    {
      id: 'amount',
      header: t('admin.ledger.col.amount'),
      align: 'end',
      cell: (e) => <MoneyCell tiyin={e.amountTiyin} signed />,
    },
  ];
  const payments: DataTableColumn<AdminPaymentRow>[] = [
    { id: 'date', header: t('admin.payments.col.date'), cell: (p) => formatDateTime(p.createdAt) },
    { id: 'id', header: t('admin.list.col.id'), cell: (p) => p.id, className: MONO },
    {
      id: 'amount',
      header: t('admin.payments.col.amount'),
      align: 'end',
      cell: (p) => <MoneyCell tiyin={p.amountTiyin} />,
    },
    {
      id: 'status',
      header: t('admin.payments.col.status'),
      cell: (p) => <PaymentStatusTag status={p.status} />,
    },
  ];
  const referrals: DataTableColumn<Referral>[] = [
    {
      id: 'user',
      header: t('admin.users.col.username'),
      cell: (r) => (
        <Link to={`/users/${r.id}`} className={ROW_LINK}>
          {r.username ? `@${r.username}` : r.id}
        </Link>
      ),
    },
    { id: 'date', header: t('admin.users.col.created'), cell: (r) => formatDateTime(r.createdAt) },
  ];
  const sessions: DataTableColumn<Session>[] = [
    { id: 'agent', header: t('admin.sessions.col.device'), cell: (s) => s.userAgent ?? '—' },
    { id: 'ip', header: t('admin.list.col.ip'), cell: (s) => s.ipMasked ?? '—', className: MONO },
    {
      id: 'created',
      header: t('admin.sessions.col.created'),
      cell: (s) => formatDateTime(s.createdAt),
    },
    {
      id: 'expires',
      header: t('admin.sessions.col.expires'),
      cell: (s) => formatDateTime(s.expiresAt),
    },
    {
      id: 'state',
      header: t('admin.sessions.col.state'),
      cell: (s) => (
        <Tag tone={s.revokedAt ? 'mute' : 'ok'}>
          {t(s.revokedAt ? 'admin.sessions.revoked' : 'admin.sessions.active')}
        </Tag>
      ),
    },
  ];

  let body: ReactNode;
  if (tab === 'orders') {
    body = (
      <PagedTable
        {...common}
        fetch={(signal) => listUserOrders(userId, { page }, signal)}
        columns={orders}
        rowKey={(o) => o.id}
        emptyIcon={ShoppingBag}
        emptyTitle={t('admin.users.empty.orders')}
        minWidth={640}
      />
    );
  } else if (tab === 'ledger') {
    body = (
      <PagedTable
        {...common}
        fetch={(signal) => listUserLedger(userId, { page }, signal)}
        columns={ledger}
        rowKey={(e) => e.id}
        emptyIcon={Wallet}
        emptyTitle={t('admin.users.empty.ledger')}
        minWidth={640}
      />
    );
  } else if (tab === 'payments') {
    body = (
      <PagedTable
        {...common}
        fetch={(signal) => listUserPayments(userId, { page }, signal)}
        columns={payments}
        rowKey={(p) => p.id}
        emptyIcon={History}
        emptyTitle={t('admin.users.empty.payments')}
        minWidth={640}
      />
    );
  } else if (tab === 'referrals') {
    body = (
      <PagedTable
        {...common}
        fetch={(signal) => listUserReferrals(userId, { page }, signal)}
        columns={referrals}
        rowKey={(r) => r.id}
        emptyIcon={UserPlus}
        emptyTitle={t('admin.users.empty.referrals')}
      />
    );
  } else if (tab === 'sessions') {
    body = (
      <PagedTable
        {...common}
        fetch={(signal) => listUserSessions(userId, { page }, signal)}
        columns={sessions}
        rowKey={(s) => s.id}
        emptyIcon={KeyRound}
        emptyTitle={t('admin.users.empty.sessions')}
        minWidth={720}
      />
    );
  } else {
    // Cashback coins and discount codes arrive with phase 10; the tabs are there to keep the
    // design's layout, and say so.
    body = (
      <div className="py-6">
        <ListEmpty
          icon={tab === 'coins' ? Coins : Ticket}
          title={t(`admin.users.empty.${tab}`)}
          description={t('admin.users.empty.laterPhase')}
        />
      </div>
    );
  }

  return (
    <section
      aria-label={t('admin.users.tabs.label')}
      className="overflow-hidden rounded-md border border-border bg-card"
    >
      <div className="px-2">
        <UnderlineTabs
          label={t('admin.users.tabs.label')}
          value={tab}
          tabs={USER_TAB_IDS.map((id) => ({ id, label: t(`admin.users.tabs.${id}`) }))}
        />
      </div>
      {body}
    </section>
  );
}
