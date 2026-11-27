import type { Locale } from '@repo/shared';
import { cn } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { FaqAccordion, type FaqItem } from '../faq/FaqAccordion';
import { LANDING_CONTAINER } from '../landing/landing-styles';
import { PRODUCT_H2, PRODUCT_SECTION_Y } from './product-styles';
import type { SeoProduct } from './seo-products';

/** Site.dc.html "bo‘yicha savollar": the heading and the accordion (the first answer open). */
export async function ProductFaq({
  locale,
  seo,
  items,
}: {
  locale: Locale;
  seo: SeoProduct;
  items: readonly FaqItem[];
}) {
  const t = await getTranslations({ locale, namespace: `site.product.${seo.contentKey}.faq` });

  return (
    <section aria-labelledby="product-faq" className={PRODUCT_SECTION_Y}>
      <div
        className={cn(
          LANDING_CONTAINER,
          'grid grid-cols-[repeat(auto-fit,minmax(min(100%,340px),1fr))] items-start gap-x-16 gap-y-6',
        )}
      >
        <h2 id="product-faq" className={PRODUCT_H2}>
          {t('title')}
        </h2>
        <FaqAccordion items={items} group="product-faq" />
      </div>
    </section>
  );
}
