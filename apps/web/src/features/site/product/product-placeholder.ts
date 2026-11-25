import type { Locale } from '@repo/shared';
import { getTranslations } from 'next-intl/server';
import { siteLinks } from '../shell/site-links';
import { factTexts, pickerNotes, type FactInput, type FactText } from './product-texts';
import type { SeoProduct } from './seo-products';

/**
 * Stand-ins for the catalog's numbers inside the placeholder's texts: of the usual length (a price
 * of three digits, a minimum of two), so the invisible text breaks where the real one will. Never
 * shown and never data: the placeholder's text is not even in the page's text (it is drawn by CSS).
 */
const STAND_IN = { amount: '000', quantity: 50 } as const;

/** What the placeholders of the product page hold, so they take the room of the catalog's answer. */
export interface PlaceholderTexts {
  /** The cards the registry lists for the product, with stand-in numbers. */
  facts: FactText[];
  /** The package list's rows: as many as the catalog usually lists. */
  rows: number;
  /** The small print under the list, as the filled list has it. */
  notes: string[];
  /** The Telegram button's label; `null` when no bot is configured (the page has no button then). */
  telegram: string | null;
  /** The status text read out while the catalog is read. */
  loading: string;
}

function standIn(kind: SeoProduct['facts'][number], seo: SeoProduct): FactInput {
  switch (kind) {
    case 'unitPrice':
      return { kind, amount: STAND_IN.amount };
    case 'min':
      return { kind, quantity: STAND_IN.quantity };
    case 'plans':
      return { kind, count: seo.packages };
    case 'delivery':
    case 'recipient':
      return { kind };
  }
}

/**
 * The texts of the filled page (the facts, the small print, the buttons) for its placeholders: the
 * state they stand in for is the usual one, a product with its packages and prices. A thinner
 * answer (no packages, no catalog) then takes less room; the filled one takes exactly this.
 */
export async function placeholderTexts(locale: Locale, seo: SeoProduct): Promise<PlaceholderTexts> {
  const typedMin = seo.facts.includes('min') ? STAND_IN.quantity : null;
  const [text, notes, t] = await Promise.all([
    factTexts(locale, seo),
    pickerNotes(locale, seo, { typedMin, priced: true }),
    getTranslations({ locale, namespace: 'site.product.common' }),
  ]);
  return {
    facts: seo.facts.map((kind) => text(standIn(kind, seo))),
    rows: seo.packages,
    notes,
    telegram: siteLinks().bot === null ? null : t('telegram'),
    loading: t('loading'),
  };
}
