import { CreateOrderResponseSchema } from '@repo/shared';
import { OrdersRepository } from '../orders.repository';
import { newKey, useOrdersE2e, type Res } from './orders-e2e.helpers';

const orderIdOf = (res: Res): string => CreateOrderResponseSchema.parse(res.body.data).order.id;

/**
 * Holds every arriving caller until `parties` have arrived. Never longer than 2 s: the callers
 * wait inside a Prisma interactive transaction, which times out after 5 s.
 */
function barrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const timer = setTimeout(() => {
    open();
  }, 2_000);
  return async () => {
    arrived += 1;
    if (arrived >= parties) {
      clearTimeout(timer);
      open();
    }
    await gate;
  };
}

// Real Postgres, real transactions: acceptance criterion 2 of the phase 5 plan.
describe('POST /orders (e2e): concurrent purchases', () => {
  const t = useOrdersE2e();

  const purchases = async (userId: string) => {
    const db = t.db();
    const [orders, debits, balance] = await Promise.all([
      db.order.count({ where: { userId } }),
      db.ledgerEntry.count({ where: { userId, kind: 'PURCHASE' } }),
      db.ledgerEntry.aggregate({ where: { userId }, _sum: { amountTiyin: true } }),
    ]);
    return { orders, debits, balance: balance._sum.amountTiyin ?? 0n };
  };

  // Acceptance criterion 2 (review M1): both requests are held until both stand at the wallet lock,
  // so they really ask for it at once; the REAL lock then makes one wait for the other's commit.
  const meetAtTheLock = (): void => {
    const repo = t.app().get(OrdersRepository);
    const realLock = repo.lockWallet.bind(repo);
    const arrive = barrier(2);
    jest.spyOn(repo, 'lockWallet').mockImplementation(async (tx, userId) => {
      await arrive();
      return realLock(tx, userId);
    });
  };

  it('two quotes, two keys, money for one, at once: [201, 422], one PURCHASE, balance >= 0', async () => {
    const user = await t.newUser();
    await t.fund(user.id, 600_000n);
    const [q1, q2] = [await t.quote(user.id), await t.quote(user.id)];
    meetAtTheLock();
    const results = await Promise.all([t.order(user, q1.id), t.order(user, q2.id)]);
    expect(results.map((res) => res.status).sort()).toEqual([201, 422]);
    const refused = results.find((res) => res.status === 422);
    expect(refused?.body.error?.details).toEqual({
      balance: '50000',
      required: '550000',
      shortfall: '500000',
    });
    expect(await purchases(user.id)).toEqual({ orders: 1, debits: 1, balance: 50_000n });
  });

  // The control of the test above: the same race with the lock switched off, both requests held
  // until both have read the balance, spends the money twice. So [201, 422] above is the lock's
  // doing, not the timing's. No database rule stands in for the lock: nothing refuses a negative
  // balance, and each order has its own PURCHASE entry (the D-60 check is met).
  // What it proves (review N9): the race really happens in this harness (both transactions read the
  // same balance before either writes), so the test above would catch a lost lock; and the wallet
  // lock is the ONLY thing between that race and a negative balance. What it does NOT prove: any
  // isolation level other than the READ COMMITTED default both tests run under, any race with more
  // than two requests, or the lock of the other money paths (top-up, refund), which have their own
  // tests. It is a test of the test, not a second guard.
  it('control: without the wallet lock the same race spends the money twice ([201, 201])', async () => {
    const user = await t.newUser();
    await t.fund(user.id, 600_000n);
    const [q1, q2] = [await t.quote(user.id), await t.quote(user.id)];
    const repo = t.app().get(OrdersRepository);
    jest.spyOn(repo, 'lockWallet').mockResolvedValue(undefined);
    const realBalance = repo.balance.bind(repo);
    const bothHaveRead = barrier(2);
    jest.spyOn(repo, 'balance').mockImplementation(async (tx, userId) => {
      const balance = await realBalance(tx, userId);
      await bothHaveRead();
      return balance;
    });
    const results = await Promise.all([t.order(user, q1.id), t.order(user, q2.id)]);
    expect(results.map((res) => res.status)).toEqual([201, 201]);
    expect(await purchases(user.id)).toEqual({ orders: 2, debits: 2, balance: -500_000n });
  });

  it('the same key and quote three times at once: all 201 with one order, one debit (D-49)', async () => {
    const user = await t.newUser();
    await t.fund(user.id, 600_000n);
    const quote = await t.quote(user.id);
    const key = newKey();
    const results = await Promise.all([1, 2, 3].map(() => t.order(user, quote.id, { key })));
    expect(results.map((res) => res.status)).toEqual([201, 201, 201]);
    expect(new Set(results.map(orderIdOf)).size).toBe(1);
    expect(await purchases(user.id)).toEqual({ orders: 1, debits: 1, balance: 50_000n });
  });

  it('one quote under two keys at once: one 201 and one 409 naming that order', async () => {
    const user = await t.newUser();
    await t.fund(user.id, 2_000_000n);
    const quote = await t.quote(user.id);
    const results = await Promise.all([t.order(user, quote.id), t.order(user, quote.id)]);
    expect(results.map((res) => res.status).sort()).toEqual([201, 409]);
    const won = results.find((res) => res.status === 201);
    const lost = results.find((res) => res.status === 409);
    expect(won).toBeDefined();
    expect(lost?.body.error).toMatchObject({
      code: 'QUOTE_ALREADY_USED',
      details: { orderId: won === undefined ? 'none' : orderIdOf(won) },
    });
    expect(await purchases(user.id)).toMatchObject({ orders: 1, debits: 1 });
  });

  it('purchases of different users do not wait for each other’s money', async () => {
    const [a, b] = [await t.newUser(), await t.newUser()];
    await t.fund(a.id, 600_000n);
    await t.fund(b.id, 600_000n);
    const results = await Promise.all([
      t.order(a, (await t.quote(a.id)).id),
      t.order(b, (await t.quote(b.id)).id),
    ]);
    expect(results.map((res) => res.status)).toEqual([201, 201]);
  });

  // The unique indexes are the backstop behind the lock (plan 6.1 step 4). With the lock switched
  // off and both requests held until each has passed its checks, they really collide on INSERT:
  // the loser's P2002 must still end in the D-49 answer, never in a second debit or a raw 500.
  describe('with the wallet lock switched off (unique indexes only)', () => {
    const collide = () => {
      const repo = t.app().get(OrdersRepository);
      jest.spyOn(repo, 'lockWallet').mockResolvedValue(undefined);
      const realBalance = repo.balance.bind(repo);
      const arrive = barrier(2);
      jest.spyOn(repo, 'balance').mockImplementation(async (tx, userId) => {
        await arrive();
        return realBalance(tx, userId);
      });
      const realCreate = repo.createPaid.bind(repo);
      const insertErrors: unknown[] = [];
      jest.spyOn(repo, 'createPaid').mockImplementation(async (tx, input) => {
        try {
          return await realCreate(tx, input);
        } catch (error) {
          insertErrors.push(
            typeof error === 'object' && error !== null && 'code' in error ? error.code : error,
          );
          throw error;
        }
      });
      return insertErrors;
    };

    it('the same key: both 201 with one order (the P2002 answered as the replay)', async () => {
      const user = await t.newUser();
      await t.fund(user.id, 600_000n);
      const quote = await t.quote(user.id);
      const insertErrors = collide();
      const key = newKey();
      const results = await Promise.all([1, 2].map(() => t.order(user, quote.id, { key })));
      expect(insertErrors).toEqual(['P2002']);
      expect(results.map((res) => res.status)).toEqual([201, 201]);
      expect(new Set(results.map(orderIdOf)).size).toBe(1);
      expect(await purchases(user.id)).toEqual({ orders: 1, debits: 1, balance: 50_000n });
    });

    it('two keys, one quote: 201 and 409 QUOTE_ALREADY_USED naming the winner', async () => {
      const user = await t.newUser();
      await t.fund(user.id, 2_000_000n);
      const quote = await t.quote(user.id);
      const insertErrors = collide();
      const results = await Promise.all([t.order(user, quote.id), t.order(user, quote.id)]);
      expect(insertErrors).toEqual(['P2002']);
      expect(results.map((res) => res.status).sort()).toEqual([201, 409]);
      const won = results.find((res) => res.status === 201);
      const lost = results.find((res) => res.status === 409);
      expect(lost?.body.error).toMatchObject({
        code: 'QUOTE_ALREADY_USED',
        details: { orderId: won === undefined ? 'none' : orderIdOf(won) },
      });
      expect(await purchases(user.id)).toMatchObject({ orders: 1, debits: 1 });
    });
  });
});
