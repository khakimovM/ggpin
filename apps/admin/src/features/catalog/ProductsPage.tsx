import type { AdminProductListResponse } from '@repo/shared';
import { DataTable, type DataTableColumn } from '@repo/ui';
import { useQuery } from '@tanstack/react-query';
import { Package } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { useTranslations } from 'use-intl';
import { listCategories, listProducts } from '../../lib/api/reads';
import { formatCount } from '../../lib/format';
import { useListParams } from '../../lib/list-params';
import { qk } from '../../lib/query-keys';
import { FilterPills } from '../common/FilterPills';
import { ListEmpty, LoadError } from '../common/ListStates';
import { PageHeader } from '../common/PageHeader';
import { PendingActions } from '../common/PendingActions';
import { SectionGate } from '../common/SectionGate';
import { tableState } from '../common/table-state';
import { Tag } from '../common/Tag';
import { Toolbar } from '../common/Toolbar';
import { ROW_LINK } from '../common/link-style';

type Product = AdminProductListResponse[number];

const SPEC = { category: { default: 'all', maxLength: 64 } } as const;

function Products() {
  const t = useTranslations();
  const navigate = useNavigate();
  const { values, set } = useListParams(SPEC);
  const products = useQuery({
    queryKey: qk.catalog.products(),
    queryFn: ({ signal }) => listProducts(signal),
  });
  const categories = useQuery({
    queryKey: qk.catalog.categories(),
    queryFn: ({ signal }) => listCategories(signal),
  });
  const categoryName = (id: string) => categories.data?.find((one) => one.id === id)?.nameUz ?? '—';
  const rows = products.data?.filter(
    (row) => values.category === 'all' || row.categoryId === values.category,
  );
  const columns: DataTableColumn<Product>[] = [
    {
      id: 'name',
      header: t('admin.catalog.col.product'),
      cell: (row) => (
        <span className="flex flex-col">
          <Link to={`/products/${row.id}`} className={ROW_LINK}>
            {row.nameUz}
          </Link>
          <span className="font-mono text-[11px] text-foreground-muted">{row.slug}</span>
        </span>
      ),
    },
    {
      id: 'category',
      header: t('admin.catalog.col.category'),
      cell: (row) => categoryName(row.categoryId),
    },
    {
      id: 'delivery',
      header: t('admin.catalog.col.delivery'),
      cell: (row) => <Tag tone="mute">{row.deliveryType}</Tag>,
    },
    {
      id: 'skus',
      header: t('admin.catalog.col.skus'),
      align: 'end',
      cell: (row) => formatCount(row.activeSkusCount),
    },
    {
      id: 'routes',
      header: t('admin.catalog.col.routes'),
      align: 'end',
      cell: (row) => formatCount(row.routesEnabledCount),
    },
    {
      id: 'state',
      header: t('admin.catalog.col.state'),
      cell: (row) => (
        <span className="flex gap-1">
          <Tag tone={row.isActive ? 'ok' : 'mute'}>
            {t(row.isActive ? 'admin.catalog.active' : 'admin.catalog.inactive')}
          </Tag>
          {row.isFeatured ? <Tag tone="prem">{t('admin.catalog.featured')}</Tag> : null}
        </span>
      ),
    },
  ];
  return (
    <>
      <PageHeader
        title={t('admin.nav.products')}
        sub={t('admin.catalog.readOnly')}
        actions={<PendingActions labels={[t('admin.catalog.add')]} />}
      />
      {categories.data && categories.data.length > 0 ? (
        <Toolbar>
          <FilterPills
            label={t('admin.catalog.col.category')}
            value={values.category}
            onChange={(category) => set({ category })}
            options={[
              { value: 'all', label: t('admin.list.all') },
              ...categories.data.map((one) => ({
                value: one.id,
                label: one.nameUz,
                count: formatCount(one.productsCount),
              })),
            ]}
          />
        </Toolbar>
      ) : null}
      <DataTable
        label={t('admin.nav.products')}
        columns={columns}
        rows={rows ?? []}
        rowKey={(row) => row.id}
        state={tableState(products, rows?.length)}
        minWidth={820}
        onRowClick={(row) => void navigate(`/products/${row.id}`)}
        loadingLabel={t('admin.states.loading')}
        empty={<ListEmpty icon={Package} title={t('admin.catalog.empty')} />}
        error={
          <LoadError
            error={products.error}
            onRetry={() => void products.refetch()}
            retrying={products.isFetching}
          />
        }
      />
    </>
  );
}

export function ProductsPage() {
  const t = useTranslations();
  return (
    <SectionGate permission="catalog.read" title={t('admin.nav.products')}>
      <Products />
    </SectionGate>
  );
}
