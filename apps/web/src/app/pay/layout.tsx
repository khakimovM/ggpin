import { BRAND } from '@repo/shared';
import { ThemeProvider } from '@repo/ui';
import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { ThemeScript } from '../../csp/ThemeScript';
import { env } from '../../env';
import { PAY_LOCALE_HEADER } from '../../features/pay/pay-locale';
import { FONT_CLASSES } from '../fonts';
import '../globals.css';
import { Providers } from '../providers';

export const metadata: Metadata = {
  metadataBase: new URL(env.NEXT_PUBLIC_SITE_URL),
  title: BRAND.name,
  // A page with a card number and an exact amount: never indexed (the header says so too).
  robots: { index: false, follow: false },
  // The address bar carries a capability token in its fragment: no referrer, whatever links out.
  referrer: 'no-referrer',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover' };

// A root layout of its own: /pay has no locale prefix (the language is `?locale=`, read by the
// page) and no session. Only the query client and the theme are provided; no auth, no wallet, no
// Telegram. Fonts are self-hosted by next/font; there is no third-party script, style or image.
export default async function PayLayout({ children }: { children: ReactNode }) {
  const lang = (await headers()).get(PAY_LOCALE_HEADER) === 'ru' ? 'ru' : 'uz';
  return (
    <html lang={lang} className={FONT_CLASSES} suppressHydrationWarning>
      <head>
        <ThemeScript variant="web" />
      </head>
      <body>
        <ThemeProvider variant="web">
          <Providers>{children}</Providers>
        </ThemeProvider>
      </body>
    </html>
  );
}
