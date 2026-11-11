import type { ReactNode } from 'react';
import { TopupModal } from '../topup/TopupModal';
import { StoreFooter } from './StoreFooter';
import { StoreHeader } from './StoreHeader';

/** The frame of every signed-in web page: the header, the page filling the rest, the footer. */
export function StoreShell({ children }: { children: ReactNode }) {
  return (
    // A page with a pinned buy bar (the product page, below md) leaves room under the footer, so the
    // footer link is not stuck beneath the bar at the end of the page.
    <div className="flex min-h-dvh flex-col bg-background text-foreground max-md:has-[[data-fixed-bar]]:[&>footer]:pb-40">
      <StoreHeader />
      {children}
      <StoreFooter />
      <TopupModal />
    </div>
  );
}
