'use client';

import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { AccountPage } from './AccountPage';
import { HistoryTabs } from './HistoryTabs';
import { LedgerPanel } from './LedgerPanel';
import { OrderFilterChips } from './OrderFilterChips';
import { OrdersPanel } from './OrdersPanel';
import type { OrderFilter } from './order-filters';
import { useAccountPaths } from './use-account-paths';

type Tab = 'orders' | 'finance';

/**
 * Tarix: the order history and the money movements (Account.dc.html `history`, Store.dc.html
 * `history`). Which tab and which filter are on is UI state kept here; the rows are server state
 * in TanStack Query. Changing the tab or the filter goes back to the first page.
 */
export function HistoryScreen({ variant }: { variant: 'tg' | 'web' }) {
  const t = useTranslations('account.history');
  const paths = useAccountPaths(variant);
  const idBase = useId();
  const [tab, setTab] = useState<Tab>('orders');
  const [filter, setFilter] = useState<OrderFilter>('all');
  const [page, setPage] = useState(1);
  const web = variant === 'web';

  const tabs = (
    <HistoryTabs
      size={variant}
      idBase={idBase}
      ariaLabel={t('tabs.label')}
      value={tab}
      onValueChange={(next) => {
        setTab(next);
        setPage(1);
      }}
      options={[
        { value: 'orders', label: t('tabs.orders') },
        { value: 'finance', label: t('tabs.finance') },
      ]}
    />
  );
  const body = (
    <>
      {tab === 'orders' ? (
        <OrderFilterChips
          variant={variant}
          value={filter}
          onChange={(next) => {
            setFilter(next);
            setPage(1);
          }}
        />
      ) : null}
      <div
        role="tabpanel"
        id={`${idBase}-panel`}
        aria-labelledby={`${idBase}-tab-${tab}`}
        className="flex flex-col gap-4"
      >
        {tab === 'orders' ? (
          <OrdersPanel
            variant={variant}
            paths={paths}
            home={paths.home}
            filter={filter}
            page={page}
            onPage={setPage}
          />
        ) : (
          <LedgerPanel variant={variant} paths={paths} page={page} onPage={setPage} />
        )}
      </div>
    </>
  );

  return web ? (
    <AccountPage variant="web">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="m-0 text-3xl leading-9 font-extrabold tracking-[-.02em]">{t('title')}</h1>
        {tabs}
      </div>
      {body}
    </AccountPage>
  ) : (
    <AccountPage variant="tg" tab="history" title={t('title')}>
      {tabs}
      {body}
    </AccountPage>
  );
}
