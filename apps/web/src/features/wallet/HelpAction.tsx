'use client';

import { Icon } from '@repo/ui';
import { LifeBuoy } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';

/**
 * "Yordam" on the wallet card: the Mini App's own help screen (`/tg/help`, phase 7 S9), where the
 * FAQ and the way to write to support are.
 */
export function HelpAction({ className }: { className: string }) {
  const t = useTranslations('wallet.card');
  return (
    <Link
      href="/tg/help"
      className={`relative flex min-h-11 items-center justify-center gap-1.5 rounded-[14px] text-center text-sm font-extrabold no-underline hover:text-primary-foreground focus-visible:outline-2 focus-visible:outline-ring ${className}`}
    >
      <Icon icon={LifeBuoy} size={16} />
      {t('help')}
    </Link>
  );
}
