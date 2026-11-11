import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AuthGuard } from '../../../features/auth/AuthGuard';

// The store is private to a signed-in user and has nothing for a crawler. The Next server cannot
// see the cookie session (the API sets it for its own host), so the gate is a client one.
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function StoreLayout({ children }: { children: ReactNode }) {
  return <AuthGuard>{children}</AuthGuard>;
}
