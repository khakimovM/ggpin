import { BRAND } from '@repo/shared';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { env } from '../../env';
import { FONT_CLASSES } from '../fonts';
import '../globals.css';
import { Providers } from '../providers';

export const metadata: Metadata = {
  metadataBase: new URL(env.NEXT_PUBLIC_SITE_URL),
  title: BRAND.name,
  // The Mini App is an app shell, not a page for search engines.
  robots: { index: false, follow: false },
};

// viewport-fit=cover lets the Telegram safe-area insets be applied in CSS.
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover' };

// The Mini App has no locale prefix: the real locale comes from the user profile after login
// (phase 7 S4). Until then the default locale is used.
export default function TelegramLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="uz" className={FONT_CLASSES}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
