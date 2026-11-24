import type { Locale } from '@repo/shared';

// The three sections of the landing the header points at. The ids are the same in every language
// (the anchors must not change when the text does); the landing (phase 8 S2) gives its sections
// these ids.
export const NAV_ITEMS = [
  { id: 'products', labelKey: 'products' },
  { id: 'how-it-works', labelKey: 'how' },
  { id: 'faq', labelKey: 'faq' },
] as const;

/**
 * From which viewport width the header shows the full navigation, per language. Russian labels
 * are longer ("Как это работает", "Открыть в Telegram"), so below 1181 px they collapse into the
 * menu; Uzbek collapses at 1040 px and below (Round 9 - Russian QA, fix 6). Both use `min-width`
 * so that the boundary pixel is unambiguous: 1041 px is wide in uz, 1040 px is the menu.
 *
 * The class names are written out in full: Tailwind finds them by scanning the source.
 */
export const NAV_LAYOUT: Record<Locale, { wide: string; narrow: string }> = {
  uz: { wide: 'hidden min-[1041px]:flex', narrow: 'flex min-[1041px]:hidden' },
  ru: { wide: 'hidden min-[1181px]:flex', narrow: 'flex min-[1181px]:hidden' },
};

/** Visible keyboard focus of a link on the site chrome (the browser default is not drawn). */
export const LINK_FOCUS =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
