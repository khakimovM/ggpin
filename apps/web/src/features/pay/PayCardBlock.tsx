'use client';

import type { TopupCardView } from '@repo/shared';
import { Icon } from '@repo/ui';
import { Check, Copy, Eye, EyeOff, UserCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

const BANK_NAME = { HUMO: 'Humo', UZCARD: 'Uzcard' } as const;

/**
 * Drawn blurred in place of a hidden group. Not the real digits: a CSS blur over them would still
 * leave them in the DOM, in a text selection and to anyone who unblurs a screenshot. Not stand-in
 * digits either: copied by hand or read off a screenshot, "9860 0000 0000 9012" passes for a real
 * 16-digit card in a bank app.
 */
const HIDDEN_GROUP = '••••';

/** "9860123456789012" -> ["9860", "1234", "5678", "9012"]. */
export function cardGroups(number: string): string[] {
  return number.match(/\d{1,4}/g) ?? [];
}

/** Owner decision 2026-11-09: while hidden, only the first and the last group are shown. */
export function isHiddenGroup(index: number, count: number): boolean {
  return index > 0 && index < count - 1;
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
 *
 * The middle digits start hidden (against a look over the shoulder or a shared screenshot) and the
 * eye button shows them. Copy always copies the full number: that is what the bank app needs.
 */
export function PayCardBlock({ card, copied, onCopy }: PayCardBlockProps) {
  const t = useTranslations('pay');
  const [revealed, setRevealed] = useState(false);
  const groups = cardGroups(card.number);
  const label = revealed
    ? groups.join(' ')
    : t('cardMasked', { first: groups[0] ?? '', last: groups[groups.length - 1] ?? '' });
  return (
    <section
      aria-labelledby="pay-card-label"
      className="flex flex-col gap-3.5 rounded-[24px] border border-border bg-card p-5"
    >
      {/* The eye sits by the title, not after the digits: at 375 px the digits need the whole row. */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-0.5">
          <h2 id="pay-card-label" className="m-0 text-[15px] leading-5 font-extrabold">
            {t('cardNumber')}
          </h2>
          <button
            type="button"
            data-testid="pay-card-reveal"
            onClick={() => setRevealed((shown) => !shown)}
            aria-label={revealed ? t('hideCard') : t('showCard')}
            className="-my-2 grid size-11 shrink-0 place-items-center rounded-xl text-foreground-secondary transition duration-fast ease-standard focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[.94]"
          >
            <Icon icon={revealed ? EyeOff : Eye} size={20} />
          </button>
        </div>
        <span className="rounded-full border border-border bg-muted px-3 text-[13px] leading-[28px] font-extrabold">
          {BANK_NAME[card.bank]}
        </span>
      </div>
      <div
        data-testid="pay-card-number"
        role="text"
        aria-label={label}
        className="flex flex-wrap gap-x-3 gap-y-1 text-2xl leading-[1.2] font-extrabold tracking-[.02em] tabular-nums"
      >
        {groups.map((group, index) =>
          !revealed && isHiddenGroup(index, groups.length) ? (
            <span
              key={index}
              aria-hidden="true"
              data-hidden=""
              className="pointer-events-none blur-[6px] select-none"
            >
              {HIDDEN_GROUP}
            </span>
          ) : (
            <span key={index} aria-hidden="true">
              {group}
            </span>
          ),
        )}
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
