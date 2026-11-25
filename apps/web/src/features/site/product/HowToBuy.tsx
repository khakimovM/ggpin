import type { Locale } from '@repo/shared';
import { cn } from '@repo/ui';
import { getTranslations } from 'next-intl/server';
import { LANDING_CONTAINER } from '../landing/landing-styles';
import { PRODUCT_H2, PRODUCT_SECTION_Y } from './product-styles';
import type { SeoProduct } from './seo-products';

const STEPS = ['s1', 's2', 's3'] as const;

/** Site.dc.html "qanday sotib olinadi": three numbered cards on the page's own copy. */
export async function HowToBuy({ locale, seo }: { locale: Locale; seo: SeoProduct }) {
  const t = await getTranslations({ locale, namespace: `site.product.${seo.contentKey}.how` });

  return (
    <section
      aria-labelledby="product-how"
      className={cn(PRODUCT_SECTION_Y, 'border-y border-border bg-surface')}
    >
      <div className={cn(LANDING_CONTAINER, 'flex flex-col gap-7')}>
        <h2 id="product-how" className={PRODUCT_H2}>
          {t('title')}
        </h2>
        <ol className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,280px),1fr))] gap-4 p-0">
          {STEPS.map((step, index) => (
            <li key={step} className="flex gap-4 rounded-3xl border border-border bg-card p-[22px]">
              <span className="font-display text-[26px] leading-none font-bold text-primary">
                {index + 1}
              </span>
              <div className="flex min-w-0 flex-col gap-1.5">
                <h3 className="m-0 text-[17px] leading-[22px] font-extrabold">
                  {t(`${step}.title`)}
                </h3>
                <span className="text-[15px] leading-[22px] font-medium text-foreground-secondary">
                  {t(`${step}.text`)}
                </span>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
