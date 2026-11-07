import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ThemeScript } from '../../csp/ThemeScript';
import { FONT_CLASSES } from '../fonts';
import '../globals.css';

// Developer-only routes (component gallery). Not indexed; the pages themselves are a 404 in
// production builds.
export const metadata: Metadata = {
  title: 'ui · dev',
  robots: { index: false, follow: false },
};

export default function DevLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="uz" className={FONT_CLASSES} suppressHydrationWarning>
      <head>
        <ThemeScript variant="web" />
      </head>
      <body>{children}</body>
    </html>
  );
}
