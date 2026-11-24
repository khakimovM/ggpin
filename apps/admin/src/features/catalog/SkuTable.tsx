import type { AdminProductDetailResponse } from '@repo/shared';
import { Button, DataTable, FOCUS_RING, Icon, cn, type DataTableColumn } from '@repo/ui';
import { PackageX, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { formatBps, formatCount } from '../../lib/format';
import { ListEmpty } from '../common/ListStates';
import { MoneyCell } from '../common/MoneyCell';
import { Panel } from '../common/Panel';
import { Tag } from '../common/Tag';
import { SkuEditDialog } from './SkuEditDialog';

type Sku = AdminProductDetailResponse['skus'][number];

interface Props {
  product: AdminProductDetailResponse;
  /** The package whose price the side panel shows. */
  selectedId: string | null;
  onSelect: (skuId: string) => void;
  /** Add a package: `catalog.skuCreate` (UX only; the API decides). */
  canCreate: boolean;
  /** Edit a package: `catalog.skuUpdate`. */
  canEdit: boolean;
}

/** The packages of a product (AdminOps.dc.html «SKU jadvali»): pick one, edit, add. */
export function SkuTable({ product, selectedId, onSelect, canCreate, canEdit }: Props) {
  const t = useTranslations();
  // undefined: no dialog; null: a new package; a SKU: its edit.
  const [editing, setEditing] = useState<Sku | null | undefined>(undefined);
  const columns: DataTableColumn<Sku>[] = [
    {
      id: 'label',
      header: t('admin.catalog.sku.labelUz'),
      cell: (sku) => (
        <button
          type="button"
          aria-pressed={sku.id === selectedId}
          aria-label={t('admin.catalog.sku.pick', { label: sku.labelUz })}
          onClick={() => onSelect(sku.id)}
          className={cn('rounded-xs font-extrabold hover:underline', FOCUS_RING)}
        >
          {sku.labelUz}
        </button>
      ),
    },
    { id: 'labelRu', header: t('admin.catalog.sku.labelRu'), cell: (sku) => sku.labelRu },
    {
      id: 'quantity',
      header: t('admin.catalog.sku.quantity'),
      align: 'end',
      cell: (sku) => formatCount(sku.quantity),
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
    ...(canEdit
      ? [
          {
            id: 'edit',
            // The sr-only text is absolute: a relative wrapper keeps it inside the table's scroll box.
            header: (
              <span className="relative">
                <span className="sr-only">{t('admin.list.actions')}</span>
              </span>
            ),
            align: 'end' as const,
            cell: (sku: Sku) => (
              <button
                type="button"
                aria-label={t('admin.catalog.sku.edit', { label: sku.labelUz })}
                onClick={(event) => {
                  event.stopPropagation();
                  setEditing(sku);
                }}
                className={cn(
                  'grid size-7 place-items-center rounded-[8px] text-foreground-muted hover:bg-muted hover:text-foreground',
                  FOCUS_RING,
                )}
              >
                <Icon icon={Pencil} size={14} />
              </button>
            ),
          },
        ]
      : []),
  ];
  return (
    <Panel
      title={t('admin.catalog.sku.title')}
      aside={
        canCreate ? (
          <Button type="button" variant="outline" size="sm" onClick={() => setEditing(null)}>
            <Icon icon={Plus} size={14} />
            {t('admin.catalog.sku.add')}
          </Button>
        ) : (
          <span className="text-[11px] leading-[14px] font-semibold text-foreground-muted">
            {t('admin.catalog.preview.pick')}
          </span>
        )
      }
    >
      <DataTable
        label={t('admin.catalog.sku.title')}
        columns={columns}
        rows={product.skus}
        rowKey={(sku) => sku.id}
        state={product.skus.length === 0 ? 'empty' : 'data'}
        framed={false}
        minWidth={760}
        onRowClick={(sku) => onSelect(sku.id)}
        rowClassName={(sku) => (sku.id === selectedId ? 'bg-primary-soft' : undefined)}
        loadingLabel={t('admin.states.loading')}
        empty={<ListEmpty icon={PackageX} title={t('admin.catalog.sku.empty')} />}
      />
      {editing === undefined ? null : (
        <SkuEditDialog
          key={editing?.id ?? 'new'}
          product={product}
          sku={editing}
          open
          onOpenChange={(open) => {
            if (!open) setEditing(undefined);
          }}
        />
      )}
    </Panel>
  );
}
