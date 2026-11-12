'use client';

import { SiteErrorView } from '../../features/site/shell/SiteErrorView';

// The boundary of everything under a locale that has no chrome of its own: the store and the
// sign-in page. It only catches errors thrown while rendering; the store's loading and failed-request
// states are drawn by the screens themselves and never reach it. (The marketing pages have their
// own boundary inside their layout, so the site header and footer stay.)
export default function LocaleError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <SiteErrorView reset={reset} fullPage />;
}
