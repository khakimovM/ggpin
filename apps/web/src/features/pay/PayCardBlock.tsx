'use client';

import type { TopupCardView } from '@repo/shared';
import { Icon } from '@repo/ui';
import { Check, Copy, UserCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';

const BANK_NAME = { HUMO: 'Humo', UZCARD: 'Uzcard' } as const;

/** "9860123456789012" -> ["9860", "1234", "5678", "9012"]. */
export function cardGroups(number: string): string[] {
  return number.match(/\d{1,4}/g) ?? [];
}

export interface PayCardBlockProps {
  card: TopupCardView;
  copied: boolean;
  onCopy: () => void;
}

/**
 * Our receiving card (PayPage.dc.html): the bank, the 16 digits in groups of four, a copy button
 * and the holder's SHORT name with the reminder to check it in the bank app. It is shown only to
 * the owner of a waiting request.
 */
export function PayCardBlock({ card, copied, onCopy }: PayCardBlockProps) {
  const t = useTranslations('pay');
  const groups = cardGroups(card.number);
  return (
    <section
      aria-labelledby="pay-card-label"
      className="flex flex-col gap-3.5 rounded-[24px] border border-border bg-card p-5"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id="pay-card-label" className="m-0 text-[15px] leading-5 font-extrabold">
          {t('cardNumber')}
        </h2>
        <span className="rounded-full border border-border bg-muted px-3 text-[13px] leading-[28px] font-extrabold">
          {BANK_NAME[card.bank]}
        </span>
      </div>
      <div
        data-testid="pay-card-number"
        role="text"
        aria-label={groups.join(' ')}
        className="flex flex-wrap gap-x-3 gap-y-1 text-2xl leading-[1.2] font-extrabold tracking-[.02em] tabular-nums"
      >
        {groups.map((group, index) => (
          <span key={index} aria-hidden="true">
            {group}
          </span>
        ))}
      </div>
      <button
        type="button"
        onClick={onCopy}
        className="flex h-11 items-center justify-center gap-2 rounded-xl border-[1.5px] border-border bg-transparent text-sm font-extrabold transition duration-fast ease-standard focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[.98]"
      >
        <Icon icon={copied ? Check : Copy} size={16} />
        {copied ? t('copiedCard') : t('copy')}
      </button>
      <div className="flex flex-col gap-1 border-t border-border pt-3">
        <span className="flex justify-between gap-2 text-sm leading-5 font-semibold">
          <span className="text-foreground-muted">{t('holder')}</span>
          <span data-testid="pay-card-holder" className="font-extrabold tracking-[.04em]">
            {card.holderName}
          </span>
        </span>
        <span className="flex gap-1.5 text-[13px] leading-[18px] font-semibold text-foreground-secondary">
          <Icon icon={UserCheck} size={14} className="mt-0.5 shrink-0" />
          {t('holderCheck')}
        </span>
      </div>
    </section>
  );
}
