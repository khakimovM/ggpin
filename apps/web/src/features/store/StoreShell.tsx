import type { ReactNode } from 'react';
import { TopupModal } from '../topup/TopupModal';
import { StoreFooter } from './StoreFooter';
import { StoreHeader } from './StoreHeader';

/** The frame of every signed-in web page: the header, the page filling the rest, the footer. */
export function StoreShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <StoreHeader />
      {children}
      <StoreFooter />
      <TopupModal />
    </div>
  );
}
