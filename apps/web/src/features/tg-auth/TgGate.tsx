'use client';

import { Button, Icon } from '@repo/ui';
import { Bot, Lock, MessageCircle, RefreshCw, Send, TriangleAlert, WifiOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { env } from '../../env';
import { useTelegram } from '../../telegram/telegram-context';
import { openTelegramUrl } from '../../telegram/open-link';
import { supportLink } from '../../telegram/support-link';
import { TelegramBackButton } from '../../telegram/TelegramBackButton';
import { callSdk } from '../../telegram/webapp';
import { GateScreen } from './GateScreen';
import { Splash } from './Splash';
import type { GateInfo } from './gate-for-error';
import { useTgSession } from './use-tg-session';

// Read when a gate renders, not at import: the links come from env, never from a literal
// (CLAUDE.md "the brand lives in one place"), and tests can change them.
const botUrl = () => `https://t.me/${env.NEXT_PUBLIC_BOT_USERNAME}`;

function externalLink(href: string, icon: typeof Send, label: string) {
  return (
    <Button asChild size="lg" glow className="w-full">
      <a href={href} target="_blank" rel="noopener noreferrer">
        <Icon icon={icon} size={18} />
        {label}
      </a>
    </Button>
  );
}

/**
 * The support button. Inside Telegram a t.me link opens in Telegram (`openTelegramLink`), not in
 * an external browser; any other link, or no Telegram, is an ordinary link. No link configured: no
 * button.
 */
function SupportAction({ label, inTelegram }: { label: string; inTelegram: boolean }) {
  const link = supportLink(env.NEXT_PUBLIC_SUPPORT_URL);
  if (link.kind === 'none') return null;
  if (inTelegram && link.kind === 'telegram') {
    return (
      <Button size="lg" glow className="w-full" onClick={() => openTelegramUrl(link.href)}>
        <Icon icon={MessageCircle} size={18} />
        {label}
      </Button>
    );
  }
  return externalLink(link.href, MessageCircle, label);
}

function Gate({ gate, onRetry }: { gate: GateInfo; onRetry: () => void }) {
  const t = useTranslations('tg.gate');
  const common = useTranslations('common');
  const all = useTranslations();
  const { webApp } = useTelegram();

  const retryButton = (
    <Button size="lg" glow className="w-full" onClick={onRetry}>
      <Icon icon={RefreshCw} size={18} />
      {common('retry')}
    </Button>
  );

  switch (gate.kind) {
    case 'bot':
      return (
        <GateScreen
          icon={Bot}
          tone="primary"
          title={t('bot.title')}
          body={t('bot.body')}
          action={externalLink(botUrl(), Send, t('bot.cta'))}
        />
      );
    case 'blocked':
      return (
        <GateScreen
          icon={Lock}
          tone="danger"
          title={t('blocked.title')}
          body={t('blocked.body')}
          action={<SupportAction label={t('blocked.cta')} inTelegram={webApp !== null} />}
        />
      );
    case 'offline':
      return (
        <GateScreen
          icon={WifiOff}
          tone="warning"
          title={t('offline.title')}
          body={t('offline.body')}
          action={retryButton}
        />
      );
    case 'reopen':
      return (
        <GateScreen
          icon={RefreshCw}
          tone="primary"
          title={t('reopen.title')}
          body={t('reopen.body')}
          action={
            <Button
              size="lg"
              glow
              className="w-full"
              onClick={() => webApp && callSdk(() => webApp.close())}
            >
              {t('reopen.cta')}
            </Button>
          }
        />
      );
    case 'error':
      return (
        <GateScreen
          icon={TriangleAlert}
          tone="warning"
          title={t('error.title')}
          body={gate.messageKey ? all(gate.messageKey) : common('error.network')}
          action={retryButton}
        />
      );
  }
}

/**
 * Stands between a visitor and the Mini App: the splash while Telegram signs them in, a gate
 * screen when they cannot be let in (not in Telegram, blocked, offline, launch data expired, any
 * other failure), and the app itself only once there is a session.
 */
export function TgGate({ children }: { children: ReactNode }) {
  const { state, retry } = useTgSession();
  if (state.status === 'booting') return <Splash />;
  if (state.status === 'gate') return <Gate gate={state.gate} onRetry={retry} />;
  // The native BackButton belongs to the app, not to the splash or a gate screen.
  return (
    <>
      <TelegramBackButton />
      {children}
    </>
  );
}
