'use client';

import { Button, Icon } from '@repo/ui';
import { LifeBuoy } from 'lucide-react';
import type { ReactNode } from 'react';
import { env } from '../../env';
import { openTelegramUrl } from '../../telegram/open-link';
import { supportLink } from '../../telegram/support-link';
import { useTelegram } from '../../telegram/telegram-context';

export interface SupportLinkButtonProps {
  children: ReactNode;
  variant?: 'outline' | 'secondary' | 'ghost';
  className?: string;
}

/**
 * A button to the configured support chat (`NEXT_PUBLIC_SUPPORT_URL`): a t.me link opens inside
 * Telegram in the Mini App, anything else is an ordinary link in a new tab. With no support link
 * configured nothing is drawn: a button must never lead nowhere (S9's help screen replaces this).
 */
export function SupportLinkButton({
  children,
  variant = 'outline',
  className,
}: SupportLinkButtonProps) {
  const { webApp } = useTelegram();
  const link = supportLink(env.NEXT_PUBLIC_SUPPORT_URL);
  if (link.kind === 'none') return null;
  const content = (
    <>
      <Icon icon={LifeBuoy} size={17} />
      {children}
    </>
  );
  if (link.kind === 'telegram' && webApp !== null) {
    return (
      <Button variant={variant} className={className} onClick={() => openTelegramUrl(link.href)}>
        {content}
      </Button>
    );
  }
  return (
    <Button asChild variant={variant} className={className}>
      <a href={link.href} target="_blank" rel="noopener noreferrer">
        {content}
      </a>
    </Button>
  );
}
