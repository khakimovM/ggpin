'use client';

import { Gift, LifeBuoy, Ticket, TicketPercent } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { SectionHeading } from './SectionHeading';
import { ServiceRow } from './ServiceRow';

/**
 * "Xizmatlar" of the Mini App profile (Account.dc.html `services`): invite friends and help are
 * real screens; discount codes and the bonus code are entries marked "Tez orada" until phase 10
 * (owner decision Q8).
 */
export function ServicesList() {
  const t = useTranslations('account.profile.services');
  return (
    <section aria-labelledby="services-title" className="flex flex-col gap-2">
      <SectionHeading id="services-title">{t('title')}</SectionHeading>
      <div className="overflow-hidden rounded-[20px] border border-border bg-card">
        <ServiceRow
          icon={Gift}
          tone="bg-accent-soft text-accent-soft-foreground"
          label={t('referral.label')}
          sub={t('referral.sub')}
          href="/tg/referral"
        />
        <ServiceRow
          icon={TicketPercent}
          tone="bg-primary-soft text-primary-soft-foreground"
          label={t('coupons.label')}
          sub={t('coupons.sub')}
          soon={t('soon')}
        />
        <ServiceRow
          icon={Ticket}
          tone="bg-success-soft text-success-text"
          label={t('bonus.label')}
          soon={t('soon')}
        />
        <ServiceRow
          icon={LifeBuoy}
          tone="bg-info-soft text-info-text"
          label={t('help.label')}
          href="/tg/help"
        />
      </div>
    </section>
  );
}
