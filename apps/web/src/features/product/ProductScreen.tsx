'use client';

import type { CatalogProductDetail } from '@repo/shared';
import { ErrorState, Icon } from '@repo/ui';
import { ChevronRight } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { localizedPath } from '../../i18n/paths';
import { isApiError } from '../../lib/api/errors';
import { useProduct } from '../catalog/use-product';
import { ProductHeader } from './ProductHeader';
import { ProductSkeleton } from './ProductSkeleton';
import { ProductUnavailable } from './ProductUnavailable';
import { PurchaseView } from './PurchaseView';
import { isInStock, isSupported } from './selection';

export interface ProductScreenProps {
  variant: 'tg' | 'web';
  slug: string;
}

/** Whether the server said "no such product" (a 404, or an id that is not even well formed). */
function isMissing(error: unknown): boolean {
  return isApiError(error) && (error.code === 'NOT_FOUND' || error.status === 404);
}

/**
 * The product page (Product.dc.html / Store.dc.html `page: product`) for the Mini App and the web
 * store. The catalog is real data; the four states are: skeleton, error with a retry, the
 * unavailable page (missing, sold out or not sellable here yet, with a way back), and the
 * purchase form.
 */
export function ProductScreen({ variant, slug }: ProductScreenProps) {
  const t = useTranslations('store.product');
  const common = useTranslations('common');
  const locale = useLocale();
  const query = useProduct(slug);
  const web = variant === 'web';
  const catalogHref = web ? localizedPath(locale, '/store') : '/tg';
  const product = query.data;
  const field = product?.inputSchema[0];
  const sellable =
    product !== undefined && field !== undefined && isSupported(product) && isInStock(product);

  let body;
  if (query.isPending) {
    body = <ProductSkeleton label={t('loading')} />;
  } else if (query.isError && isMissing(query.error)) {
    body = <ProductUnavailable catalogHref={catalogHref} />;
  } else if (query.isError || product === undefined) {
    body = (
      <ErrorState
        title={t('error.title')}
        description={t('error.body')}
        retryLabel={common('retry')}
        retrying={query.isFetching}
        onRetry={() => void query.refetch()}
      />
    );
  } else if (!sellable || field === undefined) {
    body = (
      <>
        <ProductHeader product={product} size={web ? 'roomy' : 'compact'} dimmed />
        <ProductUnavailable catalogHref={catalogHref} />
      </>
    );
  } else {
    body = <Purchase variant={variant} product={product} field={field} />;
  }

  if (!web) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-[640px] flex-col gap-4 bg-background px-4 pt-[max(12px,var(--tg-safe-top,0px))] pb-[max(32px,var(--tg-safe-bottom,0px))] text-foreground">
        {body}
      </main>
    );
  }
  return (
    <main className="mx-auto flex w-full max-w-[1264px] flex-1 flex-col gap-4 px-4 pt-6 pb-40 md:px-8 md:pt-8 lg:pb-8">
      <nav aria-label={t('breadcrumb')}>
        <ol className="m-0 flex list-none items-center gap-1.5 p-0 text-[13px] leading-5 font-semibold text-foreground-muted">
          <li>
            <Link href={catalogHref} className="text-foreground-muted hover:text-foreground">
              {t('catalog')}
            </Link>
          </li>
          {product !== undefined ? (
            <>
              <li aria-hidden="true">
                <Icon icon={ChevronRight} size={12} />
              </li>
              <li aria-current="page" className="text-foreground">
                {product.name}
              </li>
            </>
          ) : null}
        </ol>
      </nav>
      {body}
    </main>
  );
}

function Purchase({
  variant,
  product,
  field,
}: {
  variant: 'tg' | 'web';
  product: CatalogProductDetail;
  field: NonNullable<CatalogProductDetail['inputSchema'][number]>;
}) {
  const web = variant === 'web';
  const header = <ProductHeader product={product} size={web ? 'roomy' : 'compact'} />;
  const form = <PurchaseView key={product.id} variant={variant} product={product} field={field} />;
  if (!web) {
    return (
      <>
        {header}
        {form}
      </>
    );
  }
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
      {header}
      <div className="flex flex-col gap-4 lg:sticky lg:top-24">{form}</div>
    </div>
  );
}
