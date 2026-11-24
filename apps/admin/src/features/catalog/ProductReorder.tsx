import type { AdminProductListResponse } from '@repo/shared';
import { Button, FOCUS_RING, Icon, Switch, cn } from '@repo/ui';
import { ArrowDown, ArrowUp, GripVertical, ListOrdered } from 'lucide-react';
import { useState, type DragEvent, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { useTranslations } from 'use-intl';
import { reorderProducts, REORDER_TARGET_ID } from '../../lib/api/writes-catalog';
import { enumKey } from '../../lib/enum-text';
import { formatCount } from '../../lib/format';
import { ReasonDialog } from '../common/ReasonDialog';
import { Tag } from '../common/Tag';
import { useAdminAction } from '../common/use-admin-action';
import { ROW_LINK } from '../common/link-style';
import { ProductActiveDialog } from './ProductActiveDialog';
import { moveBy, moveOnto, sameOrder, savedOrder } from './reorder-model';

type Product = AdminProductListResponse[number];

interface Props {
  /** Every product (a reorder always saves the full set, docs/04). */
  products: readonly Product[];
  /** The ids the category filter shows; null = all (reordering only works on the full list). */
  visible: ReadonlySet<string> | null;
  categoryName: (id: string) => string;
  /** Drag and arrows: `catalog.productReorder` (UX only; the API decides). */
  canReorder: boolean;
  /** The on/off switch: `catalog.productUpdate`. */
  canToggle: boolean;
}

const ARROW = cn(
  'grid size-7 place-items-center rounded-[8px] border-[1.5px] border-border text-foreground disabled:opacity-40',
  FOCUS_RING,
);

/**
 * The product list as the owner orders it (AdminOps.dc.html `products`): drag a row, or use the
 * arrow buttons or Alt+↑/↓ on a focused row; the new order is saved as one write. The switch
 * turns a product on or off after a reason.
 */
export function ProductReorder({ products, visible, categoryName, canReorder, canToggle }: Props) {
  const t = useTranslations();
  const act = useAdminAction();
  const saved = savedOrder(products);
  const [order, setOrder] = useState(saved);
  const [dragId, setDragId] = useState<string | null>(null);
  const [toggling, setToggling] = useState<Product | null>(null);
  const [saving, setSaving] = useState(false);
  const [announce, setAnnounce] = useState('');
  const byId = new Map(products.map((product) => [product.id, product]));
  const movable = canReorder && visible === null;
  const changed = !sameOrder(order, saved);
  const shown = order.filter((id) => visible === null || visible.has(id));

  const move = (id: string, delta: number) => {
    const next = moveBy(order, order.indexOf(id), delta);
    setOrder(next);
    const name = byId.get(id)?.nameUz ?? '';
    setAnnounce(t('admin.catalog.reorder.moved', { name, position: next.indexOf(id) + 1 }));
    // Keep the focus on the moved row (it re-renders at its new place).
    requestAnimationFrame(() => document.getElementById(`product-row-${id}`)?.focus());
  };
  const onKey = (id: string) => (event: KeyboardEvent<HTMLDivElement>) => {
    if (!movable || !event.altKey) return;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    move(id, event.key === 'ArrowUp' ? -1 : 1);
  };
  const dragProps = (id: string) =>
    movable
      ? {
          draggable: true,
          onDragStart: (event: DragEvent<HTMLDivElement>) => {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', id);
            setDragId(id);
          },
          onDragOver: (event: DragEvent<HTMLDivElement>) => {
            event.preventDefault();
            if (dragId !== null && dragId !== id) setOrder((now) => moveOnto(now, dragId, id));
          },
          onDrop: (event: DragEvent<HTMLDivElement>) => event.preventDefault(),
          onDragEnd: () => setDragId(null),
        }
      : {};

  return (
    <div className="flex flex-col gap-3">
      <p
        id="reorder-hint"
        className="m-0 -mt-1 text-xs leading-4 font-semibold text-foreground-muted"
      >
        {canReorder
          ? t(visible === null ? 'admin.catalog.reorder.hint' : 'admin.catalog.reorder.filtered')
          : t('admin.catalog.readOnly')}
      </p>
      <div className="overflow-x-auto rounded-md border border-border bg-card">
        <div role="list" aria-label={t('admin.nav.products')} className="min-w-[760px]">
          {shown.map((id) => {
            const product = byId.get(id);
            if (product === undefined) return null;
            const position = order.indexOf(id);
            return (
              <div
                key={id}
                id={`product-row-${id}`}
                role="listitem"
                tabIndex={movable ? 0 : -1}
                aria-describedby={movable ? 'reorder-hint' : undefined}
                onKeyDown={onKey(id)}
                {...dragProps(id)}
                className={cn(
                  'grid h-[52px] grid-cols-[24px_28px_minmax(0,1.4fr)_120px_140px_80px_44px_64px] items-center gap-2.5 border-t border-border px-3.5 first:border-t-0',
                  dragId === id ? 'bg-primary-soft' : 'hover:bg-muted',
                  FOCUS_RING,
                )}
              >
                {movable ? (
                  <span aria-hidden="true" className="cursor-grab text-foreground-muted">
                    <Icon icon={GripVertical} size={16} />
                  </span>
                ) : (
                  <span />
                )}
                <span className="text-[11px] leading-none font-extrabold text-foreground-muted tabular-nums">
                  {position + 1}
                </span>
                <Link to={`/products/${id}`} className={cn('truncate text-[13px]', ROW_LINK)}>
                  {product.nameUz}
                </Link>
                <span className="truncate text-xs font-semibold text-foreground-secondary">
                  {categoryName(product.categoryId)}
                </span>
                <span>
                  <Tag tone="ok">{t(enumKey('deliveryType', product.deliveryType))}</Tag>
                </span>
                <span className="text-xs font-bold text-foreground-secondary tabular-nums">
                  {formatCount(product.activeSkusCount)} {t('admin.catalog.col.skus')}
                </span>
                {canToggle ? (
                  <Switch
                    size="sm"
                    checked={product.isActive}
                    label={t('admin.catalog.toggle.label', { name: product.nameUz })}
                    onCheckedChange={() => setToggling(product)}
                  />
                ) : (
                  <Tag tone={product.isActive ? 'ok' : 'mute'}>
                    {t(product.isActive ? 'admin.catalog.active' : 'admin.catalog.inactive')}
                  </Tag>
                )}
                {movable ? (
                  <span className="flex gap-1">
                    <button
                      type="button"
                      className={ARROW}
                      disabled={position === 0}
                      aria-label={t('admin.catalog.reorder.up', { name: product.nameUz })}
                      onClick={() => move(id, -1)}
                    >
                      <Icon icon={ArrowUp} size={13} />
                    </button>
                    <button
                      type="button"
                      className={ARROW}
                      disabled={position === order.length - 1}
                      aria-label={t('admin.catalog.reorder.down', { name: product.nameUz })}
                      onClick={() => move(id, 1)}
                    >
                      <Icon icon={ArrowDown} size={13} />
                    </button>
                  </span>
                ) : (
                  <span />
                )}
              </div>
            );
          })}
        </div>
      </div>
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
      {changed && movable ? (
        <div className="sticky bottom-3 flex flex-wrap items-center gap-2 rounded-md border border-border bg-elevated px-3.5 py-2.5 shadow-md">
          <span className="mr-auto text-xs leading-4 font-extrabold">
            {t('admin.catalog.reorder.changed')}
          </span>
          <Button type="button" variant="outline" size="sm" onClick={() => setOrder(saved)}>
            {t('admin.catalog.reorder.reset')}
          </Button>
          <Button type="button" size="sm" onClick={() => setSaving(true)}>
            <Icon icon={ListOrdered} size={14} />
            {t('admin.catalog.reorder.save')}
          </Button>
        </div>
      ) : null}
      <ReasonDialog
        action={act.idOf('catalog.productReorder', REORDER_TARGET_ID)}
        open={saving}
        onOpenChange={setSaving}
        title={t('admin.catalog.reorder.dialog.title')}
        description={t('admin.catalog.reorder.dialog.body', { count: order.length })}
        icon={ListOrdered}
        submitLabel={t('admin.catalog.reorder.dialog.cta')}
        actor={act.actor}
        textField="none"
        onOutcomeFound={(applied) => act.found('catalog.productReorder', applied)}
        onSubmit={async ({ idempotencyKey }) => {
          const result = await reorderProducts({ productIds: [...order] }, idempotencyKey);
          act.finished('catalog.productReorder', result);
        }}
      />
      {toggling === null ? null : (
        <ProductActiveDialog
          key={toggling.id}
          product={toggling}
          open
          onOpenChange={(open) => {
            if (!open) setToggling(null);
          }}
        />
      )}
    </div>
  );
}
