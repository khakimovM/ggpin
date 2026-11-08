'use client';

import type { OrderDetail } from '@repo/shared';
import { Icon, StatusChip } from '@repo/ui';
import { Package } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useFormatMoney } from '../../lib/format/money';
import { useDateFormat } from '../../lib/format/use-date-format';
import { OrderActions } from './OrderActions';
import { OrderDetailsCard } from './OrderDetailsCard';
import { OrderHero } from './OrderHero';
import { OrderTimeline } from './OrderTimeline';
import { SuccessBurst } from './SuccessBurst';
import { VoucherBlock } from './VoucherBlock';
import { chipKeyOf, heroKindOf } from './order-status';
import { useItemLabel } from './use-item-label';

export interface OrderStatusViewProps {
  order: OrderDetail;
  homeHref: string;
  productHref: string;
}

/**
 * One order, as the owner sees it (Checkout.dc.html `screen: order`): what was bought, the status
 * card, the code of a delivered voucher, the steps, the amount and what to do next. The server's
 * strings are shown as they come: amounts through `formatMoney`, the code as text.
 */
export function OrderStatusView({ order, homeHref, productHref }: OrderStatusViewProps) {
  const t = useTranslations('store.order');
  const formatMoney = useFormatMoney();
  const { userDateTime } = useDateFormat();
  const itemLabel = useItemLabel();

  const kind = heroKindOf(order.status, order.voucher !== null);
  const item = itemLabel(order);
  const username = order.recipient.fields['username'] ?? order.recipient.displayName;
  const total = formatMoney(order.totalTiyin);
  const chipKey = chipKeyOf(order.status);

  return (
    <div className="flex flex-col gap-4">
      <section className="flex items-center gap-3.5 rounded-[24px] border border-border bg-card p-3">
        <span
          aria-hidden="true"
          className="grid size-[72px] shrink-0 place-items-center rounded-[18px] bg-muted text-foreground-muted"
        >
          <Icon icon={Package} size={28} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-[17px] leading-[22px] font-extrabold break-words">
            {order.productName}
          </span>
          <span className="text-[13px] leading-[18px] font-bold text-foreground-muted tabular-nums">
            {t('number', { number: order.number })} · {userDateTime(new Date(order.createdAt))}
          </span>
          <span className="truncate text-[13px] leading-[18px] font-semibold text-foreground-secondary">
            @{username} · {order.recipient.displayName}
          </span>
          <StatusChip
            status={order.status}
            label={t(`status.${chipKey}`)}
            size="md"
            className="mt-0.5 self-start"
          />
        </span>
      </section>

      <OrderHero
        kind={kind}
        title={t(`hero.${kind}.title`)}
        body={
          kind === 'failed' || kind === 'cancelled'
            ? t(`hero.${kind}.body`, { total })
            : t(`hero.${kind}.body`, { username, item })
        }
        decoration={kind === 'delivered' ? <SuccessBurst orderId={order.id} /> : undefined}
      />

      {order.voucher ? <VoucherBlock code={order.voucher.code} /> : null}
      <OrderTimeline order={order} />
      <OrderDetailsCard order={order} />
      <OrderActions kind={kind} homeHref={homeHref} productHref={productHref} />
    </div>
  );
}
