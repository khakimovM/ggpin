import type { Locale } from '@repo/shared';
import { cn, Icon } from '@repo/ui';
import { ArrowRight } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { SiteLink } from '../shell/SiteLink';
import { Suspense } from 'react';
import { storePath } from '../../../i18n/paths';
import { LINK_FOCUS } from '../shell/nav-config';
import {
  LANDING_ANCHOR,
  LANDING_CONTAINER,
  LANDING_H2,
  LANDING_LEAD,
  LANDING_SECTION_Y,
} from './landing-styles';
import { ProductsGrid } from './ProductsGrid';
import { ProductsSkeleton } from './ProductsSkeleton';

/**
 * Site.dc.html `#mahsulotlar`. The heading and the link to the store are static; only the grid
 * waits for the catalog, inside <Suspense>, so the hero and the rest of the page are never held
 * back by a slow API (see catalog-server.ts).
 */
export async function ProductsSection({ locale }: { locale: Locale }) {
  const t = await getTranslations({ locale, namespace: 'site.products' });

  return (
    <section
      id="products"
      aria-labelledby="products-title"
      className={cn(LANDING_ANCHOR, LANDING_SECTION_Y)}
    >
      <div className={cn(LANDING_CONTAINER, 'flex flex-col gap-7')}>
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="flex min-w-0 flex-col gap-2">
            <h2 id="products-title" className={LANDING_H2}>
              {t('title')}
            </h2>
            <p className={LANDING_LEAD}>{t('lead')}</p>
          </div>
          <SiteLink
            href={storePath(locale)}
            prefetch={false}
            className={cn(
              'inline-flex h-11 items-center gap-1.5 text-[15px] leading-none font-bold text-primary-soft-foreground no-underline hover:text-primary',
              LINK_FOCUS,
            )}
          >
            {t('all')}
            <Icon icon={ArrowRight} size={16} />
          </SiteLink>
        </div>
        <Suspense fallback={<ProductsSkeleton label={t('loading')} />}>
          <ProductsGrid locale={locale} />
        </Suspense>
      </div>
    </section>
  );
}
