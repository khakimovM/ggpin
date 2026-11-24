import type { AdminProductDetailResponse } from '@repo/shared';
import { DataTable, FOCUS_RING, Icon, cn, type DataTableColumn } from '@repo/ui';
import { PackageX, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { enumKey } from '../../lib/enum-text';
import { formatCount } from '../../lib/format';
import { ListEmpty } from '../common/ListStates';
import { Panel } from '../common/Panel';
import { Tag, type TagTone } from '../common/Tag';
import { RouteEditDialog } from './RouteEditDialog';

type Route = AdminProductDetailResponse['routes'][number];

const HEALTH: Record<Route['health'], TagTone> = {
  OK: 'ok',
  DEGRADED: 'warn',
  DOWN: 'bad',
  UNKNOWN: 'mute',
};

interface Props {
  product: AdminProductDetailResponse;
  /** OWNER: change a route's priority or switch it (UX only; the API decides). */
  editable: boolean;
}

/** Delivery routes in the order they are tried (AdminOps.dc.html «Routing · adapter ustuvorligi»). */
export function RouteTable({ product, editable }: Props) {
  const t = useTranslations();
  const [editing, setEditing] = useState<Route | null>(null);
  const columns: DataTableColumn<Route>[] = [
    {
      id: 'priority',
      header: t('admin.catalog.route.priority'),
      align: 'end',
      cell: (route) => formatCount(route.priority),
    },
    {
      id: 'adapter',
      header: t('admin.catalog.route.adapter'),
      cell: (route) => route.adapter,
      className: 'font-mono text-[11px] font-bold',
    },
    {
      id: 'health',
      header: t('admin.catalog.route.health'),
      cell: (route) => (
        <Tag tone={HEALTH[route.health]}>{t(enumKey('routeHealth', route.health))}</Tag>
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
    ...(editable
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
            cell: (route: Route) => (
              <button
                type="button"
                aria-label={t('admin.catalog.route.edit', { adapter: route.adapter })}
                onClick={() => setEditing(route)}
                className={cn(
                  'grid size-7 place-items-center rounded-[8px] text-foreground-muted hover:bg-muted hover:text-foreground',
                  FOCUS_RING,
                )}
              >
                <Icon icon={SlidersHorizontal} size={14} />
              </button>
            ),
          },
        ]
      : []),
  ];
  return (
    <Panel title={t('admin.catalog.route.title')}>
      <DataTable
        label={t('admin.catalog.route.title')}
        columns={columns}
        rows={product.routes}
        rowKey={(route) => route.id}
        state={product.routes.length === 0 ? 'empty' : 'data'}
        framed={false}
        loadingLabel={t('admin.states.loading')}
        empty={<ListEmpty icon={PackageX} title={t('admin.catalog.route.empty')} />}
      />
      {editing === null ? null : (
        <RouteEditDialog
          key={editing.id}
          product={product}
          route={editing}
          open
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
        />
      )}
    </Panel>
  );
}
