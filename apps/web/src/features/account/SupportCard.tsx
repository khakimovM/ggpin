'use client';

import { Icon } from '@repo/ui';
import { Clock, Headset } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { env } from '../../env';
import { supportLink } from '../../telegram/support-link';
import { SupportLinkButton } from '../support/SupportLinkButton';
import { supportHandle } from './referral-link';

/**
 * "Savolingiz qoldimi?" (Account.dc.html): hours and the button to the support chat. The chat is
 * `NEXT_PUBLIC_SUPPORT_URL`; the handle in the note is read from it, never written here. With no
 * link configured the button is not drawn and the card says it is not available.
 */
export function SupportCard() {
  const t = useTranslations('account.help.ask');
  const link = supportLink(env.NEXT_PUBLIC_SUPPORT_URL);
  const handle = link.kind === 'telegram' ? supportHandle(link.href) : null;
  return (
    <section className="flex flex-col gap-3 rounded-3xl bg-primary-soft p-[18px]">
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="grid size-12 shrink-0 place-items-center rounded-full bg-card text-primary-soft-foreground"
        >
          <Icon icon={Headset} size={22} />
        </span>
        <span className="flex flex-col gap-0.5">
          <h2 className="m-0 text-[17px] leading-[22px] font-extrabold">{t('title')}</h2>
          <span className="flex items-center gap-[5px] text-[13px] leading-[18px] font-bold text-foreground-secondary">
            <Icon icon={Clock} size={13} />
            {t('hours')}
          </span>
        </span>
      </div>
      {link.kind === 'none' ? (
        <p className="m-0 text-center text-[13px] leading-[18px] font-bold text-foreground-secondary">
          {t('unavailable')}
        </p>
      ) : (
        <>
          <SupportLinkButton variant="primary" className="h-[52px] w-full text-base">
            {t('cta')}
          </SupportLinkButton>
          <span className="text-center text-xs leading-4 font-semibold text-foreground-muted">
            {handle === null ? t('noteExternal') : t('note', { handle })}
          </span>
        </>
      )}
    </section>
  );
}
