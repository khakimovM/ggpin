'use client';

import { Button } from '@repo/ui';
import { useLocale, useTranslations } from 'next-intl';
import { localizedPath } from '../../i18n/paths';
import { useMe } from '../auth/use-me';

/** Where a sign-in lands until the catalog exists. Rendered behind AuthGuard, so `/me` is loaded. */
export function StoreHome() {
  const t = useTranslations('web.store');
  const common = useTranslations('common');
  const locale = useLocale();
  const me = useMe();
  const name = me.data?.firstName ?? me.data?.username ?? null;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[1264px] flex-col items-start gap-4 px-4 py-8 md:px-8">
      <h1 className="m-0 text-2xl leading-8 font-extrabold">
        {name === null ? t('welcomeAnon') : t('welcome', { name })}
      </h1>
      <p className="m-0 text-base text-foreground-secondary">{common('comingSoon')}</p>
      <Button asChild variant="secondary">
        <a href={localizedPath(locale, '/store/profile')}>{t('profile')}</a>
      </Button>
    </main>
  );
}
