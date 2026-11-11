'use client';

import { HIT_AREA_44, Icon, cn } from '@repo/ui';
import { Check, Copy } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCopy } from './use-copy';

/**
 * The link in its field with a copy button (Account.dc.html `refLink`). The link is shown as the
 * text it is (monospace, cut with an ellipsis); the button's label changes to "Nusxalandi" for a
 * moment instead of showing a toast.
 */
export function ReferralLinkBox({ link, compact }: { link: string; compact?: boolean }) {
  const t = useTranslations('account.referral');
  const { copied, copy } = useCopy();
  return (
    <div
      className={cn(
        'flex items-center gap-1.5 rounded-[14px] border-[1.5px] border-input-border bg-input pr-1 pl-3.5',
        compact ? 'h-12' : 'h-[52px]',
      )}
    >
      <span
        dir="ltr"
        className="min-w-0 flex-1 truncate font-mono text-[13px] leading-none font-semibold text-foreground-secondary"
      >
        {link.replace(/^https:\/\//, '')}
      </span>
      <button
        type="button"
        onClick={() => copy(link)}
        className={cn(
          'relative flex min-w-[118px] flex-none items-center justify-center gap-1.5 rounded-[11px] border-none bg-primary-soft px-3 text-[13px] leading-none font-extrabold text-primary-soft-foreground focus-visible:outline-2 focus-visible:outline-ring',
          HIT_AREA_44,
          compact ? 'h-10' : 'h-11',
          copied && 'text-success-text',
        )}
      >
        <Icon icon={copied ? Check : Copy} size={15} />
        <span aria-live="polite">{copied ? t('copied') : t('copy')}</span>
      </button>
    </div>
  );
}
