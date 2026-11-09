'use client';

import type { OrderDto } from '@repo/shared';
import { useMediaQuery } from '@repo/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useDateFormat } from '../../lib/format/use-date-format';
import { DaySections } from './DaySections';
import { groupByDay } from './group-by-day';
import type { Feed } from './history-feed';
import { HistoryPager } from './HistoryPager';
import { LoadMore } from './LoadMore';
import { OrderRow } from './OrderRow';
import { OrderTable } from './OrderTable';
import { WebListCard } from './WebListCard';

export interface OrderListProps {
  variant: 'tg' | 'web';
  feed: Feed<OrderDto>;
  hrefOf: (id: string) => string;
  onPage: (page: number) => void;
}

/**
 * The rows of the order history. The Mini App groups them under day headings and appends pages;
 * the web store shows a table from 1024 px and the same rows (with their date) below it, and a
 * numbered pager under either.
 */
export function OrderList({ variant, feed, hrefOf, onPage }: OrderListProps) {
  const locale = useLocale() === 'ru' ? 'ru' : 'uz';
  const common = useTranslations('common');
  const history = useTranslations('account.history');
  const { userDateTime } = useDateFormat();
  const wide = useMediaQuery('(min-width: 1024px)');
  // Not memoised: "today" moves at midnight, and grouping a page of 20 rows costs nothing.
  const groups = groupByDay(feed.items, (order) => order.createdAt, {
    locale,
    labels: {
      today: common('today'),
      yesterday: common('yesterday'),
      unknown: history('unknownDay'),
    },
  });

  if (variant === 'tg') {
    return (
      <>
        <DaySections
          groups={groups}
          row={(order) => <OrderRow key={order.id} order={order} href={hrefOf(order.id)} />}
        />
        <LoadMore feed={feed} />
      </>
    );
  }
  return (
    <WebListCard busy={feed.fetching} footer={<HistoryPager feed={feed} onPage={onPage} />}>
      {wide ? (
        <OrderTable orders={feed.items} hrefOf={hrefOf} />
      ) : (
        feed.items.map((order) => (
          <OrderRow
            key={order.id}
            order={order}
            href={hrefOf(order.id)}
            withDate={userDateTime(new Date(order.createdAt))}
          />
        ))
      )}
    </WebListCard>
  );
}
