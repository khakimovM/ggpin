'use client';

import { Badge, Icon } from '@repo/ui';
import { LifeBuoy } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { env } from '../../env';
import { openTelegramUrl } from '../../telegram/open-link';
import { supportLink } from '../../telegram/support-link';
import { useTelegram } from '../../telegram/telegram-context';

const BASE =
  'relative flex h-11 items-center justify-center gap-1.5 rounded-[14px] text-sm font-extrabold whitespace-nowrap focus-visible:outline-2 focus-visible:outline-ring';

/**
 * "Yordam" on the wallet card. The help screen is phase 7 S9, so until it exists the button goes
 * where support actually is: the configured support link (a t.me link opens inside Telegram, any
 * other opens in a new tab). With no link configured it is shown, but marked "Tez orada" and not
 * pressable, like its neighbours: a button must never lead to a page that is not there.
 */
export function HelpAction({ className }: { className: string }) {
  const t = useTranslations('wallet.card');
  const { webApp } = useTelegram();
  const link = supportLink(env.NEXT_PUBLIC_SUPPORT_URL);
  const content = (
    <>
      <Icon icon={LifeBuoy} size={16} />
      {t('help')}
    </>
  );

  if (link.kind === 'none') {
    return (
      <button
        type="button"
        aria-disabled="true"
        className={`${BASE} cursor-not-allowed ${className}`}
      >
        {content}
        <Badge size="sm" variant="soon" className="absolute -top-2 right-2">
          {t('soon')}
        </Badge>
      </button>
    );
  }
  if (link.kind === 'telegram' && webApp !== null) {
    return (
      <button
        type="button"
        className={`${BASE} ${className}`}
        onClick={() => openTelegramUrl(link.href)}
      >
        {content}
      </button>
    );
  }
  return (
    <a
      href={link.href}
      target="_blank"
      rel="noopener noreferrer"
      className={`${BASE} no-underline hover:text-primary-foreground ${className}`}
    >
      {content}
    </a>
  );
}
