'use client';

import { Button, Icon } from '@repo/ui';
import { CloudOff, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';

/**
 * The categories could not be loaded: the products below still show (grouped without titles), but
 * the chips must not vanish without a word. One line and a retry.
 */
export function CategoriesError({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  const t = useTranslations('store.catalog.categories');
  const common = useTranslations('common');
  return (
    <div
      role="alert"
      className="flex items-center gap-2.5 rounded-2xl border border-border bg-card py-2 pr-2 pl-3.5 text-sm font-semibold text-foreground-secondary"
    >
      <Icon icon={CloudOff} size={18} className="shrink-0" />
      <span className="min-w-0 flex-1">{t('error')}</span>
      <Button variant="outline" size="sm" loading={retrying} onClick={onRetry}>
        {retrying ? null : <Icon icon={RefreshCw} size={14} />}
        {common('retry')}
      </Button>
    </div>
  );
}
