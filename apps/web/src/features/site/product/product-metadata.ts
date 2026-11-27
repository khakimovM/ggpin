import type { Locale } from '@repo/shared';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { pageMetadata } from '../seo/page-metadata';
import type { SeoProduct } from './seo-products';

/**
 * The metadata of a product page: its title and description from the catalogs, nothing else.
 * RULE (see page-metadata.ts): it never reads the catalog or any API, so the first byte of the
 * page does not wait for one.
 */
export async function productMetadata(locale: Locale, seo: SeoProduct): Promise<Metadata> {
  const t = await getTranslations({ locale, namespace: `site.product.${seo.contentKey}.meta` });
  return pageMetadata({
    locale,
    path: seo.path,
    title: t('title'),
    description: t('description'),
  });
}
