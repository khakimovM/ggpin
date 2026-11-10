'use client';

import type { CatalogProductDetail } from '@repo/shared';
import { ErrorState, HIT_AREA_LINK, Icon } from '@repo/ui';
import { ChevronRight } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { localizedPath } from '../../i18n/paths';
import { isApiError } from '../../lib/api/errors';
import { useProduct } from '../catalog/use-product';
import { HelpSteps } from './HelpSteps';
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
    <main className="mx-auto flex w-full max-w-[1264px] flex-1 flex-col gap-4 px-4 pt-6 pb-40 md:px-6 md:pt-8 md:pb-8 lg:px-8">
      <nav aria-label={t('breadcrumb')}>
        <ol className="m-0 flex list-none items-center gap-1.5 p-0 text-[13px] leading-5 font-semibold text-foreground-muted">
          <li>
            <Link
              href={catalogHref}
              className={`relative inline-block text-foreground-muted hover:text-foreground ${HIT_AREA_LINK}`}
            >
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

function HowToSection({ help }: { help: string }) {
  const t = useTranslations('store.product.help');
  return (
    <section
      aria-labelledby="howto-title"
      className="hidden flex-col gap-3.5 rounded-[24px] border border-border bg-card p-5 [grid-area:howto] md:flex"
    >
      <h2 id="howto-title" className="m-0 text-xl leading-[26px] font-extrabold">
        {t('title')}
      </h2>
      <HelpSteps help={help} />
    </section>
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
  const help = product.help !== null && product.help.trim() !== '' ? product.help : null;
  // Store.dc.html areas: the header, the purchase panel (beside it from 1024 px, under it below)
  // and the "where do I find it" steps. The sheet behind the panel's help button stays for phones.
  const areas =
    help === null
      ? "[grid-template-areas:'head'_'panel'] lg:[grid-template-areas:'head_panel']"
      : "[grid-template-areas:'head'_'panel'_'howto'] lg:[grid-template-areas:'head_panel'_'howto_panel']";
  return (
    <div
      className={`grid grid-cols-[minmax(0,1fr)] items-start gap-x-8 gap-y-6 lg:grid-cols-[minmax(0,1fr)_420px] ${areas}`}
    >
      <div className="[grid-area:head]">{header}</div>
      <div className="[grid-area:panel] lg:sticky lg:top-24">{form}</div>
      {help === null ? null : <HowToSection help={help} />}
    </div>
  );
}
