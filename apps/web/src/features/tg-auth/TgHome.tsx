'use client';

import { BRAND } from '@repo/shared';
import { Logo } from '@repo/ui';
import { useTranslations } from 'next-intl';
import { useMe } from '../auth/use-me';

/**
 * The Mini App's home until the catalog arrives (phase 7 S5 replaces this component). It is only
 * rendered behind TgGate, so the signed-in user is already in the `/me` cache.
 */
export function TgHome() {
  const t = useTranslations('tg.home');
  const common = useTranslations('common');
  const me = useMe();
  const name = me.data?.firstName ?? me.data?.username ?? null;

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background px-6 pt-[var(--tg-safe-top,0px)] pb-[var(--tg-safe-bottom,0px)] text-center">
      <Logo name={BRAND.name} size={64} />
      <h1 className="m-0 text-2xl leading-8 font-extrabold text-foreground">
        {name === null ? t('welcomeAnon') : t('welcome', { name })}
      </h1>
      <p className="m-0 text-base text-foreground-secondary">{common('comingSoon')}</p>
    </main>
  );
}
