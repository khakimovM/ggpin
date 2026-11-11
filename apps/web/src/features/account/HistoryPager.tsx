'use client';

import { HIT_AREA_44, Icon, cn } from '@repo/ui';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { Feed } from './history-feed';
import { pageWindow } from './page-window';

const BUTTON =
  `relative ${HIT_AREA_44} ` +
  'grid h-10 min-w-10 cursor-pointer place-items-center rounded-xl border-[1.5px] text-sm font-extrabold tabular-nums focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40';

/**
 * The numbered pager of the web history (Store.dc.html): "Jami N tadan a–b" and the page buttons.
 * Every number comes from the server's `meta`; nothing is counted here beyond the arithmetic of
 * which page buttons to draw.
 */
export function HistoryPager({
  feed,
  onPage,
}: {
  feed: Pick<Feed<unknown>, 'page' | 'limit' | 'total' | 'items' | 'fetching'>;
  onPage: (page: number) => void;
}) {
  const t = useTranslations('account.history.pager');
  const totalPages = Math.max(1, Math.ceil(feed.total / feed.limit));
  const from = feed.items.length === 0 ? 0 : (feed.page - 1) * feed.limit + 1;
  const to = (feed.page - 1) * feed.limit + feed.items.length;
  return (
    <nav
      aria-label={t('label')}
      className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3 text-sm leading-5 font-semibold text-foreground-muted tabular-nums"
    >
      <span aria-live="polite">{t('summary', { total: feed.total, from, to })}</span>
      <span className="flex items-center gap-1.5">
        <button
          type="button"
          aria-label={t('prev')}
          disabled={feed.page <= 1}
          onClick={() => onPage(feed.page - 1)}
          className={cn(BUTTON, 'border-border bg-transparent text-foreground')}
        >
          <Icon icon={ChevronLeft} size={17} />
        </button>
        {pageWindow(feed.page, totalPages).map((slot, index) =>
          slot === 'gap' ? (
            <span key={`gap-${index}`} aria-hidden="true" className="px-1">
              …
            </span>
          ) : (
            <button
              key={slot}
              type="button"
              aria-label={t('page', { page: slot })}
              aria-current={slot === feed.page ? 'page' : undefined}
              onClick={() => onPage(slot)}
              className={cn(
                BUTTON,
                slot === feed.page
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-transparent text-foreground',
              )}
            >
              {slot}
            </button>
          ),
        )}
        <button
          type="button"
          aria-label={t('next')}
          disabled={feed.page >= totalPages}
          onClick={() => onPage(feed.page + 1)}
          className={cn(BUTTON, 'border-border bg-transparent text-foreground')}
        >
          <Icon icon={ChevronRight} size={17} />
        </button>
      </span>
    </nav>
  );
}
