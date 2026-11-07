'use client';

import { Button, Icon } from '@repo/ui';
import { CircleAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';

/**
 * "Chiqish amalga oshmadi" with a retry. The sign-out request got no answer, so the session is
 * still alive on the server: this must not look like a successful sign-out.
 */
export function LogoutNotice({ retrying, onRetry }: { retrying: boolean; onRetry: () => void }) {
  const t = useTranslations('web.logout');
  const common = useTranslations('common');
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-3 rounded-md bg-danger-soft px-3.5 py-3 text-danger-text"
    >
      <div className="flex items-start gap-2.5">
        <Icon icon={CircleAlert} size={18} className="mt-px shrink-0" />
        <span className="flex flex-col gap-0.5 text-sm leading-5 font-bold">
          {t('failedTitle')}
          <span className="font-medium text-foreground-secondary">{t('failedHint')}</span>
        </span>
      </div>
      <Button variant="outline" size="md" loading={retrying} onClick={onRetry}>
        {common('retry')}
      </Button>
    </div>
  );
}
