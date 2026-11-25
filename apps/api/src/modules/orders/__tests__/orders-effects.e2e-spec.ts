import { Logger } from '@nestjs/common';
import { transitionOrder } from '@repo/db';
import { CreateOrderResponseSchema, QUEUES } from '@repo/shared';
import {
  FulfillOrderEnqueuer,
  type EnqueueResult,
} from '../../../infra/queue/fulfill-order-enqueuer';
import { OrderNotifyProducer } from '../../notifications/order-notify.producer';
import { EFFECT_TIMEOUT_MS } from '../order-effects';
import { newKey, useOrdersE2e, type Res } from './orders-e2e.helpers';

const orderIdOf = (res: Res): string => CreateOrderResponseSchema.parse(res.body.data).order.id;

// The money is committed before the jobs are queued (plan 6.1 step 3): a queue failure must never
// turn the 201 into an error, and a replay while the order is still PAID queues it again.
describe('POST /orders (e2e): after the commit', () => {
  const t = useOrdersE2e();

  const fulfillJob = (orderId: string) => t.queue(QUEUES.FULFILL_ORDER).getJob(orderId);
  const notice = (orderId: string) => t.queue(QUEUES.NOTIFY).getJob(`order-${orderId}-accepted`);
  const statusOf = async (orderId: string) =>
    (await t.db().order.findUniqueOrThrow({ where: { id: orderId } })).status;
  const quietErrors = () =>
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

  it('fulfill-order cannot be queued: still 201, the order stays PAID, the failure is logged by id', async () => {
    const errors = quietErrors();
    jest
      .spyOn(t.app().get(FulfillOrderEnqueuer), 'enqueue')
      .mockRejectedValue(new Error('connect ECONNREFUSED redis://:hunter2@10.0.0.9:6379'));
    const user = await t.newUser();
    await t.fund(user.id, 600_000n);
    const res = await t.order(user, (await t.quote(user.id)).id);

    expect(res.status).toBe(201);
    const orderId = orderIdOf(res);
    expect(await statusOf(orderId)).toBe('PAID');
    expect(await fulfillJob(orderId)).toBeUndefined();
    expect(await notice(orderId)).toBeDefined();
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining(`fulfill-order job for order ${orderId} not queued`),
    );
    expect(JSON.stringify(errors.mock.calls)).not.toContain('hunter2');
    expect((await t.get('/me/wallet', user)).body.data).toMatchObject({ balanceTiyin: '50000' });
  });

  it('an enqueue that never answers: the 201 still comes within the bound (review M3)', async () => {
    const errors = quietErrors();
    jest
      .spyOn(t.app().get(FulfillOrderEnqueuer), 'enqueue')
      .mockReturnValue(new Promise<EnqueueResult>(() => undefined));
    const user = await t.newUser();
    await t.fund(user.id, 600_000n);
    const quote = await t.quote(user.id);

    const started = Date.now();
    const res = await t.order(user, quote.id);
    const elapsed = Date.now() - started;

    expect(res.status).toBe(201);
    // Held by the bound, not by the stuck enqueue (the purchase itself takes milliseconds).
    expect(elapsed).toBeGreaterThanOrEqual(EFFECT_TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(EFFECT_TIMEOUT_MS + 2_000);
    const orderId = orderIdOf(res);
    expect(await statusOf(orderId)).toBe('PAID');
    expect(await notice(orderId)).toBeDefined();
    expect(errors).toHaveBeenCalledWith(
      `fulfill-order job for order ${orderId} not queued (timeout)`,
    );
  });

  it('the ORDER_ACCEPTED notice cannot be queued: still 201, fulfillment is queued', async () => {
    const errors = quietErrors();
    jest
      .spyOn(t.app().get(OrderNotifyProducer), 'enqueue')
      .mockRejectedValue(new Error('notify queue down'));
    const user = await t.newUser();
    await t.fund(user.id, 600_000n);
    const res = await t.order(user, (await t.quote(user.id)).id);

    expect(res.status).toBe(201);
    const orderId = orderIdOf(res);
    expect(await fulfillJob(orderId)).toBeDefined();
    expect(await notice(orderId)).toBeUndefined();
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining(`ORDER_ACCEPTED notice for order ${orderId} not queued`),
    );
  });

  it('a replay while the order is still PAID queues what the first answer could not', async () => {
    quietErrors();
    const enqueue = jest
      .spyOn(t.app().get(FulfillOrderEnqueuer), 'enqueue')
      .mockRejectedValueOnce(new Error('queue down'));
    const user = await t.newUser();
    await t.fund(user.id, 600_000n);
    const quote = await t.quote(user.id);
    const key = newKey();
    const first = await t.order(user, quote.id, { key });
    const orderId = orderIdOf(first);
    expect(await fulfillJob(orderId)).toBeUndefined();

    const replay = await t.order(user, quote.id, { key });
    expect([replay.status, orderIdOf(replay)]).toEqual([201, orderId]);
    expect(enqueue).toHaveBeenCalledTimes(2);
    const job = await fulfillJob(orderId);
    expect([job?.name, job?.data]).toEqual(['fulfill', { orderId }]);
    expect(await t.db().ledgerEntry.count({ where: { userId: user.id, kind: 'PURCHASE' } })).toBe(
      1,
    );
  });

  it('a replay of an order that has moved on (QUEUED) answers it and queues nothing again', async () => {
    const user = await t.newUser();
    await t.fund(user.id, 600_000n);
    const quote = await t.quote(user.id);
    const key = newKey();
    const orderId = orderIdOf(await t.order(user, quote.id, { key }));
    await t
      .db()
      .$transaction((tx) =>
        transitionOrder(tx, { orderId, from: 'PAID', to: 'QUEUED', actor: 'system' }),
      );
    const enqueue = jest.spyOn(t.app().get(FulfillOrderEnqueuer), 'enqueue');
    const notify = jest.spyOn(t.app().get(OrderNotifyProducer), 'enqueue');

    const replay = await t.order(user, quote.id, { key });
    expect(replay.status).toBe(201);
    expect(CreateOrderResponseSchema.parse(replay.body.data).order).toMatchObject({
      id: orderId,
      status: 'QUEUED',
    });
    expect(enqueue).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});
