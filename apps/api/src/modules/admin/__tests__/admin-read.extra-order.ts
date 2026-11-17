import { randomBytes } from 'node:crypto';
import type { OrderStatus, PrismaClient } from '@repo/db';

/**
 * Another order of the world's user, copied from its delivered one but in `status` (never
 * DELIVERED): it must not count in `ordersCount` / `ordersTotalTiyin` (CR m2: both DELIVERED).
 */
export async function extraOrder(
  db: PrismaClient,
  deliveredOrderId: string,
  status: Exclude<OrderStatus, 'DELIVERED'>,
): Promise<string> {
  const base = await db.order.findUniqueOrThrow({
    where: { id: deliveredOrderId },
    include: { quote: true },
  });
  const { quote } = base;
  const copy = await db.quote.create({
    data: {
      userId: quote.userId,
      skuId: quote.skuId,
      productId: quote.productId,
      quantity: quote.quantity,
      recipient: quote.recipient ?? {},
      costCurrency: quote.costCurrency,
      costMinor: quote.costMinor,
      fxRateId: quote.fxRateId,
      costSnapshotId: quote.costSnapshotId,
      priceTiyin: quote.priceTiyin,
      maxCostMinor: quote.maxCostMinor,
      expiresAt: quote.expiresAt,
      usedAt: quote.usedAt,
    },
  });
  const order = await db.order.create({
    data: {
      userId: base.userId,
      quoteId: copy.id,
      productId: base.productId,
      skuId: base.skuId,
      quantity: base.quantity,
      recipient: base.recipient ?? {},
      priceTiyin: base.priceTiyin,
      discountTiyin: 0n,
      costCurrency: base.costCurrency,
      costMinor: base.costMinor,
      maxCostMinor: base.maxCostMinor,
      fxRateId: base.fxRateId,
      status,
      idempotencyKey: `ar-${randomBytes(8).toString('hex')}`,
      requestHash: 'h',
      // A second older: the orders tab (newest first) keeps the delivered one on top.
      createdAt: new Date(base.createdAt.getTime() - 1000),
    },
  });
  return order.id;
}
