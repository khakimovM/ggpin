import { Logger } from '@nestjs/common';
import {
  RECIPIENT_PLACEHOLDER,
  storedRecipientView,
  totalAfterDiscount,
  type Locale,
  type OrderDetail,
  type OrderDto,
  type OrderRecipient,
  type OrderStatus,
} from '@repo/shared';
import type { OrderDetailView, OrderView } from '../orders.repository';

const logger = new Logger('OrderMapper');

// A stored recipient with neither a name nor a username (a broken row) is shown as the shared
// placeholder: the list, the order and a replay still answer (review M2, audit I6), and the order
// id is logged so the row can be looked at.
function recipientOf(row: OrderView): OrderRecipient {
  const view = storedRecipientView(row.recipient);
  if (view !== null) return view;
  logger.warn(
    `order ${row.id} stores a recipient without a name or username: shown as a placeholder`,
  );
  return { displayName: RECIPIENT_PLACEHOLDER, fields: {} };
}

export interface TimelineEvent {
  readonly from: OrderStatus | null;
  readonly to: OrderStatus;
  readonly createdAt: Date;
}

export interface TimelineItem {
  readonly status: OrderStatus;
  readonly at: string;
}

/**
 * The only place an order row becomes the public shape (docs/04 "Buyurtma"). Fields are listed
 * one by one; the row does not even carry cost, maxCost, providerRef or the FX snapshot id
 * (OrdersRepository selects none of them). `recipient` is shaped for every product: what to show,
 * plus the product form's keys (`{ username }` for Telegram), read leniently from the stored row:
 * a row of an older input rule never fails the answer.
 */
export function toOrderDto(row: OrderView, locale: Locale): OrderDto {
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    productId: row.productId,
    productSlug: row.product.slug,
    productName: locale === 'ru' ? row.product.nameRu : row.product.nameUz,
    skuId: row.skuId,
    quantity: row.quantity,
    recipient: recipientOf(row),
    priceTiyin: row.priceTiyin.toString(),
    discountTiyin: row.discountTiyin.toString(),
    totalTiyin: totalAfterDiscount(row.priceTiyin, row.discountTiyin).toString(),
    currency: 'UZS',
    createdAt: row.createdAt.toISOString(),
    deliveredAt: row.deliveredAt === null ? null : row.deliveredAt.toISOString(),
  };
}

/**
 * When the order entered each status, oldest first. `createdAt` has millisecond precision, so two
 * events written in quick succession (a failure and its refund, in one transaction) can share it,
 * and ids are random: time alone cannot order a tie. The next event is therefore the earliest one
 * that LEAVES the status the previous one entered (the first leaves "no status"). If the chain is
 * broken (it never is: every status change goes through transitionOrder), the earliest remaining
 * event comes next.
 */
export function orderTimeline(events: readonly TimelineEvent[]): TimelineItem[] {
  const remaining = [...events].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const timeline: TimelineItem[] = [];
  let current: OrderStatus | null = null;
  while (remaining.length > 0) {
    const chained = remaining.findIndex((event) => event.from === current);
    const [next] = remaining.splice(chained === -1 ? 0 : chained, 1);
    if (next === undefined) break;
    timeline.push({ status: next.to, at: next.createdAt.toISOString() });
    current = next.to;
  }
  return timeline;
}

/** `GET /orders/:id`: the list shape + timeline + voucher (`null`: Stars and Premium have none). */
export function toOrderDetail(row: OrderDetailView, locale: Locale): OrderDetail {
  return { ...toOrderDto(row, locale), timeline: orderTimeline(row.events), voucher: null };
}
