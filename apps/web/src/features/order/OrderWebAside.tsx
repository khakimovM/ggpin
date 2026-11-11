'use client';

import type { OrderDetail } from '@repo/shared';
import { Icon } from '@repo/ui';
import { Package } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { OrderActions } from './OrderActions';
import { OrderDetailsCard } from './OrderDetailsCard';
import type { HeroKind } from './order-status';
import { useItemLabel } from './use-item-label';

export interface OrderWebAsideProps {
  order: OrderDetail;
  kind: HeroKind;
  homeHref: string;
  productHref: string;
}

/**
 * "Buyurtma tafsilotlari", the side panel of the web order page (Store.dc.html `order`, from
 * 768 px; sticky beside the steps from 1024 px): what was bought and for whom, the rows, and what
 * to do next. The design draws the product's picture; the order carries none, so a package icon
 * stands in (as on the Mini App's order page). Its "Region" row is left out: the order has no
 * region field.
 */
export function OrderWebAside({ order, kind, homeHref, productHref }: OrderWebAsideProps) {
  const t = useTranslations('store.order');
  const itemLabel = useItemLabel();
  const label = itemLabel(order);
  const title = label === order.productName ? label : `${order.productName} · ${label}`;
  const username = order.recipient.fields['username'] ?? order.recipient.displayName;
  return (
    <aside
      aria-labelledby="order-details-title"
      className="flex flex-col gap-4 rounded-[24px] border border-border bg-card p-5 lg:sticky lg:top-24"
    >
      <h2 id="order-details-title" className="m-0 text-lg leading-6 font-extrabold">
        {t('details.title')}
      </h2>
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="grid size-14 shrink-0 place-items-center rounded-2xl bg-muted text-foreground-muted"
        >
          <Icon icon={Package} size={22} />
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-base leading-[21px] font-extrabold break-words">{title}</span>
          <span className="truncate text-[13px] leading-[18px] font-semibold text-foreground-muted">
            @{username} · {order.recipient.displayName}
          </span>
        </span>
      </div>
      <OrderDetailsCard order={order} bare />
      <OrderActions kind={kind} homeHref={homeHref} productHref={productHref} />
    </aside>
  );
}
