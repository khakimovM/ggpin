import type { ReactNode } from 'react';

// The marketing pages (landing, product pages, FAQ, legal, contacts). Phase 8 S1 adds the site
// header and footer here; until then the group only separates these pages from the store.
export default function MarketingLayout({ children }: { children: ReactNode }) {
  return children;
}
