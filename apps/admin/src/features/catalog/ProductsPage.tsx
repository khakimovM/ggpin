import { Button, Icon, Skeleton } from '@repo/ui';
import { useQuery } from '@tanstack/react-query';
import { FolderPen, Package } from 'lucide-react';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { listCategories, listProducts } from '../../lib/api/reads';
import { formatCount } from '../../lib/format';
import { useListParams } from '../../lib/list-params';
import { qk } from '../../lib/query-keys';
import { FilterPills } from '../common/FilterPills';
import { ListEmpty, LoadError } from '../common/ListStates';
import { PageHeader } from '../common/PageHeader';
import { SectionGate } from '../common/SectionGate';
import { Toolbar } from '../common/Toolbar';
import { useAdminAction } from '../common/use-admin-action';
import { CategoryEditDialog } from './CategoryEditDialog';
import { ProductReorder } from './ProductReorder';
import { savedOrder } from './reorder-model';

const SPEC = { category: { default: 'all', maxLength: 64 } } as const;

function Products() {
  const t = useTranslations();
  const act = useAdminAction();
  const { values, set } = useListParams(SPEC);
  const [editingCategory, setEditingCategory] = useState(false);
  const products = useQuery({
    queryKey: qk.catalog.products(),
    queryFn: ({ signal }) => listProducts(signal),
  });
  const categories = useQuery({
    queryKey: qk.catalog.categories(),
    queryFn: ({ signal }) => listCategories(signal),
  });
  const category = categories.data?.find((one) => one.id === values.category);
  const categoryName = (id: string) => categories.data?.find((one) => one.id === id)?.nameUz ?? '—';
  const rows = products.data;
  const visible =
    rows === undefined || values.category === 'all'
      ? null
      : new Set(rows.filter((row) => row.categoryId === values.category).map((row) => row.id));
  let body;
  if (rows !== undefined && (visible === null ? rows.length : visible.size) > 0) {
    body = (
      <ProductReorder
        // A new saved order (after a reorder or a refresh) starts the editing over.
        key={savedOrder(rows).join(',')}
        products={rows}
        visible={visible}
        categoryName={categoryName}
        canReorder={act.can('catalog.productReorder')}
        canToggle={act.can('catalog.productUpdate')}
      />
    );
  } else {
    body = (
      <div className="rounded-md border border-border bg-card py-6">
        {rows !== undefined ? (
          <ListEmpty icon={Package} title={t('admin.catalog.empty')} />
        ) : products.isError ? (
          <LoadError
            error={products.error}
            onRetry={() => void products.refetch()}
            retrying={products.isFetching}
          />
        ) : (
          <div
            role="status"
            aria-label={t('admin.states.loading')}
            className="flex flex-col gap-2 px-3.5"
          >
            {[0, 1, 2, 3, 4].map((n) => (
              <Skeleton key={n} className="h-10 rounded-[10px]" />
            ))}
          </div>
        )}
      </div>
    );
  }
  return (
    <>
      <PageHeader title={t('admin.nav.products')} />
      {categories.data && categories.data.length > 0 ? (
        <Toolbar>
          <FilterPills
            label={t('admin.catalog.col.category')}
            value={values.category}
            onChange={(next) => set({ category: next })}
            options={[
              { value: 'all', label: t('admin.list.all') },
              ...categories.data.map((one) => ({
                value: one.id,
                label: one.nameUz,
                count: formatCount(one.productsCount),
              })),
            ]}
          />
          {category !== undefined && act.can('catalog.categoryUpdate') ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setEditingCategory(true)}
            >
              <Icon icon={FolderPen} size={14} />
              {t('admin.catalog.category.edit')}
            </Button>
          ) : null}
        </Toolbar>
      ) : null}
      {body}
      {category === undefined ? null : (
        <CategoryEditDialog
          key={category.id}
          category={category}
          open={editingCategory}
          onOpenChange={setEditingCategory}
        />
      )}
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
