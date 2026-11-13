import type { Locale } from '@repo/shared';
import { cn, Icon } from '@repo/ui';
import { Crown, Star } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { LANDING_CONTAINER } from '../landing/landing-styles';
import { ProductBadges } from './ProductBadges';
import { ProductBuyPanel } from './ProductBuyPanel';
import { ProductFacts } from './ProductFacts';
import { placeholderTexts } from './product-placeholder';
import { BadgesSkeleton, BuyPanelSkeleton, FactsSkeleton } from './product-skeletons';
import type { SeoGlyph, SeoProduct } from './seo-products';

// The picture of the design (an image slot) is not delivered: the product is drawn with its glyph
// on its own tint, as the landing's tiles are.
const GLYPH: Record<SeoGlyph, { icon: typeof Star; box: string; glyph: string }> = {
  star: { icon: Star, box: 'bg-star-soft', glyph: 'text-star' },
  crown: { icon: Crown, box: 'bg-premium-soft', glyph: 'text-premium' },
};

/**
 * Site.dc.html `page: product`, first block: the picture and the facts on one side; the chips, the
 * title, the lead and the package list on the other. The title and the lead are static (the
 * page's own copy), so they are in the first bytes; the three blocks that need the catalog (the
 * facts, the chips, the package list) each sit in a <Suspense> and show a placeholder of their
 * own size until the answer arrives.
 */
export async function ProductHero({ locale, seo }: { locale: Locale; seo: SeoProduct }) {
  const [names, copy, placeholder] = await Promise.all([
    getTranslations({ locale, namespace: 'site.products.names' }),
    getTranslations({ locale, namespace: `site.product.${seo.contentKey}` }),
    placeholderTexts(locale, seo),
  ]);
  const glyph = GLYPH[seo.glyph];

  return (
    <section
      aria-labelledby="product-title"
      className={cn(
        LANDING_CONTAINER,
        'grid grid-cols-[repeat(auto-fit,minmax(min(100%,480px),1fr))] items-start gap-[clamp(24px,4vw,56px)] pt-[clamp(20px,3vw,40px)] pb-[clamp(48px,6vw,88px)]',
      )}
    >
      <div className="flex min-w-0 flex-col gap-5">
        <div
          aria-hidden="true"
          className={cn(
            'relative grid aspect-[4/3] place-items-center overflow-hidden rounded-[28px] border border-border',
            glyph.box,
            glyph.glyph,
          )}
        >
          <Icon icon={glyph.icon} size={112} strokeWidth={1.5} />
        </div>
        <Suspense fallback={<FactsSkeleton cards={placeholder.facts} />}>
          <ProductFacts locale={locale} seo={seo} />
        </Suspense>
      </div>
      <div className="flex min-w-0 flex-col gap-5">
        <Suspense fallback={<BadgesSkeleton />}>
          <ProductBadges locale={locale} seo={seo} />
        </Suspense>
        <h1
          id="product-title"
          className="m-0 font-display text-[clamp(30px,3.4vw,48px)] leading-[1.1] font-bold tracking-[-.035em] text-balance break-words"
        >
          {names(seo.nameKey)}
        </h1>
        <p className="m-0 text-[17px] leading-[26px] font-medium text-pretty text-foreground-secondary">
          {copy('lead')}
        </p>
        <Suspense fallback={<BuyPanelSkeleton texts={placeholder} />}>
          <ProductBuyPanel locale={locale} seo={seo} />
        </Suspense>
      </div>
    </section>
  );
}
