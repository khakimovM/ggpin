import type { Locale } from '@repo/shared';
import { cn } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { LANDING_CONTAINER } from '../landing/landing-styles';
import { ProductsGrid } from '../landing/ProductsGrid';
import { ProductsSkeleton } from '../landing/ProductsSkeleton';
import { PRODUCT_H2 } from './product-styles';
import { RELATED_LIMIT } from './seo-products';

/**
 * Site.dc.html "Boshqa mahsulotlar": the landing's tiles (same card, same prices, same "Tez orada"
 * ones) without the page's own product. The heading is static; only the grid waits for the
 * catalog, inside <Suspense>.
 */
export async function RelatedProducts({ locale, exclude }: { locale: Locale; exclude: string }) {
  const [t, products] = await Promise.all([
    getTranslations({ locale, namespace: 'site.product.common.related' }),
    getTranslations({ locale, namespace: 'site.products' }),
  ]);

  return (
    <section aria-labelledby="product-related" className="pb-[clamp(56px,7vw,104px)]">
      <div className={cn(LANDING_CONTAINER, 'flex flex-col gap-6')}>
        <h2 id="product-related" className={PRODUCT_H2}>
          {t('title')}
        </h2>
        <Suspense fallback={<ProductsSkeleton label={products('loading')} tiles={RELATED_LIMIT} />}>
          <ProductsGrid locale={locale} exclude={exclude} limit={RELATED_LIMIT} />
        </Suspense>
      </div>
    </section>
  );
}
