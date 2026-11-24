import type { OrderStatus } from '@repo/shared';
import { useTranslations } from 'use-intl';
import { enumKey } from '../../lib/enum-text';

// Admin.dc.html `SS`: each order status on its status token. The design printed the state machine
// names; the owner chose words (2026-11-23), so the pill says the status in Uzbek.
const TONE: Record<OrderStatus, string> = {
  PAID: 'bg-status-queued-soft text-status-queued',
  QUEUED: 'bg-status-queued-soft text-status-queued',
  PROCESSING: 'bg-status-processing-soft text-status-processing',
  HELD: 'bg-premium-soft text-premium-text',
  NEEDS_REVIEW: 'bg-status-review-soft text-status-review',
  DELIVERED: 'bg-status-delivered-soft text-status-delivered',
  FAILED: 'bg-status-failed-soft text-status-failed',
  CANCELLED: 'bg-status-cancelled-soft text-status-cancelled',
  REFUNDED: 'bg-status-cancelled-soft text-status-cancelled',
};

export function OrderStatusTag({ status }: { status: OrderStatus }) {
  const t = useTranslations();
  return (
    <span
      className={`inline-flex h-5 items-center rounded-[6px] px-[7px] text-[10px] leading-none font-extrabold tracking-[.02em] whitespace-nowrap ${TONE[status]}`}
    >
      {t(enumKey('orderStatus', status))}
    </span>
  );
}
