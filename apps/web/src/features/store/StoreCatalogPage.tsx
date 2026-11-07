'use client';

import { useLocale } from 'next-intl';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';
import { localizedPath } from '../../i18n/paths';
import { parseCategory } from '../catalog/catalog-query';
import { CatalogView } from '../catalog/CatalogView';
import { CategorySidebar } from './CategorySidebar';

/**
 * The web catalog (Store.dc.html `page: catalog`): categories on the left from 1024 px (chips
 * above the grid below it) and the products. The selected category lives in the URL
 * (`?category=`), next to the search (`?q=`, kept by the header), so a view can be shared.
 */
export function StoreCatalogPage() {
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const params = useSearchParams();
  const category = parseCategory(params.get('category'));

  const setCategory = useCallback(
    (slug: string | undefined) => {
      const next = new URLSearchParams(params.toString());
      if (slug === undefined) next.delete('category');
      else next.set('category', slug);
      const suffix = next.size > 0 ? `?${next.toString()}` : '';
      router.replace(`${pathname}${suffix}`, { scroll: false });
    },
    [params, pathname, router],
  );

  return (
    <main className="mx-auto grid w-full max-w-[1264px] flex-1 items-start gap-8 px-4 py-6 md:px-8 md:py-8 lg:grid-cols-[248px_minmax(0,1fr)]">
      <CategorySidebar value={category} onChange={setCategory} />
      <CatalogView
        variant="web"
        category={category}
        onCategoryChange={setCategory}
        productHref={(slug) => localizedPath(locale, `/store/products/${slug}`)}
      />
    </main>
  );
}
