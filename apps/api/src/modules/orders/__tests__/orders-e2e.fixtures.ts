import { randomBytes } from 'node:crypto';
import type { Prisma, Quote } from '@repo/db';
import type { PrismaService } from '../../../infra/prisma/prisma.service';

type Db = PrismaService['client'];

export interface OrdersCatalog {
  readonly productId: string;
  readonly productSlug: string;
  readonly nameUz: string;
  readonly nameRu: string;
  readonly skuId: string;
  readonly fxRateId: string;
  readonly costSnapshotId: string;
}

// Distinctive numbers: the logging suite searches the log output for them.
export const PRICE_TIYIN = 550_000n;
export const COST_NANO = 123_456_789n;
export const MAX_COST_NANO = 127_160_493n;
export const RECIPIENT = { username: 'aziz_k', displayName: 'Aziz' } as const;

// An order references its product, pack, FX rate and (through its quote) cost snapshot with
// Restrict, so these rows outlive the suite. They are built so that no other suite can see them:
// the product is inactive (the catalog lists active products, and only categories that have one),
// and the FX rate and cost snapshot are from 2020 (stale for every price read and never the
// latest TON_UZS rate). POST /orders reads only the quote, so none of that matters to it.
const OLD = new Date('2020-01-01T00:00:00.000Z');

export async function buildOrdersCatalog(db: Db, sfx: string): Promise<OrdersCatalog> {
  const category = await db.category.create({
    data: { slug: `e2e-orders-${sfx}`, nameUz: 'Orders', nameRu: 'Orders', sort: 99 },
  });
  const nameUz = `Yulduzlar ${sfx}`;
  const nameRu = `Звёзды ${sfx}`;
  const product = await db.product.create({
    data: {
      slug: `e2e-orders-stars-${sfx}`,
      categoryId: category.id,
      nameUz,
      nameRu,
      imageUrl: '/images/x.png',
      deliveryType: 'TG_USERNAME',
      inputSchema: [{ key: 'username', type: 'tgUsername', label: 'fields.tgUsername' }],
      isActive: false,
      allowCustomQty: true,
      minQty: 50,
      maxQty: 1000,
    },
  });
  const sku = await db.sku.create({
    data: {
      productId: product.id,
      quantity: 50,
      labelUz: '50',
      labelRu: '50',
      markupBps: 1000,
      minMarginTiyin: 0n,
      sort: 50,
    },
  });
  const fx = await db.fxRate.create({
    data: { pair: 'TON_UZS', rate: '40000', source: 'e2e-orders', createdAt: OLD },
  });
  const cost = await db.costSnapshot.create({
    data: {
      productId: product.id,
      skuId: null,
      adapter: 'FRAGMENT',
      currency: 'TON',
      basisQuantity: 1,
      // Only referenced (Quote.costSnapshotId); nothing here prices from it.
      costMinor: 2_500_000n,
      source: 'e2e-orders',
      createdAt: OLD,
    },
  });
  return {
    productId: product.id,
    productSlug: product.slug,
    nameUz,
    nameRu,
    skuId: sku.id,
    fxRateId: fx.id,
    costSnapshotId: cost.id,
  };
}

export interface QuoteOptions {
  readonly expiresAt?: Date;
  readonly priceTiyin?: bigint;
  /** A custom quantity: no pack. */
  readonly quantity?: number;
  readonly discountCodeId?: string;
  /** `null`: a quote without the provider handle (older than S2, or written by hand). */
  readonly providerRef?: string | null;
  /** A stored recipient of another shape (an older input rule). */
  readonly recipient?: Prisma.InputJsonObject;
}

/**
 * A quote row as POST /quotes writes it (the orders suites do not price: they need the row).
 * Ten minutes of life by the REAL clock, which the database guards judge expiry by.
 */
export function insertQuote(
  db: Db,
  catalog: OrdersCatalog,
  userId: string,
  options: QuoteOptions = {},
): Promise<Quote> {
  return db.quote.create({
    data: {
      userId,
      productId: catalog.productId,
      skuId: options.quantity === undefined ? catalog.skuId : null,
      quantity: options.quantity ?? 50,
      recipient: options.recipient ?? { ...RECIPIENT },
      providerRef:
        options.providerRef === undefined
          ? `ref_${randomBytes(6).toString('hex')}`
          : options.providerRef,
      costCurrency: 'TON',
      costMinor: COST_NANO,
      fxRateId: catalog.fxRateId,
      costSnapshotId: catalog.costSnapshotId,
      priceTiyin: options.priceTiyin ?? PRICE_TIYIN,
      maxCostMinor: MAX_COST_NANO,
      discountCodeId: options.discountCodeId ?? null,
      expiresAt: options.expiresAt ?? new Date(Date.now() + 600_000),
    },
  });
}

/** A discount code of `userId` (an inactive tier: phase 10 data that nothing else may pick up). */
export async function insertDiscountCode(db: Db, userId: string): Promise<string> {
  const tag = randomBytes(6).toString('hex');
  const tier = await db.discountTier.create({
    data: { bps: 500, priceCoins: 100n, isActive: false },
  });
  const code = await db.discountCode.create({
    data: { userId, tierId: tier.id, bps: 500, code: `E2E-ORDERS-${tag}` },
  });
  return code.id;
}

/**
 * Order(PAID) of `quote` and its PURCHASE entry in ONE transaction, as the purchase writes them:
 * the database refuses an order without its debit and a debit without its order (migration
 * p5_order_purchase_ledger_check, D-60). For suites that need an order row, not the purchase path.
 */
export function insertPaidOrder(
  db: Db,
  quote: Quote,
  options: { readonly id?: string; readonly entryCreatedAt?: Date } = {},
): Promise<{ readonly orderId: string; readonly entryId: string }> {
  return db.$transaction(async (tx) => {
    const order = await tx.order.create({
      data: {
        ...(options.id === undefined ? {} : { id: options.id }),
        userId: quote.userId,
        quoteId: quote.id,
        productId: quote.productId,
        skuId: quote.skuId,
        quantity: quote.quantity,
        recipient: quote.recipient ?? {},
        providerRef: quote.providerRef,
        priceTiyin: quote.priceTiyin,
        costCurrency: quote.costCurrency,
        costMinor: quote.costMinor,
        maxCostMinor: quote.maxCostMinor,
        fxRateId: quote.fxRateId,
        status: 'PAID',
        idempotencyKey: `k_${randomBytes(12).toString('hex')}`,
        requestHash: 'e2e-fixture',
        events: { create: { from: null, to: 'PAID', actor: 'SYSTEM' } },
      },
      select: { id: true, priceTiyin: true, discountTiyin: true },
    });
    const entry = await tx.ledgerEntry.create({
      data: {
        userId: quote.userId,
        kind: 'PURCHASE',
        amountTiyin: -(order.priceTiyin - order.discountTiyin),
        refType: 'ORDER',
        refId: order.id,
        ...(options.entryCreatedAt === undefined ? {} : { createdAt: options.entryCreatedAt }),
      },
      select: { id: true },
    });
    return { orderId: order.id, entryId: entry.id };
  });
}
