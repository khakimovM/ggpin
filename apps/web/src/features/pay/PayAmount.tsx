'use client';

import { Icon } from '@repo/ui';
import { ArrowUpRight, Check, Copy } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { MONEY_PLACEHOLDER } from '../../lib/format/money';
import { formatTiyinString } from '../../lib/format/tiyin';

/** "50 347" -> ["50 ", "347"]: the last three digits are what identifies the payment. */
export function splitTail(formatted: string): { head: string; tail: string } {
  const match = /^(.*?)(\d{3})$/u.exec(formatted);
  return match === null
    ? { head: formatted, tail: '' }
    : { head: match[1] ?? '', tail: match[2] ?? '' };
}

export interface PayAmountProps {
  /** The EXACT amount to transfer (`payAmountTiyin`), the server's string. */
  payAmountTiyin: string;
  copied: boolean;
  onCopy: () => void;
  /** The last poll failed: say the figures may be out of date. */
  stale?: boolean;
  /** 48 px on a wide page (the design); the modal keeps 40. */
  large?: boolean;
}

/**
 * "Send EXACTLY this amount" (PayPage.dc.html, the card with the primary border): the amount in
 * the display face with its last three digits highlighted, and a copy button. The figures are the
 * server's; nothing is rounded or recomputed here.
 */
export function PayAmount({
  payAmountTiyin,
  copied,
  onCopy,
  stale = false,
  large = false,
}: PayAmountProps) {
  const t = useTranslations('pay');
  const common = useTranslations('common');
  const locale = useLocale();
  const formatted = formatTiyinString(payAmountTiyin, locale === 'ru' ? 'ru' : 'uz');
  const { head, tail } = splitTail(formatted ?? MONEY_PLACEHOLDER);
  return (
    <section
      aria-labelledby="pay-amount-label"
      className="flex flex-col gap-3 rounded-[24px] border-2 border-primary bg-card p-5 shadow-md"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id="pay-amount-label" className="m-0 text-[15px] leading-5 font-extrabold">
          {t('exact')}
        </h2>
        {stale ? (
          <span className="flex h-6 items-center rounded-full bg-muted px-2 text-[11px] font-bold whitespace-nowrap text-foreground-muted">
            {t('stale')}
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span
          data-testid="pay-amount"
          className={`font-display text-[40px] leading-[1.15] font-semibold tracking-[-.04em] whitespace-nowrap tabular-nums ${large ? 'lg:text-[48px]' : ''}`}
        >
          {head}
          {tail === '' ? null : (
            <span
              data-testid="pay-amount-tail"
              className="-mx-0.5 rounded-lg bg-accent-soft px-1 text-foreground shadow-[inset_0_-4px_0_var(--accent)]"
            >
              {tail}
            </span>
          )}
        </span>
        <span className="text-xl font-extrabold text-foreground-secondary">
          {common('currency.uzs')}
        </span>
      </div>
      <span className="flex items-center gap-1.5 text-[13px] leading-[18px] font-bold text-accent-soft-foreground">
        <Icon icon={ArrowUpRight} size={14} />
        {t('tailCaption')}
      </span>
      <button
        type="button"
        onClick={onCopy}
        className="flex h-12 items-center justify-center gap-2 rounded-[14px] bg-primary text-[15px] font-extrabold text-primary-foreground transition duration-fast ease-standard focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[.98]"
      >
        <Icon icon={copied ? Check : Copy} size={17} />
        {copied ? t('copiedAmount') : t('copy')}
      </button>
    </section>
  );
}
