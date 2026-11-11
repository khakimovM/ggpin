'use client';

import { Badge, ErrorState, Skeleton } from '@repo/ui';
import { useTranslations } from 'next-intl';
import { ReferralLinkBox } from './ReferralLinkBox';
import { ShareLinkButton } from './ShareLinkButton';
import { useReferralLink } from './useReferralLink';

/** The invitation card of the web profile (Store.dc.html): the link, copy, and share where the browser can. */
export function ReferralCard() {
  const t = useTranslations('account.referral');
  const common = useTranslations('common');
  const services = useTranslations('account.profile.services.referral');
  const state = useReferralLink();

  let body;
  if (state.status === 'pending') {
    body = <Skeleton aria-busy="true" className="h-12 rounded-[14px]" />;
  } else if (state.status === 'error') {
    body = (
      <ErrorState
        framed={false}
        title={common('error.network')}
        retryLabel={common('retry')}
        retrying={state.retrying}
        onRetry={state.retry}
      />
    );
  } else if (state.status === 'invalid') {
    body = (
      <p className="m-0 text-[13px] leading-[18px] font-bold text-foreground-secondary">
        {t('unavailable')}
      </p>
    );
  } else {
    body = (
      <>
        <ReferralLinkBox link={state.link} compact />
        <ShareLinkButton link={state.link} variant="web" />
      </>
    );
  }

  return (
    <section
      aria-labelledby="referral-card-title"
      className="flex flex-col gap-3.5 rounded-3xl border border-border bg-card p-[22px]"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id="referral-card-title" className="m-0 text-lg leading-6 font-extrabold">
          {services('label')}
        </h2>
        <Badge size="sm" variant="code">
          {services('sub')}
        </Badge>
      </div>
      {body}
      <p className="m-0 text-[13px] leading-[18px] font-semibold text-foreground-muted">
        {t('stats.body')}
      </p>
    </section>
  );
}
