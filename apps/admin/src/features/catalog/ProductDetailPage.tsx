import type { AdminProductDetailResponse } from '@repo/shared';
import { DataTable, FOCUS_RING, Skeleton, cn, type DataTableColumn } from '@repo/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, PackageX } from 'lucide-react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useTranslations } from 'use-intl';
import { isApiError } from '../../lib/api/errors';
import { getProduct } from '../../lib/api/reads';
import { formatBps, formatDateTime } from '../../lib/format';
import { qk } from '../../lib/query-keys';
import { KeyValues } from '../common/KeyValues';
import { ListEmpty, LoadError } from '../common/ListStates';
import { MoneyCell } from '../common/MoneyCell';
import { PageHeader } from '../common/PageHeader';
import { Panel } from '../common/Panel';
import { SectionGate } from '../common/SectionGate';
import { Tag } from '../common/Tag';
import { TEXT_LINK } from '../common/link-style';
import { PricePreview } from './PricePreview';

type Sku = AdminProductDetailResponse['skus'][number];
type Route = AdminProductDetailResponse['routes'][number];

function Detail({ product }: { product: AdminProductDetailResponse }) {
  const t = useTranslations();
  const [search, setSearch] = useSearchParams();
  const skuId = product.skus.find((sku) => sku.id === search.get('sku'))?.id ?? null;
  const pick = (id: string) => setSearch({ sku: id }, { replace: true });
  const skuColumns: DataTableColumn<Sku>[] = [
    {
      id: 'label',
      header: t('admin.catalog.sku.label'),
      cell: (sku) => (
        <button
          type="button"
          aria-pressed={sku.id === skuId}
          onClick={() => pick(sku.id)}
          className={cn('rounded-xs font-extrabold hover:underline', FOCUS_RING)}
        >
          {sku.labelUz}
        </button>
      ),
    },
    {
      id: 'supplier',
      header: t('admin.catalog.sku.supplier'),
      cell: (sku) => sku.supplierSku ?? '—',
      className: 'font-mono text-[11px]',
    },
    {
      id: 'markup',
      header: t('admin.catalog.sku.markup'),
      align: 'end',
      cell: (sku) => `${formatBps(sku.markupBps)}%`,
    },
    {
      id: 'margin',
      header: t('admin.catalog.sku.minMargin'),
      align: 'end',
      cell: (sku) => <MoneyCell tiyin={sku.minMarginTiyin} />,
    },
    {
      id: 'state',
      header: t('admin.catalog.col.state'),
      cell: (sku) => (
        <Tag tone={sku.isActive ? 'ok' : 'mute'}>
          {t(sku.isActive ? 'admin.catalog.active' : 'admin.catalog.inactive')}
        </Tag>
      ),
    },
  ];
  const routeColumns: DataTableColumn<Route>[] = [
    {
      id: 'adapter',
      header: t('admin.catalog.route.adapter'),
      cell: (route) => <span className="font-extrabold">{route.adapter}</span>,
    },
    {
      id: 'priority',
      header: t('admin.catalog.route.priority'),
      align: 'end',
      cell: (route) => route.priority,
    },
    {
      id: 'health',
      header: t('admin.catalog.route.health'),
      cell: (route) => (
        <Tag tone={route.health === 'OK' ? 'ok' : route.health === 'UNKNOWN' ? 'mute' : 'bad'}>
          {route.health}
        </Tag>
      ),
    },
    {
      id: 'enabled',
      header: t('admin.catalog.col.state'),
      cell: (route) => (
        <Tag tone={route.isEnabled ? 'ok' : 'mute'}>
          {t(route.isEnabled ? 'admin.catalog.active' : 'admin.catalog.inactive')}
        </Tag>
      ),
    },
  ];
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
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          <Panel title={t('admin.catalog.sku.title')}>
            <DataTable
              label={t('admin.catalog.sku.title')}
              columns={skuColumns}
              rows={product.skus}
              rowKey={(sku) => sku.id}
              state={product.skus.length === 0 ? 'empty' : 'data'}
              framed={false}
              minWidth={560}
              onRowClick={(sku) => pick(sku.id)}
              rowClassName={(sku) => (sku.id === skuId ? 'bg-primary-soft' : undefined)}
              loadingLabel={t('admin.states.loading')}
              empty={<ListEmpty icon={PackageX} title={t('admin.catalog.sku.empty')} />}
            />
          </Panel>
          <Panel title={t('admin.catalog.route.title')}>
            <DataTable
              label={t('admin.catalog.route.title')}
              columns={routeColumns}
              rows={product.routes}
              rowKey={(route) => route.id}
              state={product.routes.length === 0 ? 'empty' : 'data'}
              framed={false}
              loadingLabel={t('admin.states.loading')}
              empty={<ListEmpty icon={PackageX} title={t('admin.catalog.route.empty')} />}
            />
          </Panel>
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <PricePreview productId={product.id} skuId={skuId} />
          <Panel title={t('admin.catalog.facts')}>
            <KeyValues
              rows={[
                { key: 'slug', label: t('admin.list.col.slug'), value: product.slug },
                {
                  key: 'delivery',
                  label: t('admin.catalog.col.delivery'),
                  value: product.deliveryType,
                },
                {
                  key: 'auto',
                  label: t('admin.catalog.auto'),
                  value: t(product.isAuto ? 'admin.catalog.yes' : 'admin.catalog.no'),
                },
                {
                  key: 'region',
                  label: t('admin.catalog.region'),
                  value: product.regionBadge ?? '—',
                },
                {
                  key: 'descUz',
                  label: t('admin.catalog.descUz'),
                  value: product.descriptionUz ?? '—',
                },
                {
                  key: 'descRu',
                  label: t('admin.catalog.descRu'),
                  value: product.descriptionRu ?? '—',
                },
              ]}
            />
          </Panel>
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
  const back = (
    <Link
      to="/products"
      className={`inline-flex items-center gap-1 self-start text-xs ${TEXT_LINK}`}
    >
      <ArrowLeft size={14} aria-hidden="true" />
      {t('admin.nav.products')}
    </Link>
  );
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
      {back}
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
