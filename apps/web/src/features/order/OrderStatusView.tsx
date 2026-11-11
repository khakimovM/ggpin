'use client';

import type { OrderDetail } from '@repo/shared';
import { HIT_AREA_LINK, Icon, StatusChip, useMediaQuery } from '@repo/ui';
import { ChevronRight, Package } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useFormatMoney } from '../../lib/format/money';
import { useDateFormat } from '../../lib/format/use-date-format';
import { OrderActions } from './OrderActions';
import { OrderDetailsCard } from './OrderDetailsCard';
import { OrderHero } from './OrderHero';
import { OrderTimeline } from './OrderTimeline';
import { OrderWebAside } from './OrderWebAside';
import { SuccessBurst } from './SuccessBurst';
import { VoucherBlock } from './VoucherBlock';
import { chipKeyOf, heroKindOf } from './order-status';
import { useItemLabel } from './use-item-label';

export interface OrderStatusViewProps {
  order: OrderDetail;
  homeHref: string;
  productHref: string;
  /**
   * The web store's order page (Store.dc.html `order`): a breadcrumb back to the history and, from
   * 768 px, the status beside a "Buyurtma tafsilotlari" panel. `historyHref` is where the crumb leads.
   */
  web?: { historyHref: string };
}

/**
 * One order, as the owner sees it (Checkout.dc.html `screen: order`): what was bought, the status
 * card, the code of a delivered voucher, the steps, the amount and what to do next. The server's
 * strings are shown as they come: amounts through `formatMoney`, the code as text.
 */
export function OrderStatusView({ order, homeHref, productHref, web }: OrderStatusViewProps) {
  const nav = useTranslations('web.nav');
  const t = useTranslations('store.order');
  const formatMoney = useFormatMoney();
  const { userDateTime } = useDateFormat();
  const itemLabel = useItemLabel();

  const kind = heroKindOf(order.status, order.voucher !== null);
  const item = itemLabel(order);
  const username = order.recipient.fields['username'] ?? order.recipient.displayName;
  const total = formatMoney(order.totalTiyin);
  const chipKey = chipKeyOf(order.status);

  // From 768 px the web page is the design's two-column one (the product moves into the side
  // panel); a phone gets the Mini App's single column. Chosen in JS rather than by hiding a copy
  // in CSS, so the page holds each block once.
  const wide = useMediaQuery('(min-width: 768px)') && web !== undefined;
  const status = (
    <div className="flex min-w-0 flex-col gap-4 md:gap-5">
      {wide ? null : (
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
      )}

      <OrderHero
        kind={kind}
        title={t(`hero.${kind}.title`)}
        body={
          kind === 'failed' || kind === 'cancelled'
            ? t(`hero.${kind}.body`, { total })
            : t(`hero.${kind}.body`, { username, item })
        }
        decoration={kind === 'delivered' ? <SuccessBurst orderId={order.id} /> : undefined}
        layout={wide ? 'row' : 'center'}
      />

      {order.voucher ? <VoucherBlock code={order.voucher.code} /> : null}
      <OrderTimeline order={order} roomy={wide} />
      {wide ? null : (
        <>
          <OrderDetailsCard order={order} />
          <OrderActions kind={kind} homeHref={homeHref} productHref={productHref} />
        </>
      )}
    </div>
  );
  if (web === undefined) return status;

  // The same wrapper and position for `status` at every width, so crossing 768 px does not remount
  // it (the hero, the burst and the timeline keep their state); only the extras come and go.
  return (
    <div className="flex flex-col gap-4">
      {wide ? (
        <nav aria-label={t('breadcrumb')}>
          <ol className="m-0 flex list-none items-center gap-1.5 p-0 text-[13px] leading-5 font-semibold text-foreground-muted">
            <li>
              <Link
                href={web.historyHref}
                className={`relative inline-block text-foreground-muted hover:text-foreground ${HIT_AREA_LINK}`}
              >
                {nav('orders')}
              </Link>
            </li>
            <li aria-hidden="true">
              <Icon icon={ChevronRight} size={12} />
            </li>
            <li aria-current="page" className="text-foreground tabular-nums">
              {t('number', { number: order.number })}
            </li>
          </ol>
        </nav>
      ) : null}
      <div
        className={
          wide ? 'grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-6' : undefined
        }
      >
        {status}
        {wide ? (
          <OrderWebAside order={order} kind={kind} homeHref={homeHref} productHref={productHref} />
        ) : null}
      </div>
    </div>
  );
}
