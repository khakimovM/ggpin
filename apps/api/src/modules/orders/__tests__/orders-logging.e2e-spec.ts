import type { Quote } from '@repo/db';
import { CaptureStream } from '../../../common/logging/__tests__/capture-stream';
import { FulfillOrderEnqueuer } from '../../../infra/queue/fulfill-order-enqueuer';
import { orderRequestHash } from '../order-request-hash';
import { OrdersRepository } from '../orders.repository';
import { COST_NANO, MAX_COST_NANO, insertDiscountCode } from './orders-e2e.fixtures';
import { newKey, useOrdersE2e, type Res } from './orders-e2e.helpers';

const count = (text: string, needle: string): number => text.split(needle).length - 1;

// One app for the file: nestjs-pino keeps a process-wide root logger, so the capture stream is
// fixed when the app is built. Every path that logs is driven through the real pipeline (request
// logger, error filter, pino serializers): the internals of a quote never reach the output.
describe('orders: providerRef, cost, ceiling, FX and snapshot ids never reach the logs', () => {
  const logs = new CaptureStream();
  const t = useOrdersE2e({ logs });

  it('a purchase, a 422, a discount-code 500, a database refusal and a failed enqueue', async () => {
    logs.clear();
    const user = await t.newUser();
    await t.fund(user.id, 1_000_000n);
    const quotes: Quote[] = [];
    const buy = async (quote: Quote): Promise<Res> => {
      quotes.push(quote);
      return t.order(user, quote.id);
    };

    expect((await buy(await t.quote(user.id))).status).toBe(201);
    // 450 000 left: the next one is refused with the balance in `details`.
    expect((await buy(await t.quote(user.id))).status).toBe(422);
    const codeId = await insertDiscountCode(t.db(), user.id);
    expect((await buy(await t.quote(user.id, { discountCodeId: codeId }))).status).toBe(500);

    // A quote row that no longer matches what the database holds: the Order guard refuses the
    // INSERT and the driver error goes through the error filter (the riskiest log line).
    await t.fund(user.id, 1_000_000n);
    const repo = t.app().get(OrdersRepository);
    const realFind = repo.findOwnQuote.bind(repo);
    const tamper = jest
      .spyOn(repo, 'findOwnQuote')
      .mockImplementation(async (tx, userId, quoteId) => {
        const row = await realFind(tx, userId, quoteId);
        return row === null ? null : { ...row, priceTiyin: row.priceTiyin + 1n };
      });
    expect((await buy(await t.quote(user.id))).status).toBe(500);
    tamper.mockRestore();

    jest
      .spyOn(t.app().get(FulfillOrderEnqueuer), 'enqueue')
      .mockRejectedValue(new Error('queue down'));
    const late = await buy(await t.quote(user.id));
    expect(late.status).toBe(201);

    // The access line is written after the response: wait for all five.
    for (let i = 0; i < 100 && count(logs.text(), 'request completed') < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const output = logs.text();
    expect(count(output, 'request completed')).toBe(5);
    expect(count(output, '"msg":"request failed"')).toBe(2);
    expect(output).toContain('must equal its quote');
    expect(output).toContain('carries a discount code');
    expect(output).toContain('fulfill-order job for order');
    expect(() => logs.records()).not.toThrow();

    const { fxRateId, costSnapshotId } = t.catalog();
    const internals = [String(COST_NANO), String(MAX_COST_NANO), fxRateId, costSnapshotId];
    for (const quote of quotes) internals.push(quote.providerRef ?? 'providerRef');
    expect(quotes).toHaveLength(5);
    for (const internal of internals) expect(output).not.toContain(internal);
  });

  // Audit L3 / review N4: a Prisma validation error renders the call's whole `data` (recipient,
  // providerRef, cost, key) into its message and stack, and a Postgres CHECK failure puts the failing
  // row into `detail`. The err serializer rebuilds both from an allowlist.
  it('a Prisma validation error and a CHECK failure (23514) log what failed, never the data', async () => {
    logs.clear();
    const user = await t.newUser();
    await t.fund(user.id, 2_000_000n);
    const recipient = { username: 'logneedle_user7', displayName: 'ZebraLogName' };
    const providerRef = 'prov-ref-LOGNEEDLE-91';
    const keys = [newKey(), newKey()];
    const repo = t.app().get(OrdersRepository);
    const realFind = repo.findOwnQuote.bind(repo);
    const realCreate = repo.createPaid.bind(repo);

    // A value of the wrong type reaches Prisma (PrismaClientValidationError).
    const fifty = jest
      .spyOn(repo, 'findOwnQuote')
      .mockImplementation(async (tx, userId, quoteId) => {
        const row = await realFind(tx, userId, quoteId);
        return row === null ? null : { ...row, quantity: 'fifty' as unknown as number };
      });
    const first = await t.quote(user.id, { recipient, providerRef });
    expect((await t.order(user, first.id, { key: keys[0] })).status).toBe(500);
    fifty.mockRestore();

    // A discount above the price passes the INSERT guard (the quote carries a code) and fails
    // Order_discount_check: Postgres puts the whole failing row into `detail`.
    const discountCodeId = await insertDiscountCode(t.db(), user.id);
    const second = await t.quote(user.id, { recipient, providerRef, discountCodeId });
    jest.spyOn(repo, 'findOwnQuote').mockImplementation(async (tx, userId, quoteId) => {
      const row = await realFind(tx, userId, quoteId);
      return row === null ? null : { ...row, discountCodeId: null };
    });
    jest
      .spyOn(repo, 'createPaid')
      .mockImplementation((tx, input) =>
        realCreate(tx, { ...input, discountTiyin: input.quote.priceTiyin + 1n }),
      );
    expect((await t.order(user, second.id, { key: keys[1] })).status).toBe(500);

    for (let i = 0; i < 100 && count(logs.text(), 'request completed') < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const output = logs.text();
    expect(count(output, '"msg":"request failed"')).toBe(2);
    expect(output).toContain('PrismaClientValidationError');
    expect(output).toContain('Order_discount_check');
    expect(output).not.toContain('Failing row');
    const needles = [
      recipient.username,
      recipient.displayName,
      providerRef,
      String(COST_NANO),
      String(MAX_COST_NANO),
      t.catalog().fxRateId,
      ...keys,
      orderRequestHash({ quoteId: first.id }),
      orderRequestHash({ quoteId: second.id }),
    ];
    for (const needle of needles) expect(output).not.toContain(needle);
  });
});
