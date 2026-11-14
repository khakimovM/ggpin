import { Injectable } from '@nestjs/common';
import {
  StaleOrderStateError,
  failAndRefundOrder,
  transitionOrder,
  type Prisma,
  type RefundOutcome,
} from '@repo/db';
import {
  COST_CURRENCIES,
  orderStatusReasonSchema,
  orderStatusSchema,
  type CostCurrency,
  type OrderStatus,
  type OrderStatusReason,
} from '@repo/shared';
import { PrismaService } from '../infra/prisma/prisma.service';

// Order reads and status moves of the fulfillment core. Every move goes through @repo/db
// (`transitionOrder`, `failAndRefundOrder`): the state machine of order-state.ts, a compare-and-set
// on the status, the OrderEvent, and the payout checks under the row locks. A stale move (someone
// else moved the order first) is not an error here: the caller re-reads and does nothing.

export interface RunOrder {
  readonly id: string;
  readonly userId: string;
  readonly status: OrderStatus;
  readonly statusReason: OrderStatusReason | null;
  readonly productId: string;
  readonly productSlug: string;
  readonly skuId: string | null;
  readonly quantity: number;
  /** The stored recipient's text fields (username, displayName...). */
  readonly fields: Readonly<Record<string, string>>;
  readonly providerRef: string | null;
  readonly costCurrency: CostCurrency;
  readonly costMinor: bigint;
  readonly maxCostMinor: bigint;
  readonly priceTiyin: bigint;
  readonly discountTiyin: bigint;
}

export interface HeldEvent {
  readonly eventId: string;
  readonly note: string | null;
}

function fieldsOf(recipient: Prisma.JsonValue): Record<string, string> {
  if (typeof recipient !== 'object' || recipient === null || Array.isArray(recipient)) return {};
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(recipient)) {
    if (typeof value === 'string') fields[key] = value;
  }
  return fields;
}

function currencyOf(text: string): CostCurrency {
  const currency = COST_CURRENCIES.find((c) => c === text);
  if (currency === undefined) throw new Error('an order with an unknown cost currency');
  return currency;
}

@Injectable()
export class OrderStateRepository {
  constructor(private readonly prisma: PrismaService) {}

  async load(orderId: string): Promise<RunOrder | null> {
    const row = await this.prisma.client.order.findUnique({
      where: { id: orderId },
      include: { product: { select: { slug: true } } },
    });
    if (row === null) return null;
    return {
      id: row.id,
      userId: row.userId,
      status: orderStatusSchema.parse(row.status),
      statusReason:
        row.statusReason === null ? null : orderStatusReasonSchema.parse(row.statusReason),
      productId: row.productId,
      productSlug: row.product.slug,
      skuId: row.skuId,
      quantity: row.quantity,
      fields: fieldsOf(row.recipient),
      providerRef: row.providerRef,
      costCurrency: currencyOf(row.costCurrency),
      costMinor: row.costMinor,
      maxCostMinor: row.maxCostMinor,
      priceTiyin: row.priceTiyin,
      discountTiyin: row.discountTiyin,
    };
  }

  async statusOf(orderId: string): Promise<OrderStatus | null> {
    const row = await this.prisma.client.order.findUnique({
      where: { id: orderId },
      select: { status: true },
    });
    return row === null ? null : orderStatusSchema.parse(row.status);
  }

  /** PAID -> QUEUED or QUEUED -> PROCESSING; false when someone else moved the order first. */
  async advance(orderId: string, from: 'PAID' | 'QUEUED'): Promise<boolean> {
    const to = from === 'PAID' ? 'QUEUED' : 'PROCESSING';
    return this.stale(() =>
      this.prisma.client.$transaction(async (tx) => {
        await transitionOrder(tx, { orderId, from, to, actor: 'system' });
        return true;
      }),
    );
  }

  /** PROCESSING -> HELD before any attempt is live; the HELD event's id, or null when stale. */
  async hold(orderId: string, reason: OrderStatusReason, note: string): Promise<string | null> {
    const held = await this.stale(() =>
      this.prisma.client.$transaction(async (tx) => {
        const { eventId } = await transitionOrder(tx, {
          orderId,
          from: 'PROCESSING',
          to: 'HELD',
          actor: 'system',
          reason,
          note,
        });
        return eventId;
      }),
    );
    return held === false ? null : held;
  }

  /**
   * PROCESSING -> FAILED -> REFUNDED with the REFUND ledger entry, in ONE transaction (rules/40).
   * Only before any value left: `failAndRefundOrder` refuses when an attempt may have paid out.
   */
  async failAndRefund(orderId: string, reason: OrderStatusReason): Promise<RefundOutcome | null> {
    const outcome = await this.stale(() =>
      this.prisma.client.$transaction((tx) =>
        failAndRefundOrder(tx, { orderId, from: 'PROCESSING', reason, actor: 'system' }),
      ),
    );
    return outcome === false ? null : outcome;
  }

  /** The order's latest HELD event (its id names the core hold's alert). */
  async latestHold(orderId: string): Promise<HeldEvent | null> {
    const event = await this.prisma.client.orderEvent.findFirst({
      where: { orderId, to: 'HELD' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, note: true },
    });
    return event === null ? null : { eventId: event.id, note: event.note };
  }

  private async stale<T>(write: () => Promise<T>): Promise<T | false> {
    try {
      return await write();
    } catch (error) {
      if (error instanceof StaleOrderStateError) return false;
      throw error;
    }
  }
}
