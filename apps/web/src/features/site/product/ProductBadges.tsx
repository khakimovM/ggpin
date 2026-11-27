import type { Locale } from '@repo/shared';
import { Badge, Icon } from '@repo/ui';
import { Globe } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { loadProduct } from './product-data';
import { buildProductView } from './product-view';
import type { SeoProduct } from './seo-products';

/**
 * The chips above the title: how it is delivered (`isAuto`) and the region (`regionBadge`). The
 * row is drawn here, not by the hero, so a product with no chip (the catalog does not know it)
 * leaves no empty row and gap behind.
 */
export async function ProductBadges({ locale, seo }: { locale: Locale; seo: SeoProduct }) {
  const [t, lookup] = await Promise.all([
    getTranslations({ locale, namespace: 'store.catalog' }),
    loadProduct(seo.slug, locale),
  ]);
  const view = buildProductView(lookup, seo);
  if (!view.auto && view.regionBadge === null) return null;

  return (
    <div className="flex min-h-6 flex-wrap gap-1.5">
      {view.auto ? (
        <Badge variant="auto">
          <span aria-hidden="true">⚡</span>
          {t('badge.auto')}
        </Badge>
      ) : null}
      {view.regionBadge === null ? null : (
        <Badge variant="region" icon={<Icon icon={Globe} size={12} />}>
          {view.regionBadge}
        </Badge>
      )}
    </div>
  );
}
