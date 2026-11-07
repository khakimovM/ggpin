'use client';

import { useTranslations } from 'next-intl';
import { NotFoundView } from './NotFoundView';

// The Mini App's language is a client state (TgIntlProvider), so the texts are read here.
export function TgNotFound() {
  const t = useTranslations('common.notFound');
  return <NotFoundView title={t('title')} body={t('body')} ctaLabel={t('cta')} href="/tg" />;
}
