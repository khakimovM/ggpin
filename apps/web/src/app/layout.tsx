import { BRAND } from '@repo/shared';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: BRAND.name,
};

// Locale routing (/[locale]/..., hreflang) arrives with next-intl in phases 7–8; uz is the default.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="uz">
      <body>{children}</body>
    </html>
  );
}
