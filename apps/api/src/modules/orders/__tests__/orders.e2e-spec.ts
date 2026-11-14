import { createHash } from 'node:crypto';
import { CreateOrderResponseSchema, NOTIFY_JOB_NAME, QUEUES } from '@repo/shared';
import { OrdersRepository } from '../orders.repository';
import { COST_NANO, MAX_COST_NANO } from './orders-e2e.fixtures';
import { INTERNAL_KEY, keysOf, newKey, useOrdersE2e } from './orders-e2e.helpers';

describe('POST /orders (e2e): the purchase', () => {
  const t = useOrdersE2e();

  it('201 { order } in the contract shape; order, debit and used quote are written together', async () => {
    const user = await t.newUser();
    await t.fund(user.id, 1_000_000n);
    // Warm the balance cache: the purchase must drop it after commit.
    const before = await t.get('/me/wallet', user);
    expect(before.body.data).toMatchObject({ balanceTiyin: '1000000' });
    const quote = await t.quote(user.id);
    const key = newKey();

    const res = await t.order(user, quote.id, { key });
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const { order } = CreateOrderResponseSchema.parse(res.body.data);
    const catalog = t.catalog();
    expect(order).toEqual({
      id: order.id,
      number: order.number,
      status: 'PAID',
      productId: catalog.productId,
      productSlug: catalog.productSlug,
      productName: catalog.nameUz,
      skuId: catalog.skuId,
      quantity: 50,
      recipient: { displayName: 'Aziz', fields: { username: 'aziz_k' } },
      priceTiyin: '550000',
      discountTiyin: '0',
      totalTiyin: '550000',
      currency: 'UZS',
      createdAt: order.createdAt,
      deliveredAt: null,
    });

    const db = t.db();
    const row = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    // Every column the quote fixed is the quote's (audit Z4), providerRef included.
    expect(row).toMatchObject({
      userId: user.id,
      quoteId: quote.id,
      productId: quote.productId,
      skuId: quote.skuId,
      quantity: quote.quantity,
      recipient: quote.recipient,
      providerRef: quote.providerRef,
      priceTiyin: quote.priceTiyin,
      discountTiyin: 0n,
      costCurrency: quote.costCurrency,
      costMinor: quote.costMinor,
      maxCostMinor: quote.maxCostMinor,
      fxRateId: quote.fxRateId,
      status: 'PAID',
      statusReason: null,
      deliveredAt: null,
      idempotencyKey: key,
      requestHash: createHash('sha256')
        .update(JSON.stringify([quote.id]))
        .digest('hex'),
    });
    expect(row.createdAt.toISOString()).toBe(order.createdAt);
    const events = await db.orderEvent.findMany({
      where: { orderId: order.id },
      select: { from: true, to: true, actor: true },
    });
    expect(events).toEqual([{ from: null, to: 'PAID', actor: 'SYSTEM' }]);
    const debits = await db.ledgerEntry.findMany({
      where: { userId: user.id, kind: 'PURCHASE' },
      select: { amountTiyin: true, refType: true, refId: true },
    });
    expect(debits).toEqual([{ amountTiyin: -550_000n, refType: 'ORDER', refId: order.id }]);
    expect((await db.quote.findUniqueOrThrow({ where: { id: quote.id } })).usedAt).not.toBeNull();

    const after = await t.get('/me/wallet', user);
    expect(after.body.data).toMatchObject({ balanceTiyin: '450000' });
  });

  it('a custom quantity is bought as quoted: skuId null, the quantity kept', async () => {
    const user = await t.newUser();
    await t.fund(user.id, 1_000_000n);
    const quote = await t.quote(user.id, { quantity: 75, priceTiyin: 825_000n });
    const res = await t.order(user, quote.id);
    expect(res.status).toBe(201);
    const { order } = CreateOrderResponseSchema.parse(res.body.data);
    expect([order.skuId, order.quantity, order.totalTiyin]).toEqual([null, 75, '825000']);
  });

  it('after commit: fulfill-order with jobId = orderId and one ORDER_ACCEPTED notice', async () => {
    const user = await t.newUser();
    await t.fund(user.id, 600_000n);
    const res = await t.order(user, (await t.quote(user.id)).id);
    const { order } = CreateOrderResponseSchema.parse(res.body.data);
    const job = await t.queue(QUEUES.FULFILL_ORDER).getJob(order.id);
    expect([job?.name, job?.data]).toEqual(['fulfill', { orderId: order.id }]);
    const notice = await t.queue(QUEUES.NOTIFY).getJob(`order-${order.id}-accepted`);
    expect([notice?.name, notice?.data]).toEqual([
      NOTIFY_JOB_NAME,
      { kind: 'ORDER_ACCEPTED', refId: order.id },
    ]);
  });

  it('the answer carries no providerRef, cost, ceiling, FX or snapshot id', async () => {
    const user = await t.newUser();
    await t.fund(user.id, 600_000n);
    const quote = await t.quote(user.id);
    const res = await t.order(user, quote.id);
    expect(res.status).toBe(201);
    const text = JSON.stringify(res.body);
    for (const internal of [
      quote.providerRef ?? 'providerRef',
      String(COST_NANO),
      String(MAX_COST_NANO),
      quote.fxRateId,
      quote.costSnapshotId,
    ]) {
      expect(text).not.toContain(internal);
    }
    expect(keysOf(res.body).filter((key) => INTERNAL_KEY.test(key))).toEqual([]);
  });

  describe('one transaction (R4-3)', () => {
    it('usedAt is written beside the order: a failure right after it takes order, debit and usedAt back', async () => {
      const user = await t.newUser();
      await t.fund(user.id, 1_000_000n);
      const quote = await t.quote(user.id);
      const repo = t.app().get(OrdersRepository);
      const real = repo.markQuoteUsed.bind(repo);
      let inside: { orders: number; debits: number; usedAt: Date | null } | undefined;
      jest.spyOn(repo, 'markQuoteUsed').mockImplementation(async (tx, userId, quoteId, at) => {
        await real(tx, userId, quoteId, at);
        // Seen from inside the purchase transaction: all three are there...
        inside = {
          orders: await tx.order.count({ where: { quoteId } }),
          debits: await tx.ledgerEntry.count({ where: { userId, kind: 'PURCHASE' } }),
          usedAt: (await tx.quote.findUniqueOrThrow({ where: { id: quoteId } })).usedAt,
        };
        throw new Error('broken right after usedAt');
      });
      const key = newKey();
      const res = await t.order(user, quote.id, { key });

      // ...and one failure took all three back.
      expect([res.status, res.body.error?.code]).toEqual([500, 'INTERNAL_ERROR']);
      expect(inside).toMatchObject({ orders: 1, debits: 1 });
      expect(inside?.usedAt).toBeInstanceOf(Date);
      const db = t.db();
      expect(await db.order.count({ where: { quoteId: quote.id } })).toBe(0);
      expect(await db.ledgerEntry.count({ where: { userId: user.id, kind: 'PURCHASE' } })).toBe(0);
      expect((await db.quote.findUniqueOrThrow({ where: { id: quote.id } })).usedAt).toBeNull();

      // The client's retry (same key) then buys it exactly once.
      jest.restoreAllMocks();
      const retry = await t.order(user, quote.id, { key });
      expect(retry.status).toBe(201);
      expect(await db.ledgerEntry.count({ where: { userId: user.id, kind: 'PURCHASE' } })).toBe(1);
    });

    it('a failed debit leaves no order and an unused quote', async () => {
      const user = await t.newUser();
      await t.fund(user.id, 1_000_000n);
      const quote = await t.quote(user.id);
      const repo = t.app().get(OrdersRepository);
      jest.spyOn(repo, 'appendPurchase').mockRejectedValue(new Error('ledger down'));
      const res = await t.order(user, quote.id);
      expect(res.status).toBe(500);
      const db = t.db();
      expect(await db.order.count({ where: { quoteId: quote.id } })).toBe(0);
      expect((await db.quote.findUniqueOrThrow({ where: { id: quote.id } })).usedAt).toBeNull();
    });
  });
});
