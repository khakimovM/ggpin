import { getLocale, getTranslations } from 'next-intl/server';
import { NotFoundView } from '../../features/not-found/NotFoundView';
import { homePath } from '../../i18n/paths';

// Shown inside the locale layout (theme, language) for every URL no page matches: the catch-all
// page next to it throws notFound(), which lands here.
export default async function LocaleNotFound() {
  const t = await getTranslations('common.notFound');
  const locale = await getLocale();
  return (
    <NotFoundView title={t('title')} body={t('body')} ctaLabel={t('cta')} href={homePath(locale)} />
  );
}
