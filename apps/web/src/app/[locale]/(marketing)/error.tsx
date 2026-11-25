'use client';

import { SiteErrorView } from '../../../features/site/shell/SiteErrorView';

// Inside the marketing layout: the site header and footer stay around the message.
export default function MarketingError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <SiteErrorView reset={reset} fullPage={false} />;
}
