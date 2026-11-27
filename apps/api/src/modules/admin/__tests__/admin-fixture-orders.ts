import { randomBytes } from 'node:crypto';
import {
  refundFailedOrder,
  transitionOrder,
  type OrderStatus,
  type Prisma,
  type PrismaClient,
  type Quote,
} from '@repo/db';

// Orders for the admin e2e fixtures (`ar-` read world, `oo-` open orders), built only along the
// legal paths the database allows (migrations 10-11, D-60), like the owner CLI fixtures
// (cli/__tests__/order-cli.fixtures.ts): Order(PAID) and its PURCHASE entry in one transaction,
// then every status through `transitionOrder` (or the refund helper), a DELIVERED order with its
// CONFIRMED attempt. The database stamps createdAt and deliveredAt; no fixture backdates them.
//
// An order is never deleted (Order_no_delete) and holds its quote, cost snapshot, FX rate,
// product and pack by foreign key. So each prefix has ONE persistent catalog (`<prefix>fixture`,
// an inactive product) that every run reuses: the product count stays flat across runs, and only
// orders (with their quotes) accumulate. The order's FX rate and cost snapshot are dated 2020, so
// they are never the newest price input of any suite; a read world adds its own fresh, unreferenced
// inputs, which the purge removes (admin-fixture-purge.ts).

const OLD = new Date('2020-01-01T00:00:00.000Z');
const hex = (n: number): string => randomBytes(n).toString('hex');

/** The cost every fixture quote locks: 1 USDT, 12 500 so'm at the 2020 USDT_UZS snapshot. */
export const FIXTURE_COST_MINOR = 1_000_000n;
export const FIXTURE_MAX_COST_MINOR = 1_100_000n;
export const FIXTURE_RATE = '12500';

export interface FixtureCatalog {
  readonly categoryId: string;
  readonly productId: string;
  readonly skuId: string;
  /** The 2020 USDT_UZS rate the fixture quotes and orders lock (persistent, referenced). */
  readonly orderFxRateId: string;
  /** The 2020 cost snapshot the fixture quotes reference (persistent, referenced). */
  readonly orderSnapshotId: string;
}

/** The persistent catalog of `prefix`, created on first use and reset to its fixed state. */
export async function fixtureCatalog(db: PrismaClient, prefix: string): Promise<FixtureCatalog> {
  const slug = `${prefix}fixture`;
  const label = prefix.replace(/-$/, '').toUpperCase();
  const category = await db.category.upsert({
    where: { slug },
    create: { slug, nameUz: `${label} kat`, nameRu: `${label} кат` },
    update: {},
  });
  const product = await db.product.upsert({
    where: { slug },
    create: {
      slug,
      categoryId: category.id,
      nameUz: `${label} mahsulot`,
      nameRu: `${label} товар`,
      imageUrl: 'https://cdn.example.test/p.png',
      deliveryType: 'TG_USERNAME',
      inputSchema: [{ key: 'username', type: 'username' }],
      isActive: false,
    },
    update: { categoryId: category.id, isActive: false },
  });
  const existing = await db.sku.findFirst({
    where: { productId: product.id },
    select: { id: true },
  });
  const pack = {
    labelUz: '50',
    labelRu: '50',
    markupBps: 1500,
    minMarginTiyin: 0n,
    isActive: true,
  };
  const sku =
    existing === null
      ? await db.sku.create({ data: { productId: product.id, quantity: 50, ...pack } })
      : await db.sku.update({ where: { id: existing.id }, data: pack });
  const source = `${prefix}fixture`;
  const rate =
    (await db.fxRate.findFirst({ where: { pair: 'USDT_UZS', source }, select: { id: true } })) ??
    (await db.fxRate.create({
      data: { pair: 'USDT_UZS', rate: FIXTURE_RATE, source, createdAt: OLD },
      select: { id: true },
    }));
  const snapshot =
    (await db.costSnapshot.findFirst({
      where: { productId: product.id, skuId: sku.id, source },
      select: { id: true },
    })) ??
    (await db.costSnapshot.create({
      data: {
        productId: product.id,
        skuId: sku.id,
        adapter: 'FRAGMENT',
        currency: 'USDT',
        basisQuantity: 50,
        costMinor: FIXTURE_COST_MINOR,
        source,
        createdAt: OLD,
      },
      select: { id: true },
    }));
  return {
    categoryId: category.id,
    productId: product.id,
    skuId: sku.id,
    orderFxRateId: rate.id,
    orderSnapshotId: snapshot.id,
  };
}

export interface FixtureQuoteOptions {
  readonly priceTiyin: bigint;
  readonly recipient: Prisma.InputJsonObject;
  readonly discountCodeId?: string;
}

/** A live quote of `userId` for the catalog's pack (ten minutes by the real clock). */
export function fixtureQuote(
  db: PrismaClient,
  catalog: FixtureCatalog,
  userId: string,
  options: FixtureQuoteOptions,
): Promise<Quote> {
  return db.quote.create({
    data: {
      userId,
      skuId: catalog.skuId,
      productId: catalog.productId,
      quantity: 50,
      recipient: options.recipient,
      costCurrency: 'USDT',
      costMinor: FIXTURE_COST_MINOR,
      fxRateId: catalog.orderFxRateId,
      costSnapshotId: catalog.orderSnapshotId,
      priceTiyin: options.priceTiyin,
      maxCostMinor: FIXTURE_MAX_COST_MINOR,
      discountCodeId: options.discountCodeId ?? null,
      expiresAt: new Date(Date.now() + 600_000),
    },
  });
}

