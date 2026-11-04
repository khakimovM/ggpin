import { BRAND } from '@repo/shared';
import { getTranslations } from 'next-intl/server';
import { routing } from '../../i18n/routing';

// Placeholder for the Mini App entry; the real screens arrive with S4.
export default async function TelegramHomePage() {
  const t = await getTranslations({ locale: routing.defaultLocale, namespace: 'common' });

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background px-6 text-center">
      <h1 className="font-display text-3xl font-bold text-foreground">{BRAND.name}</h1>
      <p className="text-base text-foreground-secondary">{t('comingSoon')}</p>
    </main>
  );
}
