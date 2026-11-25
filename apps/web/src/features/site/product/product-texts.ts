import type { Locale } from '@repo/shared';
import { getTranslations } from 'next-intl/server';
import type { FactKind, SeoProduct } from './seo-products';

// Texts of the product page that are drawn twice: with the catalog's answer, and invisible inside
// the placeholder that stands in for it (product-skeletons.tsx), which takes their room that way.
// One builder for both keeps the two the same text, and so the same size.

/** What a card's text needs, laid out already: a price is `formatMoney`'s text, never a sum. */
export type FactInput =
  | { kind: 'unitPrice'; amount: string }
  | { kind: 'min'; quantity: number }
  | { kind: 'plans'; count: number }
  | { kind: 'delivery' }
  | { kind: 'recipient' };

export interface FactText {
  kind: FactKind;
  label: string;
  value: string;
}

/**
 * The label and the value of a card under the picture. A value counted in the product's own unit
 * (the price of one star, the minimum in stars) is a text of that product (`site.product.<key>.facts`);
 * only a product whose registry entry lists the card reaches it (seo-products.test checks the texts).
 */
export async function factTexts(
  locale: Locale,
  seo: SeoProduct,
): Promise<(input: FactInput) => FactText> {
  const [t, copy, money] = await Promise.all([
    getTranslations({ locale, namespace: 'site.product.common.facts' }),
    getTranslations({ locale, namespace: `site.product.${seo.contentKey}` }),
    getTranslations({ locale, namespace: 'common.money' }),
  ]);
  return (input) => {
    switch (input.kind) {
      case 'unitPrice':
        return {
          kind: input.kind,
          label: t('unitPrice.label'),
          value: copy('facts.unitPrice.value', { price: money('uzs', { amount: input.amount }) }),
        };
      case 'min':
        return {
          kind: input.kind,
          label: t('min.label'),
          value: copy('facts.min.value', { min: input.quantity }),
        };
      case 'plans':
        return {
          kind: input.kind,
          label: t('plans.label'),
          value: t('plans.value', { count: input.count }),
        };
      case 'delivery':
        return { kind: input.kind, label: t('delivery.label'), value: t('delivery.value') };
      case 'recipient':
        return { kind: input.kind, label: t('recipient.label'), value: t('recipient.value') };
    }
  };
}

/**
 * The small print under the package list: that any amount from the minimum may be typed in the
 * store (`typedMin`, for a product whose page lists the minimum), and that the prices are estimates
 * (when any is shown).
 */
export async function pickerNotes(
  locale: Locale,
  seo: SeoProduct,
  { typedMin, priced }: { typedMin: number | null; priced: boolean },
): Promise<string[]> {
  const [t, copy] = await Promise.all([
    getTranslations({ locale, namespace: 'site.product.common.packages' }),
    getTranslations({ locale, namespace: `site.product.${seo.contentKey}` }),
  ]);
  return [
    typedMin === null ? null : copy('packages.customQty', { min: typedMin }),
    priced ? t('approxNote') : null,
  ].filter((note): note is string => note !== null);
}
