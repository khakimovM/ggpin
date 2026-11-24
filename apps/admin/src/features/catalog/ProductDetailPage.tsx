import type { AdminProductDetailResponse } from '@repo/shared';
import { Skeleton } from '@repo/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, PackageX } from 'lucide-react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useTranslations } from 'use-intl';
import { isApiError } from '../../lib/api/errors';
import { getProduct } from '../../lib/api/reads';
import { enumKey } from '../../lib/enum-text';
import { formatCount, formatDateTime } from '../../lib/format';
import { qk } from '../../lib/query-keys';
import { KeyValues } from '../common/KeyValues';
import { ListEmpty, LoadError } from '../common/ListStates';
import { PageHeader } from '../common/PageHeader';
import { Panel } from '../common/Panel';
import { SectionGate } from '../common/SectionGate';
import { Tag } from '../common/Tag';
import { TEXT_LINK } from '../common/link-style';
import { useAdminAction } from '../common/use-admin-action';
import { PricePreview } from './PricePreview';
import { ProductEditForm } from './ProductEditForm';
import { RouteTable } from './RouteTable';
import { SkuTable } from './SkuTable';

/** What the panel shows but never edits; the texts too when the admin may not edit them. */
function Facts({
  product,
  withTexts,
}: {
  product: AdminProductDetailResponse;
  withTexts: boolean;
}) {
  const t = useTranslations();
  const yesNo = (value: boolean) => t(value ? 'admin.catalog.yes' : 'admin.catalog.no');
  const range =
    product.allowCustomQty && product.minQty !== null && product.maxQty !== null
      ? `${formatCount(product.minQty)}–${formatCount(product.maxQty)}`
      : '—';
  const texts = withTexts
    ? [
        { key: 'region', label: t('admin.catalog.region'), value: product.regionBadge ?? '—' },
        { key: 'descUz', label: t('admin.catalog.descUz'), value: product.descriptionUz ?? '—' },
        { key: 'descRu', label: t('admin.catalog.descRu'), value: product.descriptionRu ?? '—' },
      ]
    : [];
  return (
    <Panel title={t('admin.catalog.facts')}>
      <KeyValues
        rows={[
          { key: 'slug', label: t('admin.list.col.slug'), value: product.slug },
          {
            key: 'delivery',
            label: t('admin.catalog.col.delivery'),
            value: t(enumKey('deliveryType', product.deliveryType)),
          },
          { key: 'auto', label: t('admin.catalog.auto'), value: yesNo(product.isAuto) },
          { key: 'range', label: t('admin.catalog.sku.quantity'), value: range },
          ...texts,
        ]}
      />
    </Panel>
  );
}

function Detail({ product }: { product: AdminProductDetailResponse }) {
  const t = useTranslations();
  const act = useAdminAction();
  const [search, setSearch] = useSearchParams();
  const skuId = product.skus.find((sku) => sku.id === search.get('sku'))?.id ?? null;
  const editable = act.can('catalog.productUpdate');
  return (
    <>
      <PageHeader
        title={product.nameUz}
        sub={t('admin.catalog.updated', { time: formatDateTime(product.updatedAt) })}
        badges={
          <Tag tone={product.isActive ? 'ok' : 'mute'}>
            {t(product.isActive ? 'admin.catalog.active' : 'admin.catalog.inactive')}
          </Tag>
        }
      />
      {editable ? null : (
        <p className="m-0 -mt-1 text-xs leading-4 font-semibold text-foreground-muted">
          {t('admin.catalog.readOnly')}
        </p>
      )}
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          {editable ? <ProductEditForm key={product.updatedAt} product={product} /> : null}
          <SkuTable
            product={product}
            selectedId={skuId}
            onSelect={(id) => setSearch({ sku: id }, { replace: true })}
            canCreate={act.can('catalog.skuCreate')}
            canEdit={act.can('catalog.skuUpdate')}
          />
          <RouteTable product={product} editable={act.can('catalog.routeUpdate')} />
        </div>
        <div className="flex min-w-0 flex-col gap-3 xl:sticky xl:top-5 xl:self-start">
          <PricePreview productId={product.id} skuId={skuId} />
          <Facts product={product} withTexts={!editable} />
        </div>
      </div>
    </>
  );
}

function ProductDetail({ productId }: { productId: string }) {
  const t = useTranslations();
  const query = useQuery({
    queryKey: qk.catalog.product(productId),
    queryFn: ({ signal }) => getProduct(productId, signal),
  });
  let body;
  if (query.data) body = <Detail product={query.data} />;
  else if (query.isError) {
    body = (
      <div className="rounded-md border border-border bg-card py-6">
        {isApiError(query.error) && query.error.code === 'NOT_FOUND' ? (
          <ListEmpty icon={PackageX} title={t('admin.catalog.notFound')} />
        ) : (
          <LoadError
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        )}
      </div>
    );
  } else {
    body = (
      <div role="status" aria-label={t('admin.states.loading')} className="flex flex-col gap-3">
        <Skeleton className="h-10 w-64 rounded-[10px]" />
        <Skeleton className="h-[320px] rounded-md" />
      </div>
    );
  }
  return (
    <>
      <Link
        to="/products"
        className={`inline-flex items-center gap-1 self-start text-xs ${TEXT_LINK}`}
      >
        <ArrowLeft size={14} aria-hidden="true" />
        {t('admin.nav.products')}
      </Link>
      {body}
    </>
  );
}

export function ProductDetailPage() {
  const t = useTranslations();
  const { id = '' } = useParams();
  return (
    <SectionGate permission="catalog.read" title={t('admin.nav.products')}>
      <ProductDetail key={id} productId={id} />
    </SectionGate>
  );
}