/** A discount code of `userId` (an inactive tier: phase 10 data nothing else picks up). */
export async function fixtureDiscountCode(db: PrismaClient, userId: string): Promise<string> {
  const tier = await db.discountTier.create({
    data: { bps: 500, priceCoins: 100n, isActive: false },
  });
  const code = await db.discountCode.create({
    data: { userId, tierId: tier.id, bps: 500, code: `E2E-ADMIN-${hex(6)}` },
  });
  return code.id;
}

export interface FixtureOrder {
  readonly id: string;
  readonly number: number;
}

/**
 * Order(PAID) of `quote` and its PURCHASE entry of -(price - discount) in ONE transaction, as the
 * purchase writes them (Order_purchase_ledger_check). A discount needs the quote's discount code.
 */
export function paidOrder(
  db: PrismaClient,
  quote: Quote,
  idempotencyPrefix: string,
  discountTiyin = 0n,
): Promise<FixtureOrder> {
  return db.$transaction(async (tx) => {
    const order = await tx.order.create({
      data: {
        userId: quote.userId,
        quoteId: quote.id,
        productId: quote.productId,
        skuId: quote.skuId,
        quantity: quote.quantity,
        recipient: quote.recipient ?? {},
        providerRef: quote.providerRef,
        priceTiyin: quote.priceTiyin,
        discountTiyin,
        costCurrency: quote.costCurrency,
        costMinor: quote.costMinor,
        maxCostMinor: quote.maxCostMinor,
        fxRateId: quote.fxRateId,
        status: 'PAID',
        idempotencyKey: `${idempotencyPrefix}${hex(8)}`,
        requestHash: 'h',
        events: { create: { from: null, to: 'PAID', actor: 'SYSTEM' } },
      },
      select: { id: true, number: true },
    });
    await tx.ledgerEntry.create({
      data: {
        userId: quote.userId,
        kind: 'PURCHASE',
        amountTiyin: -(quote.priceTiyin - discountTiyin),
        refType: 'ORDER',
        refId: order.id,
      },
    });
    return order;
  });
}

type Edge = readonly [OrderStatus, OrderStatus];

/** One legal edge in its own transaction (DELIVERED with its CONFIRMED attempt, N1-B). */
async function step(db: PrismaClient, orderId: string, [from, to]: Edge): Promise<void> {
  await db.$transaction(async (tx) => {
    if (to === 'HELD') {
      await transitionOrder(tx, { orderId, from, to, actor: 'system', reason: 'LOW_BALANCE' });
    } else if (to === 'NEEDS_REVIEW' || to === 'FAILED') {
      await transitionOrder(tx, { orderId, from, to, actor: 'system', reason: 'ADAPTER_ERROR' });
    } else if (to === 'CANCELLED') {
      await transitionOrder(tx, { orderId, from, to, actor: 'admin', actorRef: 'e2e-fixture' });
    } else if (to === 'REFUNDED') {
      await refundFailedOrder(tx, { orderId, actor: 'system' });
    } else if (to === 'DELIVERED') {
      const attempt = await tx.fulfillmentAttempt.create({
        data: {
          orderId,
          attemptNo: 1,
          adapter: 'FRAGMENT',
          status: 'SENDING',
          request: {},
          externalRef: `e2e-ref-${hex(6)}`,
        },
        select: { id: true },
      });
      await tx.fulfillmentAttempt.update({
        where: { id: attempt.id },
        data: { status: 'CONFIRMED' },
      });
      await transitionOrder(tx, { orderId, from, to, actor: 'system' });
    } else {
      await transitionOrder(tx, { orderId, from, to, actor: 'system' });
    }
  });
}

const TO_PROCESSING: readonly OrderStatus[] = ['PAID', 'QUEUED', 'PROCESSING'];

/** The legal path from PAID to each status. */
const PATHS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  PAID: ['PAID'],
  QUEUED: ['PAID', 'QUEUED'],
  PROCESSING: TO_PROCESSING,
  HELD: [...TO_PROCESSING, 'HELD'],
  NEEDS_REVIEW: [...TO_PROCESSING, 'NEEDS_REVIEW'],
  FAILED: [...TO_PROCESSING, 'FAILED'],
  DELIVERED: [...TO_PROCESSING, 'DELIVERED'],
  CANCELLED: ['PAID', 'CANCELLED'],
  REFUNDED: [...TO_PROCESSING, 'FAILED', 'REFUNDED'],
};

/** Detours a later move takes from a status that is not on the target's path from PAID. */
const DETOURS: Partial<Record<OrderStatus, Partial<Record<OrderStatus, OrderStatus[]>>>> = {
  // An auto-refunded HELD order: the worker fails it (not sent), then refunds it.
  HELD: { REFUNDED: ['HELD', 'FAILED', 'REFUNDED'] },
};

/** Walks the order from its current status to `to` along a legal path; throws if there is none. */
export async function moveOrder(db: PrismaClient, orderId: string, to: OrderStatus): Promise<void> {
  const { status } = await db.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { status: true },
  });
  const onPath = PATHS[to].indexOf(status);
  const path = onPath >= 0 ? PATHS[to].slice(onPath) : DETOURS[status]?.[to];
  if (path === undefined) throw new Error(`fixture: no legal path ${status} -> ${to}`);
  for (let i = 1; i < path.length; i += 1) {
    const from = path[i - 1];
    const next = path[i];
    if (from === undefined || next === undefined) break;
    await step(db, orderId, [from, next]);
  }
}
