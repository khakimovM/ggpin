'use client';

import type { OrderDetail } from '@repo/shared';
import { useTranslations } from 'next-intl';
import { Money } from '../../lib/format/money';
import { useDateFormat } from '../../lib/format/use-date-format';
import { isRefundedOrder } from './order-status';

/**
 * Order number, payment method, the amount (the server's `totalTiyin`) and, when refunded, the
 * refund. `bare` is the web order page's side panel (Store.dc.html): the panel is the card, so the
 * rows draw no box of their own, and the date row is there.
 */
export function OrderDetailsCard({ order, bare = false }: { order: OrderDetail; bare?: boolean }) {
  const t = useTranslations('store.order');
  const { dateTime } = useDateFormat();
  return (
    <section
      className={
        bare
          ? 'flex flex-col gap-2.5 text-sm leading-5 font-semibold tabular-nums'
          : 'flex flex-col gap-2.5 rounded-[24px] border border-border bg-card p-4 text-sm leading-5 font-semibold tabular-nums'
      }
    >
      <div className="flex justify-between gap-3">
        <span className="text-foreground-muted">{t('details.order')}</span>
        <span>#{order.number}</span>
      </div>
      {bare ? (
        <div className="flex justify-between gap-3">
          <span className="text-foreground-muted">{t('details.date')}</span>
          <span>{dateTime(new Date(order.createdAt))}</span>
        </div>
      ) : null}
      <div className="flex justify-between gap-3">
        <span className="text-foreground-muted">{t('details.payment')}</span>
        <span>{t('details.wallet')}</span>
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-foreground-muted">{t('details.amount')}</span>
        <Money tiyin={order.totalTiyin} size="md" />
      </div>
      {isRefundedOrder(order.status) ? (
        <div className="flex items-baseline justify-between gap-3 text-success-text">
          <span>{t('details.refunded')}</span>
          <span className="font-extrabold">
            +<Money tiyin={order.totalTiyin} size="md" className="text-success-text" />
          </span>
        </div>
      ) : null}
      {order.status === 'REFUNDED' ? (
        // An admin refund may be partial and the DTO carries no refunded amount yet: no figure here.
        <div className="flex items-baseline justify-between gap-3 text-success-text">
          <span>{t('details.refunded')}</span>
          <span className="font-extrabold">{t('details.wallet')}</span>
        </div>
      ) : null}
    </section>
  );
}
