'use client';

import type { LedgerItem } from '@repo/shared';
import { useMediaQuery } from '@repo/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useDateFormat } from '../../lib/format/use-date-format';
import { DaySections } from './DaySections';
import { groupByDay } from './group-by-day';
import type { Feed } from './history-feed';
import { HistoryPager } from './HistoryPager';
import { LedgerRow } from './LedgerRow';
import { LedgerTable } from './LedgerTable';
import { LoadMore } from './LoadMore';
import { WebListCard } from './WebListCard';

export interface LedgerListProps {
  variant: 'tg' | 'web';
  feed: Feed<LedgerItem>;
  /** An entry from an order opens that order; any other has no page to go to. */
  orderHref: (orderId: string) => string;
  onPage: (page: number) => void;
}

/** The rows of the "Moliya" tab; same layout rules as `OrderList`. */
export function LedgerList({ variant, feed, orderHref, onPage }: LedgerListProps) {
  const locale = useLocale() === 'ru' ? 'ru' : 'uz';
  const common = useTranslations('common');
  const history = useTranslations('account.history');
  const { userDateTime } = useDateFormat();
  const wide = useMediaQuery('(min-width: 1024px)');
  // Not memoised: "today" moves at midnight, and grouping a page of 20 rows costs nothing.
  const groups = groupByDay(feed.items, (item) => item.createdAt, {
    locale,
    labels: {
      today: common('today'),
      yesterday: common('yesterday'),
      unknown: history('unknownDay'),
    },
  });
  const hrefOf = (item: LedgerItem): string | undefined =>
    item.orderId === null ? undefined : orderHref(item.orderId);

  if (variant === 'tg') {
    return (
      <>
        <DaySections
          groups={groups}
          row={(item) => <LedgerRow key={item.id} item={item} href={hrefOf(item)} />}
        />
        <LoadMore feed={feed} />
      </>
    );
  }
  return (
    <WebListCard busy={feed.fetching} footer={<HistoryPager feed={feed} onPage={onPage} />}>
      {wide ? (
        <LedgerTable items={feed.items} hrefOf={hrefOf} />
      ) : (
        feed.items.map((item) => (
          <LedgerRow
            key={item.id}
            item={item}
            href={hrefOf(item)}
            withDate={userDateTime(new Date(item.createdAt))}
          />
        ))
      )}
    </WebListCard>
  );
}
