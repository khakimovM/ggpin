'use client';

import { Avatar } from '@repo/ui';
import { useTranslations } from 'next-intl';
import { LogoutButton } from '../auth/LogoutButton';
import { useMe } from '../auth/use-me';
import { SessionsList } from './SessionsList';

/** Web profile (Store.dc.html `page: profile`). Rendered behind AuthGuard, so `/me` is loaded. */
export function ProfileView() {
  const t = useTranslations('web.profile');
  const me = useMe();
  const name = me.data?.firstName ?? me.data?.username ?? undefined;

  return (
    <main className="mx-auto flex w-full max-w-[640px] flex-1 flex-col gap-5 px-4 py-8 md:px-8">
      <h1 className="m-0 text-2xl leading-8 font-extrabold">{t('title')}</h1>
      <div className="flex items-center gap-3">
        <Avatar name={name} size={56} />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-base leading-[22px] font-extrabold">{name}</span>
          {me.data?.username ? (
            <span className="truncate text-xs leading-4 font-semibold text-foreground-muted">
              @{me.data.username}
            </span>
          ) : null}
        </span>
      </div>
      <SessionsList />
      <LogoutButton className="self-start" />
    </main>
  );
}
