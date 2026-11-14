import { pinChain } from '../../ton/__tests__/ton-e2e.harness';
import { FulfillOrderProcessor } from '../fulfill-order.processor';
import {
  PRICE_TIYIN,
  attemptsOf,
  ledgerOf,
  orderRow,
  timelineOf,
  transfersOf,
} from './fulfill-e2e.fixtures';
import { GrantingLockStore, useFulfillE2e } from './fulfill-e2e.harness';

// The fulfill-order run end to end on real Postgres + Redis (dry run): PAID -> QUEUED ->
// PROCESSING -> DELIVERED, a wrong-state job is a no-op, a replayed or parallel job never pays
// twice, a recipient that is gone or changed is FAILED + REFUNDED, and the end-of-run re-check
// re-queues an order that is still QUEUED.

const t = useFulfillE2e();
const run = (orderId: string, final = false) =>
  t.main.service.run(orderId, { finalAttempt: final });

describe('fulfill-order: the dry-run flow', () => {
  it('a TON-paid order: PAID -> QUEUED -> PROCESSING -> DELIVERED, one payout, the customer hears', async () => {
    pinChain(t.gateway, 0);
    const fixture = await t.order();
    await expect(run(fixture.orderId)).resolves.toBe('DONE');
    const order = await orderRow(t.db, fixture.orderId);
    expect(order.status).toBe('DELIVERED');
    expect(order.deliveredAt).not.toBeNull();
    // The fixture inserts the PAID order directly (POST /orders writes its own PAID event).
    expect(await timelineOf(t.db, fixture.orderId)).toEqual(['QUEUED', 'PROCESSING', 'DELIVERED']);
    const [attempt] = await attemptsOf(t.db, fixture.orderId);
    expect(attempt).toEqual(
      expect.objectContaining({ attemptNo: 1, adapter: 'FRAGMENT', status: 'CONFIRMED' }),
    );
    expect(attempt?.externalRef).toEqual(expect.any(String));
    expect(t.executedOnChain()).toBe(1);
    expect(await t.hasJob({ kind: 'ORDER_DELIVERED', refId: fixture.orderId })).toBe(true);
  });

  it('a supplier-paid order: SENT, confirmed, DELIVERED with the attempt CONFIRMED (one transaction)', async () => {
    const fixture = await t.order({ adapter: 'RESELLER_STARS' });
    await expect(run(fixture.orderId)).resolves.toBe('DONE');
    expect((await orderRow(t.db, fixture.orderId)).status).toBe('DELIVERED');
    expect(await attemptsOf(t.db, fixture.orderId)).toEqual([
      expect.objectContaining({ status: 'CONFIRMED', externalRef: `sim-${fixture.orderId}` }),
    ]);
    expect(await t.hasJob({ kind: 'ORDER_DELIVERED', refId: fixture.orderId })).toBe(true);
  });

  it('a replayed job of a delivered order pays nothing; a missing order is a no-op', async () => {
    pinChain(t.gateway, 0);
    const fixture = await t.order();
    await run(fixture.orderId);
    await expect(run(fixture.orderId)).resolves.toBe('REPLAYED');
    await expect(run(fixture.orderId, true)).resolves.toBe('REPLAYED');
    expect(await transfersOf(t.db, fixture.orderId)).toHaveLength(1);
    expect(t.executedOnChain()).toBe(1);
    await expect(run('cl0000000000000000missing')).resolves.toBe('MISSING');
  });

  it('two workers run the same order at once: one payout (order lock)', async () => {
    pinChain(t.gateway, 0);
    const fixture = await t.order();
    const other = await t.boot();
    const results = await Promise.allSettled([
      run(fixture.orderId),
      other.service.run(fixture.orderId, { finalAttempt: false }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await orderRow(t.db, fixture.orderId)).status).toBe('DELIVERED');
    expect(await transfersOf(t.db, fixture.orderId)).toHaveLength(1);
    expect(t.executedOnChain()).toBe(1);
  });

  it('two workers without the Redis lock: the database fence still allows one payout', async () => {
    pinChain(t.gateway, 0);
    const fixture = await t.order();
    const a = await t.boot({ lockStore: new GrantingLockStore() });
    const b = await t.boot({ lockStore: new GrantingLockStore() });
    await Promise.allSettled([
      a.service.run(fixture.orderId, { finalAttempt: false }),
      b.service.run(fixture.orderId, { finalAttempt: false }),
    ]);
    // A loser may stop half-way (its job retries); the retry only follows the one attempt.
    await a.service.run(fixture.orderId, { finalAttempt: false });
    expect((await orderRow(t.db, fixture.orderId)).status).toBe('DELIVERED');
    expect(await attemptsOf(t.db, fixture.orderId)).toHaveLength(1);
    expect(await transfersOf(t.db, fixture.orderId)).toHaveLength(1);
    expect(t.executedOnChain()).toBe(1);
  });
});

describe('fulfill-order: a recipient that cannot be re-checked is failed and refunded', () => {
  it.each([
    ['changed', 'sim_somebody_else', 'RECIPIENT_CHANGED'],
    ['missing', null, 'RECIPIENT_GONE'],
    ['blank', '   ', 'RECIPIENT_GONE'],
  ] as const)(
    'providerRef %s: FAILED + REFUND + REFUNDED, nothing sent',
    async (_, ref, reason) => {
      const fixture = await t.order({ providerRef: ref });
      await expect(run(fixture.orderId)).resolves.toBe('DONE');
      expect(await orderRow(t.db, fixture.orderId)).toEqual(
        expect.objectContaining({ status: 'REFUNDED', statusReason: reason }),
      );
      expect(await timelineOf(t.db, fixture.orderId)).toEqual(
        expect.arrayContaining(['PROCESSING', 'FAILED', 'REFUNDED']),
      );
      const ledger = await ledgerOf(t.db, fixture.orderId);
      expect(ledger).toEqual(
        expect.arrayContaining([
          { kind: 'PURCHASE', amountTiyin: -PRICE_TIYIN },
          { kind: 'REFUND', amountTiyin: PRICE_TIYIN },
        ]),
      );
      expect(await attemptsOf(t.db, fixture.orderId)).toHaveLength(0);
      expect(await t.hasJob({ kind: 'ORDER_REFUNDED', refId: fixture.orderId })).toBe(true);
      // A replay refunds nothing twice.
      await expect(run(fixture.orderId)).resolves.toBe('REPLAYED');
      expect(await ledgerOf(t.db, fixture.orderId)).toHaveLength(2);
    },
  );
});

describe('fulfill-order: the end-of-run re-check (docs/06 safeguard 1)', () => {
  it('an order still QUEUED after the job finished is enqueued again; any other state is not', async () => {
    const queued = await t.order();
    await t.db.order.update({ where: { id: queued.orderId }, data: { status: 'QUEUED' } });
    const done = await t.order({ providerRef: null });
    await run(done.orderId);
    const processor = new FulfillOrderProcessor(t.main.service, t.main.enqueuer);
    const job = (orderId: string) => ({
      id: orderId,
      data: { orderId },
      attemptsMade: 0,
      opts: {},
    });

    await processor.requeueIfQueued(job(queued.orderId));
    await processor.requeueIfQueued(job(done.orderId));
    expect(await (await t.fulfillQueue.getJob(queued.orderId))?.getState()).toBe('waiting');
    expect(await t.fulfillQueue.getJob(done.orderId)).toBeUndefined();
    // A second re-check keeps the waiting job (decideEnqueue: keep), never a second one.
    const first = await t.fulfillQueue.getJob(queued.orderId);
    await processor.requeueIfQueued(job(queued.orderId));
    const again = await t.fulfillQueue.getJob(queued.orderId);
    expect(again?.timestamp).toBe(first?.timestamp);
    await (await t.fulfillQueue.getJob(queued.orderId))?.remove();
  });
});
