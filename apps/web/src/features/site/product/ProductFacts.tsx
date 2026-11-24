import type { Locale } from '@repo/shared';
import { cn } from '@repo/ui';
import { landingPriceAmount } from '../landing/landing-products';
import { loadProduct } from './product-data';
import { FACT_CARD, FACT_GRID, FACT_LABEL, FACT_VALUE } from './product-styles';
import { factTexts, type FactInput } from './product-texts';
import { buildProductView, productFacts, type ProductFact } from './product-view';
import type { SeoProduct } from './seo-products';

/** The price is laid out by `formatMoney` here; with no price there is no card, never a zero. */
function inputOf(fact: ProductFact, locale: Locale): FactInput | null {
  if (fact.kind !== 'unitPrice') return fact;
  const amount = landingPriceAmount(fact.tiyin, locale);
  return amount === null ? null : { kind: fact.kind, amount };
}

/**
 * The cards under the picture (Site.dc.html: Narx / Minimal / Yetkazish): the page's facts about
 * the product, each only when there is something true to say. The price is the server's
 * `unitPriceTiyin`. Sizes and texts are shared with the placeholder (FactsSkeleton), which takes
 * the same room until this answer arrives.
 */
export async function ProductFacts({ locale, seo }: { locale: Locale; seo: SeoProduct }) {
  const [text, lookup] = await Promise.all([factTexts(locale, seo), loadProduct(seo.slug, locale)]);
  const cards = productFacts(buildProductView(lookup, seo), seo).flatMap((fact) => {
    const input = inputOf(fact, locale);
    return input === null ? [] : [text(input)];
  });
  if (cards.length === 0) return null;

  return (
    <dl className={FACT_GRID}>
      {cards.map((card) => (
        <div key={card.kind} className={FACT_CARD}>
          <dt className={cn(FACT_LABEL, 'text-foreground-muted')}>{card.label}</dt>
          <dd className={FACT_VALUE}>{card.value}</dd>
        </div>
      ))}
    </dl>
  );
}
