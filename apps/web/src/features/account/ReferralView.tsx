'use client';

import { EmptyState, ErrorState, Icon, Skeleton } from '@repo/ui';
import { LinkIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { AccountPage } from './AccountPage';
import { ReferralLinkBox } from './ReferralLinkBox';
import { ReferralStats } from './ReferralStats';
import { ShareLinkButton } from './ShareLinkButton';
import { useReferralLink } from './useReferralLink';

/**
 * "Do‘stlarni taklif qilish" (Account.dc.html `referral`): the 1% promise, the user's link with
 * copy and share, and the statistics entry ("Tez orada", Q8). The link is built from the bot's
 * username in env and the user's `referralCode`. Three ways it can be missing: `/me` is loading
 * (skeleton), `/me` failed (error with a retry), the code is not usable (a plain message).
 */
export function ReferralView() {
  const t = useTranslations('account.referral');
  const common = useTranslations('common');
  const state = useReferralLink();

  let card;
  if (state.status === 'pending') {
    card = <Skeleton aria-busy="true" className="h-[168px] rounded-3xl" />;
  } else if (state.status === 'error') {
    card = (
      <ErrorState
        title={common('error.network')}
        retryLabel={common('retry')}
        retrying={state.retrying}
        onRetry={state.retry}
      />
    );
  } else if (state.status === 'invalid') {
    card = <EmptyState icon={<Icon icon={LinkIcon} size={24} />} title={t('unavailable')} />;
  } else {
    card = (
      <div className="flex flex-col gap-2.5 rounded-3xl border border-border bg-card p-4">
        <span className="text-[13px] leading-[18px] font-bold text-foreground-secondary">
          {t('linkLabel')}
        </span>
        <ReferralLinkBox link={state.link} />
        <ShareLinkButton link={state.link} variant="tg" />
      </div>
    );
  }

  return (
    <AccountPage variant="tg" title={t('title')}>
      <div className="relative grid aspect-video place-items-center overflow-hidden rounded-3xl bg-[radial-gradient(120%_100%_at_80%_0%,var(--accent-soft),var(--primary-soft))]">
        <span
          aria-hidden="true"
          className="grid size-[104px] place-items-center rounded-full bg-accent font-display text-[34px] leading-none font-bold tracking-[-.04em] text-accent-foreground shadow-[0_0_0_14px_color-mix(in_oklab,var(--accent)_22%,transparent),0_0_0_28px_color-mix(in_oklab,var(--accent)_10%,transparent)]"
        >
          1%
        </span>
      </div>
      <p className="m-0 text-[17px] leading-6 font-bold text-pretty">{t('hero')}</p>
      {card}
      <ReferralStats title={t('stats.title')} body={t('stats.body')} soon={t('soon')} />
    </AccountPage>
  );
}
