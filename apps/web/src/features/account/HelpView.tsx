'use client';

import { useTranslations } from 'next-intl';
import { AccountPage } from './AccountPage';
import { FaqList } from './FaqList';
import { SupportCard } from './SupportCard';

/** "Yordam": the answers people look for first, then the way to a person. Mini App only. */
export function HelpView() {
  const t = useTranslations('account.help');
  return (
    <AccountPage variant="tg" title={t('title')}>
      <section aria-label={t('faqLabel')}>
        <FaqList />
      </section>
      <SupportCard />
    </AccountPage>
  );
}
