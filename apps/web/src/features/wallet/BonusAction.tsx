'use client';

import { Icon, useToast } from '@repo/ui';
import { Ticket } from 'lucide-react';
import { useTranslations } from 'next-intl';

/**
 * "Bonus kod" on the wallet card (MiniApp.dc.html:114: a button like "Yordam", with no label). The
 * bonus-code screen is not built yet, so a press says so in a toast ("Tez orada"), which the
 * toast provider announces to screen readers (aria-live), instead of the button being dead.
 */
export function BonusAction({ className }: { className: string }) {
  const t = useTranslations('wallet.card');
  const common = useTranslations('common');
  const toast = useToast();
  return (
    <button
      type="button"
      onClick={() => toast.show({ tone: 'info', title: common('comingSoon') })}
      className={`relative flex min-h-11 items-center justify-center gap-1.5 rounded-[14px] text-center text-sm font-extrabold focus-visible:outline-2 focus-visible:outline-ring ${className}`}
    >
      <Icon icon={Ticket} size={16} />
      {t('bonus')}
    </button>
  );
}
