'use client';

import type { OrderDto } from '@repo/shared';
import { Icon, StatusChip } from '@repo/ui';
import { ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Money } from '../../lib/format/money';
import { useDateFormat } from '../../lib/format/use-date-format';
import { chipKeyOf } from '../order/order-status';
import { useItemLabel } from '../order/use-item-label';
import { HistoryTable, LINK_CLASS, ROW_CLASS, type HistoryColumn } from './HistoryTable';
import { recipientLabel } from './order-labels';
import { ProductThumb } from './ProductThumb';

export function OrderTable({
  orders,
  hrefOf,
}: {
  orders: readonly OrderDto[];
  hrefOf: (id: string) => string;
}) {
  const t = useTranslations('account.history');
  const status = useTranslations('store.order.status');
  const itemLabel = useItemLabel();
  const { userDateTime } = useDateFormat();
  const columns: HistoryColumn[] = [
    { key: 'date', label: t('columns.date') },
    { key: 'product', label: t('columns.product') },
    { key: 'recipient', label: t('columns.recipient') },
    { key: 'amount', label: t('columns.amount'), align: 'right' },
    { key: 'status', label: t('columns.status') },
    { key: 'action', label: t('columns.action'), hidden: true },
  ];
  return (
    <HistoryTable caption={t('tabs.orders')} columns={columns}>
      {orders.map((order) => (
        <tr key={order.id} className={ROW_CLASS}>
          <td className="px-5 whitespace-nowrap text-foreground-secondary">
            {userDateTime(new Date(order.createdAt))}
          </td>
          <td className="px-3">
            <span className="flex items-center gap-3">
              <ProductThumb slug={order.productSlug} className="size-9 rounded-[10px]" />
              <Link href={hrefOf(order.id)} className={`${LINK_CLASS} font-extrabold`}>
                {itemLabel(order)}
              </Link>
            </span>
          </td>
          <td className="px-3 text-foreground-secondary">
            {recipientLabel(order)} · #{order.number}
          </td>
          <td className="px-3 text-right">
            <Money tiyin={order.totalTiyin} size="md" />
          </td>
          <td className="px-3">
            <StatusChip status={order.status} label={status(chipKeyOf(order.status))} size="lg" />
          </td>
          <td className="pr-4 text-foreground-muted">
            <Icon icon={ChevronRight} size={17} />
          </td>
        </tr>
      ))}
    </HistoryTable>
  );
}
