'use client';

import { Button, EmptyState, ErrorState, Icon, Skeleton } from '@repo/ui';
import { PackageSearch, SearchX } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { localizedPath } from '../../i18n/paths';
import { useOnline } from '../../lib/use-online';
import { isApiError } from '../../lib/api/errors';
import { groupByCategory, type CatalogSection } from './catalog-query';
import { CatalogSections, type CatalogVariant } from './CatalogSections';
import { CatalogSkeleton } from './CatalogSkeleton';
import { CategoriesError } from './CategoriesError';
import { CategoryChips } from './CategoryChips';
import { OfflineBanner } from './OfflineBanner';
import { PromoCarousel } from './PromoCarousel';
import { useCatalogSearch } from './use-catalog-search';
import { useCategories } from './use-categories';
import { useProducts } from './use-products';

interface CatalogViewProps {
  variant: CatalogVariant;
  /** The selected category slug (undefined: all). The caller keeps it (state or URL). */
  category: string | undefined;
  onCategoryChange: (slug: string | undefined) => void;
  productHref: (slug: string) => string;
}

/**
 * The catalog below the search box: category chips, and one of the four states of the product
 * list: skeleton, error with a retry, empty (no products, nothing in this category, nothing
 * found) with its way out, and the products. An offline banner shows whenever the browser has no
 * connection or the last request found none, above whatever is cached.
 */
export function CatalogView({
  variant,
  category,
  onCategoryChange,
  productHref,
}: CatalogViewProps) {
  const t = useTranslations('store.catalog');
  const locale = useLocale();
  const common = useTranslations('common');
  const search = useCatalogSearch();
  const categories = useCategories();
  const products = useProducts({ category, q: search.query });
  const online = useOnline();
  const web = variant === 'web';

  const networkDown =
    !online ||
    [categories.error, products.error].some(
      (error) => isApiError(error) && error.code === 'NETWORK',
    );
  const retry = () => void Promise.all([categories.refetch(), products.refetch()]);

  const names = categories.data ?? [];
  const items = products.data?.items ?? [];
  const searching = search.query !== '';
  const selected = names.find((entry) => entry.slug === category);

  let sections: CatalogSection[];
  // The web grid is one flat list (the categories are the column or the chips beside it); the
  // Mini App groups products under their category titles.
  if (searching || web) sections = items.length === 0 ? [] : [{ category: null, items }];
  else if (selected !== undefined)
    sections = items.length === 0 ? [] : [{ category: selected, items }];
  else sections = groupByCategory(names, items);

  const heading = searching
    ? t('results')
    : (selected?.name ?? (web ? t('allProducts') : t('title')));
  // The announcements belong to the unfiltered catalog (Store.dc.html `showPromo`).
  const showPromo = web && !searching && category === undefined && products.data !== undefined;
  // Only a Premium that is on sale, and only from the answer for this very filter (not the
  // previous one kept while the new one loads).
  const hasPremium =
    !products.isPlaceholderData &&
    items.some((item) => item.slug === 'telegram-premium' && item.inStock);

  let body;
  if (products.isPending) {
    body = (
      <CatalogSkeleton
        label={t('loading')}
        columns={web ? 'grid-cols-2 sm:grid-cols-3 xl:grid-cols-4' : 'grid-cols-2'}
      />
    );
  } else if (products.isError && products.data === undefined) {
    // A failed new filter has no data (placeholderData only shows while pending), so the previous
    // filter's products can never appear under its error.
    body = (
      <ErrorState
        title={t('error.title')}
        description={t('error.body')}
        retryLabel={common('retry')}
        retrying={products.isFetching}
        onRetry={retry}
      />
    );
  } else if (items.length === 0 && searching) {
    body = (
      <EmptyState
        icon={<Icon icon={SearchX} size={24} />}
        title={t('noResults.title')}
        description={t('noResults.body', { query: search.query })}
        action={
          <Button variant="secondary" onClick={search.clear}>
            {t('noResults.cta')}
          </Button>
        }
      />
    );
  } else if (items.length === 0 && category !== undefined) {
    body = (
      <EmptyState
        icon={<Icon icon={PackageSearch} size={24} />}
        title={t('emptyCategory.title')}
        action={
          <Button variant="secondary" onClick={() => onCategoryChange(undefined)}>
            {t('emptyCategory.cta')}
          </Button>
        }
      />
    );
  } else if (items.length === 0) {
    body = (
      <EmptyState
        icon={<Icon icon={PackageSearch} size={24} />}
        title={t('empty.title')}
        description={t('empty.body')}
        action={
          <Button variant="secondary" onClick={retry}>
            {common('retry')}
          </Button>
        }
      />
    );
  } else {
    body = (
      <>
        <CatalogSections
          variant={variant}
          sections={sections}
          fallbackTitle={searching ? heading : null}
          productHref={productHref}
        />
      </>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-5" data-testid="catalog">
      {networkDown ? <OfflineBanner onRetry={retry} /> : null}
      {categories.isPending ? (
        <div aria-hidden="true" className="flex gap-2">
          {[84, 88, 80, 96].map((width) => (
            <Skeleton key={width} className="h-9 rounded-full" style={{ width }} />
          ))}
        </div>
      ) : categories.isError && categories.data === undefined ? (
        <CategoriesError
          onRetry={() => void categories.refetch()}
          retrying={categories.isFetching}
        />
      ) : names.length > 0 ? (
        <CategoryChips
          categories={names}
          value={category}
          onChange={onCategoryChange}
          counts={web}
          className={web ? 'lg:hidden' : undefined}
        />
      ) : null}
      {showPromo ? (
        <PromoCarousel
          referralHref={localizedPath(locale, '/store/profile')}
          giftHref={hasPremium ? localizedPath(locale, '/store/products/telegram-premium') : null}
        />
      ) : null}
      {web ? (
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="m-0 text-[28px] leading-[34px] font-extrabold tracking-[-.02em]">
            {heading}
          </h1>
          {items.length > 0 ? (
            <span className="text-sm leading-5 font-bold text-foreground-muted tabular-nums">
              {t('count', { count: items.length })}
            </span>
          ) : null}
        </div>
      ) : null}
      {/* While a new filter loads, the previous grid stays, dimmed and marked busy. */}
      <div
        aria-busy={products.isPlaceholderData ? true : undefined}
        className={products.isPlaceholderData ? 'opacity-60 transition-opacity' : undefined}
      >
        {body}
      </div>
    </div>
  );
}
