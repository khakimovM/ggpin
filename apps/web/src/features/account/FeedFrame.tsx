'use client';

import { ErrorState, Icon } from '@repo/ui';
import { CloudOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import type { Feed } from './history-feed';
import { HistorySkeleton } from './HistorySkeleton';

/**
 * The four states of a history list (Account.dc.html `historyState`): skeleton while the first
 * page loads, an error with "Qayta urinish" when there is nothing to show, the empty state, and
 * the rows. A failed refetch behind rows that are already there keeps the rows.
 */
export function FeedFrame<T>({
  feed,
  empty,
  children,
}: {
  feed: Feed<T>;
  /** Shown when the list is empty (icon, text and, where the design has one, a call to action). */
  empty: ReactNode;
  children: ReactNode;
}) {
  const t = useTranslations('account.history');
  const common = useTranslations('common');
  if (feed.status === 'pending') return <HistorySkeleton label={t('loading')} />;
  if (feed.status === 'error') {
    return (
      <ErrorState
        icon={<Icon icon={CloudOff} size={24} />}
        title={t('error.title')}
        description={t('error.body')}
        retryLabel={common('retry')}
        retrying={feed.fetching}
        onRetry={feed.refetch}
      />
    );
  }
  return feed.items.length === 0 ? empty : children;
}
