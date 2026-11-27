import { Injectable } from '@nestjs/common';
import { appendLedgerEntry, lockWallet, sumBalance, type Prisma } from '@repo/db';
import type { OrderStatus } from '@repo/shared';
import type { Db } from '../../infra/prisma/db';
import { PrismaService } from '../../infra/prisma/prisma.service';

// What the API reads of an order: the public fields and the product's names. providerRef, cost,
// maxCost, the FX snapshot id and the key are NOT selected, so they cannot reach a mapper, a
// response or a log line by accident (docs/04: no cost, rate, attempts or internal ids).
const ORDER_VIEW = {
  id: true,
  number: true,
  status: true,
  productId: true,
  skuId: true,
  quantity: true,
  recipient: true,
  priceTiyin: true,
  discountTiyin: true,
  createdAt: true,
  deliveredAt: true,
  product: { select: { slug: true, nameUz: true, nameRu: true } },
} satisfies Prisma.OrderSelect;

const STORED_ORDER = { ...ORDER_VIEW, requestHash: true } satisfies Prisma.OrderSelect;

const ORDER_DETAIL = {
  ...ORDER_VIEW,
  events: { select: { from: true, to: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
} satisfies Prisma.OrderSelect;

// Everything the purchase copies from the quote (the Order INSERT guard demands equality on
// each of these columns, audit Z4), plus what the checks read. Internal: never mapped to a DTO.
const QUOTE_FOR_ORDER = {
  id: true,
  userId: true,
  productId: true,
  skuId: true,
  quantity: true,
  recipient: true,
  providerRef: true,
  costCurrency: true,
  costMinor: true,
  maxCostMinor: true,
  fxRateId: true,
  priceTiyin: true,
  discountCodeId: true,
  expiresAt: true,
  usedAt: true,
  order: { select: { id: true, userId: true } },
  // A Telegram product's quote must carry the provider handle of its recipient (audit L2).
  product: { select: { deliveryType: true } },
} satisfies Prisma.QuoteSelect;

export type OrderView = Prisma.OrderGetPayload<{ select: typeof ORDER_VIEW }>;
export type StoredOrder = Prisma.OrderGetPayload<{ select: typeof STORED_ORDER }>;
export type OrderDetailView = Prisma.OrderGetPayload<{ select: typeof ORDER_DETAIL }>;
export type QuoteForOrder = Prisma.QuoteGetPayload<{ select: typeof QUOTE_FOR_ORDER }>;

export interface NewOrder {
  readonly userId: string;
  /** The order's fixed columns are copied from this row, never from anywhere else. */
  readonly quote: QuoteForOrder;
  readonly discountTiyin: bigint;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

export interface PurchaseGate {
  readonly isBlocked: boolean;
  readonly purchaseFrozen: boolean;
}

export interface OrderListFilter {
  readonly status?: readonly OrderStatus[];
  readonly page: number;
  readonly limit: number;
}

/** OrderEvent.actor of the creation event (the free-text actor of transitionOrder, @repo/db). */
const CREATED_BY = 'SYSTEM';

// Copied verbatim (jsonb `=` in the INSERT guard): the stored object is passed back as it is.
function jsonObject(value: Prisma.JsonValue): Prisma.JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('quote recipient is not a JSON object');
  }
  return value;
}

// All Prisma access of the orders module. Every query is scoped to the owner's id; the purchase
// methods take the caller's transaction client.
@Injectable()
export class OrdersRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return this.prisma.client.$transaction(fn);
  }

  /** Serialises the user's money movements until `tx` ends; throws WalletNotFoundError. */
  lockWallet(tx: Db, userId: string): Promise<void> {
    return lockWallet(tx, userId);
  }

  /** The order this user made under this key (the D-49 replay record), or null. */
  findByKey(
    userId: string,
    idempotencyKey: string,
    db: Db = this.prisma.client,
  ): Promise<StoredOrder | null> {
    return db.order.findUnique({
      where: { userId_idempotencyKey: { userId, idempotencyKey } },
      select: STORED_ORDER,
    });
  }

  /** The user's own quote; another user's is null, like a missing one. */
  findOwnQuote(tx: Db, userId: string, quoteId: string): Promise<QuoteForOrder | null> {
    return tx.quote.findFirst({ where: { id: quoteId, userId }, select: QUOTE_FOR_ORDER });
  }

  /** The id of the user's own order made from this quote, or null. */
  async findOwnOrderIdByQuote(
    userId: string,
    quoteId: string,
    db: Db = this.prisma.client,
  ): Promise<string | null> {
    const row = await db.order.findFirst({ where: { quoteId, userId }, select: { id: true } });
    return row?.id ?? null;
  }

  /**
   * The account flags a purchase obeys, in ONE read under the wallet lock (review N2, audit L1):
   * a block or a freeze written while the purchase waited for the lock is seen. Null: no such user.
   */
  purchaseGate(tx: Db, userId: string): Promise<PurchaseGate | null> {
    return tx.user.findUnique({
      where: { id: userId },
      select: { isBlocked: true, purchaseFrozen: true },
    });
  }

  /** SUM(ledger); decides a purchase only when read under the wallet lock. */
  balance(tx: Db, userId: string): Promise<bigint> {
    return sumBalance(tx, userId);
  }

  /** Order(PAID) and its first OrderEvent (null -> PAID). The database sets `createdAt`. */
  createPaid(tx: Db, input: NewOrder): Promise<OrderView> {
    const { quote } = input;
    return tx.order.create({
      data: {
        userId: input.userId,
        quoteId: quote.id,
        productId: quote.productId,
        skuId: quote.skuId,
        quantity: quote.quantity,
        recipient: jsonObject(quote.recipient),
        providerRef: quote.providerRef,
        priceTiyin: quote.priceTiyin,
        discountTiyin: input.discountTiyin,
        costCurrency: quote.costCurrency,
        costMinor: quote.costMinor,
        maxCostMinor: quote.maxCostMinor,
        fxRateId: quote.fxRateId,
        status: 'PAID',
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        events: { create: { from: null, to: 'PAID', actor: CREATED_BY } },
      },
      select: ORDER_VIEW,
    });
  }

  /** LedgerEntry(PURCHASE, -total, ORDER/<orderId>): the order's one debit. */
  appendPurchase(
    tx: Db,
    userId: string,
    orderId: string,
    totalTiyin: bigint,
  ): Promise<{ id: string }> {
    return appendLedgerEntry(tx, {
      userId,
      kind: 'PURCHASE',
      amountTiyin: -totalTiyin,
      refType: 'ORDER',
      refId: orderId,
    });
  }

  /** NULL -> `at`, only while unused; false when it was already used (0 rows). */
  async markQuoteUsed(tx: Db, userId: string, quoteId: string, at: Date): Promise<boolean> {
    const { count } = await tx.quote.updateMany({
      where: { id: quoteId, userId, usedAt: null },
      data: { usedAt: at },
    });
    return count === 1;
  }

  /** The user's own orders, newest first; `number` breaks ties so pages never overlap. */
  async listOwn(
    userId: string,
    filter: OrderListFilter,
  ): Promise<{ rows: OrderView[]; total: number }> {
    const where: Prisma.OrderWhereInput = {
      userId,
      ...(filter.status === undefined ? {} : { status: { in: [...filter.status] } }),
    };
    const [rows, total] = await this.prisma.client.$transaction([
      this.prisma.client.order.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { number: 'desc' }],
        skip: (filter.page - 1) * filter.limit,
        take: filter.limit,
        select: ORDER_VIEW,
      }),
      this.prisma.client.order.count({ where }),
    ]);
    return { rows, total };
  }

  /** The user's own order with its state changes; another user's is null, like a missing one. */
  findOwnDetail(userId: string, orderId: string): Promise<OrderDetailView | null> {
    return this.prisma.client.order.findFirst({
      where: { id: orderId, userId },
      select: ORDER_DETAIL,
    });
  }
}
