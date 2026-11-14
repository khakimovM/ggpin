'use client';

import Script from 'next/script';
import { useSyncExternalStore } from 'react';
import { ANALYTICS_BEFORE_SEND } from './analytics-before-send';
import { installAnalyticsFilter } from './analytics-filter';

// Nothing to subscribe to: whether the filter is in place never changes once it is answered.
const subscribe = () => () => {};
// Installing is idempotent (a second call finds our own filter), so React may ask more than once.
const filterInPlace = () => installAnalyticsFilter(window);
// The server has no window: the HTML never carries the tag, it is added only in the browser.
const noFilterOnServer = () => false;

/**
 * The Umami script tag, rendered only once the beacon filter is in place (fail-closed, see
 * installAnalyticsFilter): the server render and the hydration draw nothing; in the browser the
 * filter is installed first, and only a filter that is verifiably ours lets the tag render. If the
 * filter cannot be installed, no script is requested and no beacon can be sent.
 */
export function AnalyticsTracker({
  websiteId,
  nonce,
}: {
  websiteId: string;
  nonce: string | undefined;
}) {
  const filtered = useSyncExternalStore(subscribe, filterInPlace, noFilterOnServer);
  if (!filtered) return null;
  return (
    <Script
      src="/stats/script.js"
      strategy="afterInteractive"
      nonce={nonce}
      data-website-id={websiteId}
      data-exclude-search="true"
      data-exclude-hash="true"
      data-do-not-track="true"
      data-before-send={ANALYTICS_BEFORE_SEND}
    />
  );
}
