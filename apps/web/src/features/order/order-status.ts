import { CLIENT_STATUS_GROUP, type ClientStatusGroup, type OrderStatus } from '@repo/shared';

// What the client does with a raw order status (docs/04 "Buyurtma holatlari klientda"). The label
// text lives in i18n; this file only decides WHICH label, which chip and whether to keep asking.

/** Poll every two seconds while the order is moving on its own (paid, queued, processing). */
export const ORDER_POLL_MS = 2000;
/** A held or reviewed order waits for a person, for minutes: asking every 2 s only loads the server. */
export const ORDER_REVIEW_POLL_MS = 20_000;

const POLLING: ReadonlySet<OrderStatus> = new Set([
  'PAID',
  'QUEUED',
  'PROCESSING',
  'HELD',
  'NEEDS_REVIEW',
]);

/** PAID, QUEUED, PROCESSING, HELD, NEEDS_REVIEW: the order moves on without the visitor. */
export function isActiveOrder(status: OrderStatus): boolean {
  return POLLING.has(status);
}

/**
 * `refetchInterval` of the order query: fast while the order moves by itself, slow while it waits
 * for a person, never once it has settled (nor before the first answer: a failed first load is the
 * visitor's retry).
 */
export function orderPollInterval(status: OrderStatus | undefined): number | false {
  if (status === undefined || !isActiveOrder(status)) return false;
  return status === 'HELD' || status === 'NEEDS_REVIEW' ? ORDER_REVIEW_POLL_MS : ORDER_POLL_MS;
}

export type ChipKey = 'queued' | 'processing' | 'review' | 'delivered' | 'refunded' | 'cancelled';

const CHIP_KEY: Record<ClientStatusGroup, ChipKey> = {
  QUEUED: 'queued',
  PROCESSING: 'processing',
  REVIEW: 'review',
  DELIVERED: 'delivered',
  REFUNDED: 'refunded',
  CANCELLED: 'cancelled',
};

/** The `store.order.status.*` label of a raw status (PAID and QUEUED are both "Navbatda"). */
export function chipKeyOf(status: OrderStatus): ChipKey {
  return CHIP_KEY[CLIENT_STATUS_GROUP[status]];
}

export type HeroKind =
  | 'paid'
  | 'queued'
  | 'processing'
  | 'review'
  | 'delivered'
  | 'voucher'
  | 'failed'
  | 'refunded'
  | 'cancelled';

/** The big card on the order page. A delivered order with a code is "Kod tayyor!". */
export function heroKindOf(status: OrderStatus, hasVoucher: boolean): HeroKind {
  switch (status) {
    case 'PAID':
      return 'paid';
    case 'QUEUED':
      return 'queued';
    case 'PROCESSING':
      return 'processing';
    case 'HELD':
    case 'NEEDS_REVIEW':
      return 'review';
    case 'DELIVERED':
      return hasVoucher ? 'voucher' : 'delivered';
    case 'FAILED':
      return 'failed';
    case 'REFUNDED':
      return 'refunded';
    case 'CANCELLED':
      return 'cancelled';
  }
}

/**
 * Failed and cancelled orders are refunded in full, automatically: the page shows that amount back.
 * A REFUNDED order was refunded by an admin, possibly in part, and the DTO has no refunded amount
 * yet (phase 5 adds `refundedTiyin`): there the page says the money went back, without a figure.
 */
export function isRefundedOrder(status: OrderStatus): boolean {
  return status === 'FAILED' || status === 'CANCELLED';
}
