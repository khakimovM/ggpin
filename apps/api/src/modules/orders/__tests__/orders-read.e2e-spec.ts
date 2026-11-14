import { Logger } from '@nestjs/common';
import { failAndRefundOrder, transitionOrder } from '@repo/db';
import {
  CreateOrderResponseSchema,
  LIST_DEFAULT_LIMIT,
  OrderDetailSchema,
  OrderSchema,
  RECIPIENT_PLACEHOLDER,
  type OrderDto,
} from '@repo/shared';
import { insertPaidOrder } from './orders-e2e.fixtures';
import {
  INTERNAL_KEY,
  keysOf,
  newKey,
  useOrdersE2e,
  type Res,
  type TestUser,
} from './orders-e2e.helpers';

const listOf = (res: Res): OrderDto[] => OrderSchema.array().parse(res.body.data);
const idsOf = (res: Res): string[] => listOf(res).map((order) => order.id);

// GET /orders and GET /orders/:id read only the caller's rows. The orders are bought through
// POST /orders and moved on with the @repo/db helpers the worker uses.
describe('GET /orders, GET /orders/:id (e2e)', () => {
  const t = useOrdersE2e();
  let owner: TestUser;
  let stranger: TestUser;
  // Bought in this order, so newest first is [paid, queued, refunded].
  let refunded: string;
  let queued: string;
  let paid: string;
  let foreign: string;

  const buy = async (user: TestUser): Promise<string> => {
    const res = await t.order(user, (await t.quote(user.id)).id);
    if (res.status !== 201) throw new Error(`purchase answered ${String(res.status)}`);
    return CreateOrderResponseSchema.parse(res.body.data).order.id;
  };

  beforeAll(async () => {
    owner = await t.newUser();
    stranger = await t.newUser();
    await t.fund(owner.id, 2_000_000n);
    await t.fund(stranger.id, 1_000_000n);
    refunded = await buy(owner);
    queued = await buy(owner);
    paid = await buy(owner);
    foreign = await buy(stranger);
    const db = t.db();
    const move = (orderId: string, from: 'PAID' | 'QUEUED', to: 'QUEUED' | 'PROCESSING') =>
      db.$transaction((tx) => transitionOrder(tx, { orderId, from, to, actor: 'system' }));
    await move(queued, 'PAID', 'QUEUED');
    // One transaction per step, like the worker...
    await move(refunded, 'PAID', 'QUEUED');
    await move(refunded, 'QUEUED', 'PROCESSING');
    // ...and FAILED + REFUNDED together, in one transaction (the failure and its refund).
    await db.$transaction((tx) =>
      failAndRefundOrder(tx, {
        orderId: refunded,
        from: 'PROCESSING',
        reason: 'RECIPIENT_GONE',
        actor: 'system',
      }),
    );
  });

  describe('GET /orders', () => {
    it('the caller’s orders, newest first, with page meta and no-store', async () => {
      const res = await t.get('/orders', owner);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(listOf(res).map((order) => [order.id, order.status])).toEqual([
        [paid, 'PAID'],
        [queued, 'QUEUED'],
        [refunded, 'REFUNDED'],
      ]);
      expect(res.body.meta).toEqual({ page: 1, limit: LIST_DEFAULT_LIMIT, total: 3 });
    });

    it('never another user’s order, in either direction', async () => {
      const res = await t.get('/orders', stranger);
      expect(idsOf(res)).toEqual([foreign]);
      expect(res.body.meta).toMatchObject({ total: 1 });
      expect(idsOf(await t.get('/orders', owner))).not.toContain(foreign);
    });

    it('status=PAID,QUEUED is one label group; a single status also works', async () => {
      const group = await t.get('/orders?status=PAID,QUEUED', owner);
      expect(idsOf(group)).toEqual([paid, queued]);
      expect(group.body.meta).toMatchObject({ total: 2 });
      const one = await t.get('/orders?status=REFUNDED', owner);
      expect(idsOf(one)).toEqual([refunded]);
      expect(one.body.meta).toMatchObject({ total: 1 });
      expect(idsOf(await t.get('/orders?status=DELIVERED', owner))).toEqual([]);
    });

    it('pages: limit and page pick the slice, total counts all', async () => {
      const res = await t.get('/orders?limit=1&page=2', owner);
      expect(idsOf(res)).toEqual([queued]);
      expect(res.body.meta).toEqual({ page: 2, limit: 1, total: 3 });
      expect(idsOf(await t.get('/orders?limit=100', owner))).toHaveLength(3);
      expect(idsOf(await t.get('/orders?limit=2&page=3', owner))).toEqual([]);
    });

    it('productName follows ?locale (uz by default)', async () => {
      const { nameUz, nameRu } = t.catalog();
      const names = (res: Res) => [...new Set(listOf(res).map((order) => order.productName))];
      expect(names(await t.get('/orders', owner))).toEqual([nameUz]);
      expect(names(await t.get('/orders?locale=uz', owner))).toEqual([nameUz]);
      expect(names(await t.get('/orders?locale=ru', owner))).toEqual([nameRu]);
    });

    it.each([
      ['limit above 100', 'limit=101'],
      ['limit 0', 'limit=0'],
      ['an unknown status', 'status=SHIPPED'],
      ['an empty status', 'status='],
      ['a lowercase status', 'status=paid'],
      ['an unknown parameter', 'userId=someone'],
      ['an unknown locale', 'locale=en'],
    ])('400 VALIDATION_ERROR for %s', async (_name, query) => {
      const res = await t.get(`/orders?${query}`, owner);
      expect([res.status, res.body.error?.code]).toEqual([400, 'VALIDATION_ERROR']);
    });

    it('a web cookie session reads without the CSRF header (a GET changes nothing)', async () => {
      const res = await t.get('/orders', owner, 'cookie');
      expect(res.status).toBe(200);
      expect(idsOf(res)).toEqual([paid, queued, refunded]);
    });

    it('401 without a session', async () => {
      const res = await t.get('/orders', null);
      expect([res.status, res.body.error?.code]).toEqual([401, 'UNAUTHORIZED']);
    });
  });

  describe('GET /orders/:id', () => {
    it('the order with its timeline, oldest first, the failure before its refund', async () => {
      const res = await t.get(`/orders/${refunded}`, owner);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const { timeline, voucher, ...order } = OrderDetailSchema.parse(res.body.data);
      expect(timeline.map((item) => item.status)).toEqual([
        'PAID',
        'QUEUED',
        'PROCESSING',
        'FAILED',
        'REFUNDED',
      ]);
      const times = timeline.map((item) => Date.parse(item.at));
      expect(times).toEqual([...times].sort((a, b) => a - b));
      expect(voucher).toBeNull();
      // The detail is the list item plus timeline and voucher.
      const listed = listOf(await t.get('/orders', owner)).find((item) => item.id === refunded);
      expect(order).toEqual(listed);
    });

    it('a fresh purchase has one step; ?locale=ru names the product in Russian', async () => {
      const res = await t.get(`/orders/${paid}?locale=ru`, owner);
      const detail = OrderDetailSchema.parse(res.body.data);
      expect(detail.timeline.map((item) => item.status)).toEqual(['PAID']);
      expect(detail.productName).toBe(t.catalog().nameRu);
    });

    it('carries no reason, actor, note, providerRef, cost, FX or snapshot id', async () => {
      const row = await t.db().order.findUniqueOrThrow({ where: { id: refunded } });
      expect(row.statusReason).toBe('RECIPIENT_GONE');
      for (const res of [
        await t.get(`/orders/${refunded}`, owner),
        await t.get('/orders', owner),
      ]) {
        const text = JSON.stringify(res.body);
        const internals = [
          row.providerRef ?? 'providerRef',
          row.fxRateId,
          String(row.costMinor),
          String(row.maxCostMinor),
          t.catalog().costSnapshotId,
          'RECIPIENT_GONE',
          'SYSTEM',
        ];
        for (const internal of internals) expect(text).not.toContain(internal);
        expect(keysOf(res.body).filter((key) => INTERNAL_KEY.test(key))).toEqual([]);
      }
    });

    it('404 for another user’s order, both ways, the same as an id that does not exist', async () => {
      for (const res of [
        await t.get(`/orders/${foreign}`, owner),
        await t.get(`/orders/${paid}`, stranger),
        await t.get('/orders/nosuchorder00000000000', owner),
      ]) {
        expect([res.status, res.body.error?.code]).toEqual([404, 'NOT_FOUND']);
        expect(res.body.error?.details).toBeUndefined();
      }
    });

    it.each([
      ['a malformed id', 'bad.id', ''],
      ['an unknown parameter', 'ORDER', '?status=PAID'],
      ['an unknown locale', 'ORDER', '?locale=en'],
    ])('400 VALIDATION_ERROR for %s', async (_name, id, query) => {
      const res = await t.get(`/orders/${id === 'ORDER' ? paid : id}${query}`, owner);
      expect([res.status, res.body.error?.code]).toEqual([400, 'VALIDATION_ERROR']);
    });

    it('401 without a session', async () => {
      const res = await t.get(`/orders/${paid}`, null);
      expect([res.status, res.body.error?.code]).toEqual([401, 'UNAUTHORIZED']);
    });
  });

  // Review M2 / audit I6: a stored recipient is read leniently, so a row of an older input rule,
  // or a broken one, never turns the purchase answer, a replay, the list or the order into a 500.
  describe('a stored recipient of another shape (written straight to the database)', () => {
    // `{ playerId }` stands for a shape this phase does not know yet (a game's player id moves into
    // `fields` in phase 11). A Telegram quote without a username is refused (review M3), so that
    // order is written straight to the database; reading it must still answer.
    it('a shape not known yet (moves into fields in phase 11): listed and opened with the placeholder', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const user = await t.newUser();
      await t.fund(user.id, 2_000_000n);
      const older = { username: 'old-name.1', displayName: 'Eski', v: 1 };
      const oldQuote = await t.quote(user.id, { recipient: older });
      const brokenQuote = await t.quote(user.id, { recipient: { playerId: '5551234' } });
      const key = newKey();
      const first = await t.order(user, oldQuote.id, { key });
      expect(first.status).toBe(201);
      const refused = await t.order(user, brokenQuote.id);
      expect([refused.status, refused.body.error?.code]).toEqual([410, 'QUOTE_EXPIRED']);
      expect(await t.db().order.count({ where: { quoteId: brokenQuote.id } })).toBe(0);
      const oldId = CreateOrderResponseSchema.parse(first.body.data).order.id;
      const brokenId = (await insertPaidOrder(t.db(), brokenQuote)).orderId;

      expect((await t.order(user, oldQuote.id, { key })).status).toBe(201);
      const list = await t.get('/orders', user);
      expect(list.status).toBe(200);
      const placeholder = { displayName: RECIPIENT_PLACEHOLDER, fields: {} };
      expect(listOf(list).map((order) => [order.id, order.recipient])).toEqual([
        [brokenId, placeholder],
        [oldId, { displayName: 'Eski', fields: { username: 'old-name.1' } }],
      ]);
      const detail = await t.get(`/orders/${brokenId}`, user);
      expect(detail.status).toBe(200);
      expect(OrderDetailSchema.parse(detail.body.data).recipient).toEqual(placeholder);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`order ${brokenId}`));
      expect(JSON.stringify(warn.mock.calls)).not.toContain('5551234');
    });
  });
});
