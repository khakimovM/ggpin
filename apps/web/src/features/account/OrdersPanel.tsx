'use client';

import { Button, EmptyState, Icon } from '@repo/ui';
import { ListFilter, PackageOpen } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { FeedFrame } from './FeedFrame';
import { OrderList } from './OrderList';
import type { OrderFilter } from './order-filters';
import type { PanelProps } from './panel-props';
import { useOrdersFeed } from './use-orders';

/** "Buyurtmalar": mounted only while its tab is open, so it asks the API only then. */
export function OrdersPanel({
  filter,
  home,
  variant,
  paths,
  page,
  onPage,
}: PanelProps & { filter: OrderFilter; home: string }) {
  const t = useTranslations('account.history.empty');
  const feed = useOrdersFeed(variant, filter, page);
  const empty =
    filter === 'all' ? (
      <EmptyState
        icon={<Icon icon={PackageOpen} size={24} />}
        title={t('orders.title')}
        description={t('orders.body')}
        action={
          <Button asChild>
            <Link href={home}>{t('orders.cta')}</Link>
          </Button>
        }
      />
    ) : (
      <EmptyState
        icon={<Icon icon={ListFilter} size={24} />}
        title={t('filtered.title')}
        description={t('filtered.body')}
      />
    );
  return (
    <FeedFrame feed={feed} empty={empty}>
      <OrderList variant={variant} feed={feed} hrefOf={paths.order} onPage={onPage} />
    </FeedFrame>
  );
}
