import type { ReactNode } from 'react';
import { StoreShell } from '../../../../features/store/StoreShell';

// The sign-in gate (AuthGuard) is the layout one level up; this adds the store's header around
// every page below it.
export default function StoreSectionLayout({ children }: { children: ReactNode }) {
  return <StoreShell>{children}</StoreShell>;
}
