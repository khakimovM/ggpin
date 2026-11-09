'use client';

import { Icon, cn } from '@repo/ui';
import { CircleCheck, Phone } from 'lucide-react';
import { useTranslations } from 'next-intl';

/**
 * The web profile's phone line (Store.dc.html). Only the state is known (`phoneLinked`): the
 * number itself never reaches the browser, and it cannot be changed here (owner decision Q6).
 */
export function PhoneRow({ linked }: { linked: boolean }) {
  const t = useTranslations('account.profile.phone');
  return (
    <div className="flex items-center gap-3 border-t border-border pt-3.5">
      <span
        aria-hidden="true"
        className={cn(
          'grid size-10 shrink-0 place-items-center rounded-xl',
          linked ? 'bg-success-soft text-success' : 'bg-muted text-foreground-muted',
        )}
      >
        <Icon icon={Phone} size={18} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-xs leading-4 font-semibold text-foreground-muted">{t('title')}</span>
        {linked ? null : (
          <span className="text-[13px] leading-[18px] font-semibold text-foreground-secondary">
            {t('hint')}
          </span>
        )}
      </span>
      <span
        className={cn(
          'flex items-center gap-1 text-xs leading-4 font-bold',
          linked ? 'text-success-text' : 'text-foreground-muted',
        )}
      >
        {linked ? <Icon icon={CircleCheck} size={13} /> : null}
        {linked ? t('linked') : t('unlinked')}
      </span>
    </div>
  );
}
