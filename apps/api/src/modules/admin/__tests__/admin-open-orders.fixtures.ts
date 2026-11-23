import { randomBytes } from 'node:crypto';
import type { OrderStatus, PrismaClient } from '@repo/db';

// Synthetic orders for the I-5 suites (phase 9 S7a): one small catalog per call and an order of
// the user in `status`. Rows are kept (orders restrict their user, quote and product), like the
// other suites' ledger users. No ledger entry is written: the open-orders check reads statuses only.

const hex = (n: number): string => randomBytes(n).toString('hex');

export interface OpenOrderRow {
  readonly id: string;
  readonly number: number;
}

export async function orderOf(
  db: PrismaClient,
  userId: string,
  status: OrderStatus,
  priceTiyin = 1_600_000n,
): Promise<OpenOrderRow> {
  const tag = hex(5);
  const category = await db.category.create({
    data: { slug: `oo-${tag}`, nameUz: `OO kat ${tag}`, nameRu: `OO кат ${tag}` },
  });
  const product = await db.product.create({
    data: {
      slug: `oo-${tag}`,
      categoryId: category.id,
      nameUz: `OO mahsulot ${tag}`,
      nameRu: `OO товар ${tag}`,
      imageUrl: 'https://cdn.example.test/p.png',
      deliveryType: 'TG_USERNAME',
      inputSchema: [{ key: 'username', type: 'username' }],
      isActive: false,
    },
  });
  const sku = await db.sku.create({
    data: { productId: product.id, labelUz: '50', labelRu: '50', quantity: 50, markupBps: 1500 },
  });
  const fxRate = await db.fxRate.create({
    data: { pair: 'USDT_UZS', rate: '12500', source: 'e2e' },
  });
  const snapshot = await db.costSnapshot.create({
    data: {
      productId: product.id,
      skuId: sku.id,
      adapter: 'FRAGMENT',
      currency: 'USDT',
      basisQuantity: 50,
      costMinor: 1_000_000n,
      source: 'simulator',
    },
  });
  const recipient = { username: 'someone', displayName: 'Some One' };
  const quote = await db.quote.create({
    data: {
      userId,
      skuId: sku.id,
      productId: product.id,
      quantity: 50,
      recipient,
      costCurrency: 'USDT',
      costMinor: 1_000_000n,
      fxRateId: fxRate.id,
      costSnapshotId: snapshot.id,
      priceTiyin,
      maxCostMinor: 1_100_000n,
      expiresAt: new Date(Date.now() + 5 * 60_000),
      usedAt: new Date(),
    },
  });
  const order = await db.order.create({
    data: {
      userId,
      quoteId: quote.id,
      productId: product.id,
      skuId: sku.id,
      quantity: 50,
      recipient,
      priceTiyin,
      costCurrency: 'USDT',
      costMinor: 1_000_000n,
      maxCostMinor: 1_100_000n,
      fxRateId: fxRate.id,
      status,
      idempotencyKey: `oo-${hex(8)}`,
      requestHash: 'h',
    },
    select: { id: true, number: true },
  });
  return order;
}

/** Moves the order to `status` directly (a fixture: the state machine is the worker's, not here). */
export async function setOrderStatus(
  db: PrismaClient,
  orderId: string,
  status: OrderStatus,
): Promise<void> {
  await db.order.update({ where: { id: orderId }, data: { status } });
}
