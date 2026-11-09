'use client';

import { Button, Icon } from '@repo/ui';
import { Share2 } from 'lucide-react';
import { BRAND } from '@repo/shared';
import { useTranslations } from 'next-intl';
import { openTelegramUrl } from '../../telegram/open-link';
import { useTelegram } from '../../telegram/telegram-context';
import { telegramShareUrl } from './referral-link';

/**
 * "Ulashish". In the Mini App it opens Telegram's own share dialog (`openTelegramLink`), outside
 * it Telegram's share page in a new tab. On the web store the browser's share sheet is used when
 * it has one; without it the button is not drawn (the copy button is next to it).
 */
export function ShareLinkButton({ link, variant }: { link: string; variant: 'tg' | 'web' }) {
  const t = useTranslations('account.referral');
  const { webApp } = useTelegram();
  const text = t('shareText', { brand: BRAND.name });

  if (
    variant === 'web' &&
    (typeof navigator === 'undefined' || typeof navigator.share !== 'function')
  ) {
    return null;
  }
  const onShare = () => {
    if (variant === 'web') {
      void navigator.share({ url: link, text }).catch(() => undefined);
      return;
    }
    const href = telegramShareUrl(link, text);
    if (webApp === null || !openTelegramUrl(href)) {
      window.open(href, '_blank', 'noopener,noreferrer');
    }
  };
  return (
    <Button size="lg" className="w-full" onClick={onShare}>
      <Icon icon={Share2} size={18} />
      {t('share')}
    </Button>
  );
}
