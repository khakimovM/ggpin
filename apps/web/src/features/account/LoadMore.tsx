'use client';

import { Button } from '@repo/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';
import type { Feed } from './history-feed';

type LoadMoreFeed = Pick<
  Feed<unknown>,
  'hasMore' | 'loadMore' | 'loadingMore' | 'moreFailed' | 'fetching'
>;

/**
 * "Yana yuklash" under the Mini App list. Scrolling it into view asks for the next page by
 * itself (when the browser can tell); the button is always there for a keyboard, a failed load and
 * a webview that cannot. A failed load is not repeated automatically: the button retries. While
 * the list refreshes in the background nothing is requested either: a refetch re-reads every page
 * loaded so far, and a next page asked in the middle of it would race it.
 */
export function LoadMore({ feed }: { feed: LoadMoreFeed }) {
  const t = useTranslations('account.history');
  const anchor = useRef<HTMLDivElement>(null);
  const { hasMore, loadingMore, moreFailed, fetching } = feed;
  // The callback is a new function on every render; the observer reads the latest through a ref,
  // so it is created once per state change instead of once per render.
  const latest = useRef(feed.loadMore);
  useEffect(() => {
    latest.current = feed.loadMore;
  });

  useEffect(() => {
    const node = anchor.current;
    if (!node || !hasMore || loadingMore || moreFailed || fetching) return;
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) latest.current();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loadingMore, moreFailed, fetching]);

  if (!hasMore) return null;
  const unavailable = loadingMore || fetching;
  return (
    <div ref={anchor} className="flex flex-col items-center gap-2">
      {moreFailed ? (
        <p role="alert" className="m-0 text-[13px] leading-[18px] font-bold text-danger-text">
          {t('loadMoreError')}
        </p>
      ) : null}
      <Button
        variant="secondary"
        className="w-full"
        // aria-disabled, not disabled: a disabled button drops the keyboard focus when a background
        // refresh begins.
        aria-disabled={unavailable}
        data-disabled={unavailable ? '' : undefined}
        onClick={() => {
          if (!unavailable) latest.current();
        }}
      >
        {loadingMore ? t('loadingMore') : t('loadMore')}
      </Button>
    </div>
  );
}
