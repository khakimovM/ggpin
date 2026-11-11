'use client';

import type { LedgerItem } from '@repo/shared';
import { Icon, cn } from '@repo/ui';
import { ChevronRight } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { formatTime } from '../../lib/format/date';
import { Money } from '../../lib/format/money';
import { LEDGER_LOOK, isCredit } from './ledger-look';

export interface LedgerRowProps {
  item: LedgerItem;
  /** The order page when the entry came from an order, else undefined (a plain row). */
  href?: string;
  withDate?: string;
}

const ROW =
  'grid grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-3 border-t border-border px-4 py-3 text-foreground first:border-t-0';

/**
 * One money movement (Account.dc.html `finance` row). The contract gives the kind, the signed
 * amount, the time and the order it came from, nothing else: no order number, no product, no card.
 * So the title is the kind, and an entry that came from an order links to it.
 */
export function LedgerRow({ item, href, withDate }: LedgerRowProps) {
  const locale = useLocale();
  const t = useTranslations('account.history.ledger.kind');
  const look = LEDGER_LOOK[item.kind];
  const time = formatTime(new Date(item.createdAt), { locale: locale === 'ru' ? 'ru' : 'uz' });
  const body = (
    <>
      <span
        aria-hidden="true"
        className={cn('grid size-11 place-items-center rounded-xl', look.tone)}
      >
        <Icon icon={look.icon} size={19} />
      </span>
      <span className="flex min-w-0 flex-col gap-[3px]">
        <span className="text-[15px] leading-5 font-extrabold break-words">{t(item.kind)}</span>
        {withDate === undefined ? null : (
          <span className="text-xs leading-4 font-semibold text-foreground-muted">{withDate}</span>
        )}
      </span>
      <span className="flex items-center gap-2">
        <span className="flex flex-col items-end gap-[3px]">
          <Money
            tiyin={item.amountTiyin}
            size="md"
            tone={isCredit(item.amountTiyin) ? 'credit' : 'default'}
          />
          <span className="text-xs leading-4 font-semibold text-foreground-muted tabular-nums">
            {time}
          </span>
        </span>
        {href === undefined ? null : (
          <Icon icon={ChevronRight} size={17} className="text-foreground-muted" />
        )}
      </span>
    </>
  );
  return href === undefined ? (
    <div className={ROW}>{body}</div>
  ) : (
    <Link
      href={href}
      className={cn(
        ROW,
        'no-underline transition-colors duration-fast hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
      )}
    >
      {body}
    </Link>
  );
}
