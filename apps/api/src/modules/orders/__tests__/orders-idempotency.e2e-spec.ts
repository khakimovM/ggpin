import { CreateOrderResponseSchema, QuoteAlreadyUsedDetailsSchema } from '@repo/shared';
import { newKey, useOrdersE2e, type Res } from './orders-e2e.helpers';

const orderIdOf = (res: Res): string => CreateOrderResponseSchema.parse(res.body.data).order.id;

describe('POST /orders (e2e): idempotency (D-49)', () => {
  const t = useOrdersE2e();

  const debits = (userId: string) =>
    t.db().ledgerEntry.count({ where: { userId, kind: 'PURCHASE' } });

  it('the same key and body again: the same order with 201, one debit', async () => {
    const user = await t.newUser();
    await t.fund(user.id, 1_000_000n);
    const quote = await t.quote(user.id);
    const key = newKey();
    const first = await t.order(user, quote.id, { key });
    const again = await t.order(user, quote.id, { key });
    expect([first.status, again.status]).toEqual([201, 201]);
    expect(orderIdOf(again)).toBe(orderIdOf(first));
    expect(again.body.data).toEqual(first.body.data);
    expect(await debits(user.id)).toBe(1);
    expect((await t.get('/me/wallet', user)).body.data).toMatchObject({ balanceTiyin: '450000' });
  });

  it('a replay after the quote expired is still the 201: before the 410 and the 409', async () => {
    const user = await t.newUser();
    await t.fund(user.id, 1_000_000n);
    const quote = await t.quote(user.id);
    const key = newKey();
    const first = await t.order(user, quote.id, { key });
    expect(first.status).toBe(201);

    t.setNow(new Date(quote.expiresAt.getTime() + 60_000));
    const replay = await t.order(user, quote.id, { key });
    expect(replay.status).toBe(201);
    expect(orderIdOf(replay)).toBe(orderIdOf(first));
    // Another key for that quote is not a replay: "used" (409) is answered before "expired".
    const other = await t.order(user, quote.id);
    expect([other.status, other.body.error?.details]).toEqual([409, { orderId: orderIdOf(first) }]);
    expect(await debits(user.id)).toBe(1);
  });

  it('the same key with another quote: 409 IDEMPOTENCY_CONFLICT, the second quote untouched', async () => {
    const user = await t.newUser();
    await t.fund(user.id, 2_000_000n);
    const [q1, q2] = [await t.quote(user.id), await t.quote(user.id)];
    const key = newKey();
    expect((await t.order(user, q1.id, { key })).status).toBe(201);
    const conflict = await t.order(user, q2.id, { key });
    expect([conflict.status, conflict.body.error?.code]).toEqual([409, 'IDEMPOTENCY_CONFLICT']);
    expect(conflict.body.error?.details).toBeUndefined();
    expect((await t.db().quote.findUniqueOrThrow({ where: { id: q2.id } })).usedAt).toBeNull();
    expect(await debits(user.id)).toBe(1);
  });

  it('a used quote under another key: 409 QUOTE_ALREADY_USED naming the caller’s own order', async () => {
    const user = await t.newUser();
    await t.fund(user.id, 2_000_000n);
    const quote = await t.quote(user.id);
    const first = await t.order(user, quote.id);
    const second = await t.order(user, quote.id);
    expect([second.status, second.body.error?.code]).toEqual([409, 'QUOTE_ALREADY_USED']);
    expect(QuoteAlreadyUsedDetailsSchema.parse(second.body.error?.details)).toEqual({
      orderId: orderIdOf(first),
    });
    expect(await debits(user.id)).toBe(1);
  });

  it('keys are per user: two users may use the same key for their own quotes', async () => {
    const [a, b] = [await t.newUser(), await t.newUser()];
    await t.fund(a.id, 1_000_000n);
    await t.fund(b.id, 1_000_000n);
    const key = newKey();
    const resA = await t.order(a, (await t.quote(a.id)).id, { key });
    const resB = await t.order(b, (await t.quote(b.id)).id, { key });
    expect([resA.status, resB.status]).toEqual([201, 201]);
    expect(orderIdOf(resA)).not.toBe(orderIdOf(resB));
  });

  describe('cookie session (web)', () => {
    it('with X-CSRF-Token and Origin: 201', async () => {
      const user = await t.newUser();
      await t.fund(user.id, 1_000_000n);
      const res = await t.order(user, (await t.quote(user.id)).id, { auth: 'cookie+csrf' });
      expect(res.status).toBe(201);
    });

    it('without the CSRF token: 404 (D-26) and nothing written', async () => {
      const user = await t.newUser();
      await t.fund(user.id, 1_000_000n);
      const quote = await t.quote(user.id);
      const res = await t.order(user, quote.id, { auth: 'cookie' });
      expect([res.status, res.body.error?.code]).toEqual([404, 'NOT_FOUND']);
      expect(await t.db().order.count({ where: { userId: user.id } })).toBe(0);
      expect((await t.db().quote.findUniqueOrThrow({ where: { id: quote.id } })).usedAt).toBeNull();
    });
  });
});
