import type { ReactNode } from 'react';
import { StoreHeader } from './StoreHeader';

/** The frame of every signed-in web page: the header, then the page filling the rest. */
export function StoreShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <StoreHeader />
      {children}
    </div>
  );
}
