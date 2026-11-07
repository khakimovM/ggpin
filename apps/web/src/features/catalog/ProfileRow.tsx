'use client';

import { BRAND } from '@repo/shared';
import { Avatar } from '@repo/ui';
import { useTranslations } from 'next-intl';
import { useMe } from '../auth/use-me';
import { useWallet } from '../wallet/use-wallet';

/**
 * The first line of the Mini App home (MiniApp.dc.html `home`): avatar, name (the page's h1),
 * @username, and the cashback coins. Behind the gate, so `/me` is already in the cache.
 */
export function ProfileRow() {
  const t = useTranslations('wallet.card');
  const me = useMe();
  const wallet = useWallet();
  const name = me.data?.firstName ?? me.data?.username ?? BRAND.name;
  const coins = wallet.data?.coins;

  return (
    <div className="flex items-center gap-3">
      <Avatar name={name} src={me.data?.photoUrl ?? undefined} size={44} />
      <span className="flex min-w-0 flex-1 flex-col gap-px">
        <h1 className="m-0 truncate text-base leading-[21px] font-extrabold">{name}</h1>
        {me.data?.username ? (
          <span className="truncate text-[13px] leading-[17px] font-semibold text-foreground-muted">
            @{me.data.username}
          </span>
        ) : null}
      </span>
      {coins === undefined ? null : (
        <span
          role="img"
          aria-label={t('coins', { count: Number(coins) })}
          className="flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-3 text-sm font-extrabold whitespace-nowrap tabular-nums shadow-sm"
        >
          <span aria-hidden="true">🪙</span>
          <span aria-hidden="true">{coins}</span>
        </span>
      )}
    </div>
  );
}
