'use client';

import { EmptyState, Icon } from '@repo/ui';
import { Receipt } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { FeedFrame } from './FeedFrame';
import { LedgerList } from './LedgerList';
import type { PanelProps } from './panel-props';
import { useLedgerFeed } from './use-ledger';

/** "Moliya": the ledger, asked for only when the tab is opened. */
export function LedgerPanel({ variant, paths, page, onPage }: PanelProps) {
  const t = useTranslations('account.history.empty.finance');
  const feed = useLedgerFeed(variant, page);
  return (
    <FeedFrame
      feed={feed}
      empty={
        <EmptyState
          icon={<Icon icon={Receipt} size={24} />}
          title={t('title')}
          description={t('body')}
        />
      }
    >
      <LedgerList variant={variant} feed={feed} orderHref={paths.order} onPage={onPage} />
    </FeedFrame>
  );
}
