import type { AdminInfraWalletResponse } from '@repo/shared';
import { DataTable, Skeleton, type DataTableColumn } from '@repo/ui';
import { useQuery } from '@tanstack/react-query';
import { Gem } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { getWallet } from '../../lib/api/people';
import { formatDateTime, formatMinor, ratioOf, shortHash } from '../../lib/format';
import { qk } from '../../lib/query-keys';
import { KeyValues } from '../common/KeyValues';
import { ListEmpty, LoadError } from '../common/ListStates';
import { MockNote } from '../common/MockNote';
import { PageHeader } from '../common/PageHeader';
import { Panel } from '../common/Panel';
import { SectionGate } from '../common/SectionGate';
import { Tag } from '../common/Tag';

type Transfer = AdminInfraWalletResponse['recentTransfers'][number];

const ton = (nano: string) => `${formatMinor('TON', nano)} TON`;

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-[10px] bg-surface px-3 py-2.5">
      <span className="text-[11px] leading-[14px] font-bold text-foreground-muted">{label}</span>
      <span className="text-xl leading-[26px] font-extrabold tabular-nums">{value}</span>
    </div>
  );
}

function Wallet({ wallet }: { wallet: AdminInfraWalletResponse }) {
  const t = useTranslations();
  const used = ratioOf(wallet.used24hNanoTon, wallet.limits.dailyMaxNanoTon);
  const columns: DataTableColumn<Transfer>[] = [
    {
      id: 'time',
      header: t('admin.wallet.col.time'),
      cell: (row) => formatDateTime(row.createdAt),
    },
    {
      id: 'order',
      header: t('admin.wallet.col.order'),
      cell: (row) => row.orderId ?? '—',
      className: 'font-mono text-[11px]',
    },
    {
      id: 'amount',
      header: t('admin.wallet.col.amount'),
      align: 'end',
      cell: (row) => ton(row.amountNanoTon),
    },
    {
      id: 'status',
      header: t('admin.wallet.col.status'),
      cell: (row) => (
        <Tag
          tone={
            row.status === 'CONFIRMED'
              ? 'ok'
              : row.status === 'BROADCAST' || row.status === 'SIGNED'
                ? 'info'
                : 'bad'
          }
        >
          {row.status}
        </Tag>
      ),
    },
    {
      id: 'tx',
      header: t('admin.list.col.tx'),
      cell: (row) => (row.txHash ? shortHash(row.txHash) : '—'),
      className: 'font-mono text-[11px]',
    },
  ];
  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-3">
        <Panel
          title={t('admin.wallet.hot')}
          aside={<Tag tone={wallet.network === 'mainnet' ? 'prem' : 'info'}>{wallet.network}</Tag>}
        >
          <p className="m-0 font-mono text-xs leading-4 break-all text-foreground-secondary">
            {wallet.address}
          </p>
          <div className="grid grid-cols-2 gap-2">
            <Tile
              label="TON"
              value={wallet.balance ? formatMinor('TON', wallet.balance.nanoTon) : '—'}
            />
            <Tile
              label="USDT"
              value={wallet.balance ? formatMinor('USDT', wallet.balance.microUsdt) : '—'}
            />
          </div>
          <span className="text-[11px] leading-[14px] font-semibold text-foreground-muted">
            {wallet.balance
              ? t('admin.wallet.snapshot', { time: formatDateTime(wallet.balance.snapshotAt) })
              : t('admin.wallet.noSnapshot')}
          </span>
          <div className="flex flex-col gap-1.5">
            <span className="flex justify-between text-xs leading-4 font-bold tabular-nums">
              <span className="text-foreground-muted">{t('admin.wallet.daily')}</span>
              <span>
                {ton(wallet.used24hNanoTon)} / {ton(wallet.limits.dailyMaxNanoTon)}
              </span>
            </span>
            <span className="h-2 overflow-hidden rounded-full bg-muted">
              <span
                className={
                  used >= 0.8
                    ? 'block h-full rounded-full bg-warning'
                    : 'block h-full rounded-full bg-info'
                }
                style={{ width: `${(Math.min(1, used) * 100).toFixed(1)}%` }}
              />
            </span>
          </div>
        </Panel>
        <Panel title={t('admin.wallet.recent')}>
          <DataTable
            label={t('admin.wallet.recent')}
            columns={columns}
            rows={wallet.recentTransfers}
            rowKey={(row) => row.id}
            state={wallet.recentTransfers.length === 0 ? 'empty' : 'data'}
            framed={false}
            minWidth={620}
            loadingLabel={t('admin.states.loading')}
            empty={<ListEmpty icon={Gem} title={t('admin.wallet.empty')} />}
          />
        </Panel>
      </div>
      <Panel title={t('admin.wallet.limits')}>
        <KeyValues
          rows={[
            {
              key: 'order',
              label: t('admin.wallet.perOrder'),
              value: ton(wallet.limits.perOrderMaxNanoTon),
            },
            {
              key: 'daily',
              label: t('admin.wallet.dailyMax'),
              value: ton(wallet.limits.dailyMaxNanoTon),
            },
            {
              key: 'alert',
              label: t('admin.wallet.lowAlert'),
              value: ton(wallet.limits.minBalanceAlertNanoTon),
            },
          ]}
        />
        <p className="m-0 text-[11px] leading-[14px] font-semibold text-foreground-muted">
          {t('admin.wallet.limitsHint')}
        </p>
      </Panel>
    </div>
  );
}

function WalletScreen() {
  const t = useTranslations();
  const query = useQuery({
    queryKey: qk.infra.wallet(),
    queryFn: ({ signal }) => getWallet(signal),
    refetchInterval: 30_000,
  });
  return (
    <>
      <PageHeader title={t('admin.nav.wallet')} sub={t('admin.wallet.sub')} />
      <MockNote />
      {query.data ? (
        <Wallet wallet={query.data} />
      ) : (
        <div className="rounded-md border border-border bg-card py-6">
          {query.isError ? (
            <LoadError
              error={query.error}
              onRetry={() => void query.refetch()}
              retrying={query.isFetching}
            />
          ) : (
            <div role="status" aria-label={t('admin.states.loading')} className="px-3.5">
              <Skeleton className="h-60 rounded-md" />
            </div>
          )}
        </div>
      )}
    </>
  );
}

export function WalletPage() {
  const t = useTranslations();
  return (
    <SectionGate permission="infra.read" title={t('admin.nav.wallet')}>
      <WalletScreen />
    </SectionGate>
  );
}
