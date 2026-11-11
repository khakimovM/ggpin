'use client';

import { Avatar, HIT_AREA_44, Icon, cn } from '@repo/ui';
import { Check, Copy } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMe } from '../auth/use-me';
import { PhoneRow } from './PhoneRow';
import { useCopy } from './use-copy';
import { WalletTiles } from './WalletTiles';

/**
 * The identity card (Account.dc.html / Store.dc.html `profile`): avatar, name, @username, the
 * Telegram ID (a tap copies it), the balance and the cashback tiles. The web card also has the
 * phone state. Rendered behind a session, so `/me` is in the cache.
 */
export function ProfileCard({ variant }: { variant: 'tg' | 'web' }) {
  const t = useTranslations('account.profile');
  const me = useMe();
  const { copied, copy } = useCopy();
  const web = variant === 'web';
  const user = me.data;
  const name = user?.firstName ?? user?.username ?? undefined;

  return (
    <section
      aria-label={t('title')}
      className={cn(
        'flex flex-col border border-border bg-card',
        web ? 'gap-[18px] rounded-3xl p-[22px]' : 'gap-4 rounded-3xl p-4',
      )}
    >
      <div className={cn('flex items-center', web ? 'gap-4' : 'gap-3.5')}>
        <Avatar name={name} src={user?.photoUrl ?? undefined} size={web ? 72 : 64} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            className={cn(
              'truncate font-extrabold',
              web ? 'text-xl leading-[26px]' : 'text-[19px] leading-6',
            )}
          >
            {name}
          </span>
          {user?.username ? (
            <span className="truncate text-sm leading-[19px] font-semibold text-foreground-muted">
              @{user.username}
            </span>
          ) : null}
          {user ? (
            <>
              <button
                type="button"
                onClick={() => copy(user.telegramId)}
                className={`relative mt-1 flex h-[30px] items-center gap-1.5 self-start rounded-full border border-border bg-background px-2.5 text-xs leading-none font-bold text-foreground-secondary tabular-nums focus-visible:outline-2 focus-visible:outline-ring ${HIT_AREA_44}`}
              >
                {t('idLabel', { id: user.telegramId })}
                <span className="sr-only">{t('idCopy')}</span>
                <Icon
                  icon={copied ? Check : Copy}
                  size={13}
                  className={copied ? 'text-success-text' : undefined}
                />
              </button>
              <span role="status" className="sr-only">
                {copied ? t('idCopied') : ''}
              </span>
            </>
          ) : null}
        </span>
      </div>
      <WalletTiles variant={variant} />
      {web && user ? <PhoneRow linked={user.phoneLinked} /> : null}
    </section>
  );
}
