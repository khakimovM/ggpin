'use client';

import type { OrderDto } from '@repo/shared';
import { StatusChip } from '@repo/ui';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { formatTime } from '../../lib/format/date';
import { Money } from '../../lib/format/money';
import { chipKeyOf } from '../order/order-status';
import { useItemLabel } from '../order/use-item-label';
import { recipientLabel } from './order-labels';
import { ProductThumb } from './ProductThumb';

export interface OrderRowProps {
  order: OrderDto;
  href: string;
  /** Show the date next to the recipient (the web list has no day headings). */
  withDate?: string;
}

/**
 * One order in the list (Account.dc.html `hList` row): picture, what and for whom, the status, the
 * amount and the time. The whole row is the link to the order page. The recipient name comes from
 * the user's own input and the product name from the catalog: both are plain text nodes.
 */
export function OrderRow({ order, href, withDate }: OrderRowProps) {
  const locale = useLocale();
  const itemLabel = useItemLabel();
  const status = useTranslations('store.order.status');
  const time = formatTime(new Date(order.createdAt), { locale: locale === 'ru' ? 'ru' : 'uz' });
  const chipKey = chipKeyOf(order.status);

  return (
    <Link
      href={href}
      className="grid grid-cols-[44px_minmax(0,1fr)_auto] items-start gap-3 border-t border-border px-4 py-3 text-foreground no-underline transition-colors duration-fast first:border-t-0 hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
    >
      <ProductThumb slug={order.productSlug} />
      <span className="flex min-w-0 flex-col gap-[3px]">
        <span className="truncate text-[15px] leading-5 font-extrabold">{itemLabel(order)}</span>
        <span className="truncate text-xs leading-4 font-semibold text-foreground-muted tabular-nums">
          {recipientLabel(order)} · #{order.number}
          {withDate === undefined ? '' : ` · ${withDate}`}
        </span>
        <StatusChip
          status={order.status}
          label={status(chipKey)}
          size="md"
          className="mt-[3px] self-start"
        />
      </span>
      <span className="flex flex-col items-end gap-[3px]">
        <Money tiyin={order.totalTiyin} size="md" />
        <span className="text-xs leading-4 font-semibold text-foreground-muted tabular-nums">
          {time}
        </span>
      </span>
    </Link>
  );
}
