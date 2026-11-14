import { Manrope, Unbounded } from 'next/font/google';

// Handoff fonts: Manrope for text, Unbounded for balances, prices and headlines.
// Both cover Latin (incl. the Uzbek o‘ g‘ letters via latin-ext) and Cyrillic.
// next/font self-hosts them at build time, so no request goes to Google at runtime.
// `preload: false`: next/font would preload all six subset files on every page; the locale layout
// preloads the one headline file its script needs instead (see font-preload.ts).
export const manrope = Manrope({
  subsets: ['latin', 'latin-ext', 'cyrillic'],
  variable: '--font-manrope',
  display: 'swap',
  preload: false,
});

export const unbounded = Unbounded({
  subsets: ['latin', 'latin-ext', 'cyrillic'],
  variable: '--font-unbounded',
  display: 'swap',
  preload: false,
});

export const FONT_CLASSES = `${manrope.variable} ${unbounded.variable}`;
