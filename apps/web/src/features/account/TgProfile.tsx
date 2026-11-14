'use client';

import { useTranslations } from 'next-intl';
import { AccountPage } from './AccountPage';
import { LanguagePicker } from './LanguagePicker';
import { ProfileCard } from './ProfileCard';
import { ProfileLegalLinks } from './ProfileLegalLinks';
import { ReducedMotionSwitch } from './ReducedMotionSwitch';
import { SectionHeading } from './SectionHeading';
import { ServicesList } from './ServicesList';

/**
 * The Mini App profile (Account.dc.html `profile`): identity and wallet, language, the services
 * list, the motion setting, and the legal links at the foot. There is no phone line here (owner
 * decision Q6): Telegram already knows who the user is.
 */
export function TgProfile() {
  const t = useTranslations('account.profile');
  return (
    <AccountPage variant="tg" tab="profile" title={t('title')}>
      <ProfileCard variant="tg" />
      <section aria-labelledby="language-title" className="flex flex-col gap-2">
        <SectionHeading id="language-title">{t('language.title')}</SectionHeading>
        <LanguagePicker variant="tg" />
      </section>
      <ServicesList />
      <section aria-labelledby="settings-title" className="flex flex-col gap-2">
        <SectionHeading id="settings-title">{t('settings.title')}</SectionHeading>
        <ReducedMotionSwitch />
      </section>
      <ProfileLegalLinks />
    </AccountPage>
  );
}
