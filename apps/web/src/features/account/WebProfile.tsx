'use client';

import { Ticket, TicketPercent } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { LogoutButton } from '../auth/LogoutButton';
import { SupportLinkButton } from '../support/SupportLinkButton';
import { AccountPage } from './AccountPage';
import { LanguagePicker } from './LanguagePicker';
import { ProfileCard } from './ProfileCard';
import { ReducedMotionSwitch } from './ReducedMotionSwitch';
import { ReferralCard } from './ReferralCard';
import { ServiceRow } from './ServiceRow';
import { SessionsList } from './SessionsList';
import { ThemePicker } from './ThemePicker';

const CARD = 'flex flex-col gap-3.5 rounded-3xl border border-border bg-card p-[22px]';

/**
 * The web profile (Store.dc.html `profile`): everything the Mini App profile has, plus the phone
 * state, the theme, the signed-in devices and "Chiqish". Two columns from 1024 px. Rendered behind
 * AuthGuard, so `/me` is loaded.
 */
export function WebProfile() {
  const t = useTranslations('account.profile');
  const services = useTranslations('account.profile.services');
  return (
    <AccountPage variant="web">
      <h1 className="m-0 text-3xl leading-9 font-extrabold tracking-[-.02em]">{t('title')}</h1>
      <div className="grid items-start gap-5 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-5">
          <ProfileCard variant="web" />
          <section aria-labelledby="appearance-title" className={CARD}>
            <h2 id="appearance-title" className="m-0 text-lg leading-6 font-extrabold">
              {t('appearance.title')}
            </h2>
            <LanguagePicker variant="web" />
            <ThemePicker />
            <ReducedMotionSwitch />
          </section>
          <LogoutButton className="self-start" />
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          <ReferralCard />
          <section aria-labelledby="services-title" className={CARD}>
            <h2 id="services-title" className="m-0 text-lg leading-6 font-extrabold">
              {services('title')}
            </h2>
            <div className="overflow-hidden rounded-[20px] border border-border">
              <ServiceRow
                icon={TicketPercent}
                tone="bg-primary-soft text-primary-soft-foreground"
                label={services('coupons.label')}
                sub={services('coupons.sub')}
                soon={services('soon')}
              />
              <ServiceRow
                icon={Ticket}
                tone="bg-success-soft text-success-text"
                label={services('bonus.label')}
                soon={services('soon')}
              />
            </div>
            <SupportLinkButton variant="outline" className="w-full">
              {services('help.label')}
            </SupportLinkButton>
          </section>
          <SessionsList />
        </div>
      </div>
    </AccountPage>
  );
}
