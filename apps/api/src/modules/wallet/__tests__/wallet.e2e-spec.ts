import { WalletResponseSchema } from '@repo/shared';
import { useWalletE2e } from './wallet-e2e.helpers';

const e2e = useWalletE2e();

describe('GET /me/wallet', () => {
  it('requires a session', async () => {
    const res = await e2e.get('/me/wallet', null);
    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('UNAUTHORIZED');
  });

  it('answers { balanceTiyin, coins, currency } exactly, money as a string, never cached by HTTP', async () => {
    const user = await e2e.newUser();
    await e2e.seedEntry(user.id, 'TOPUP', 2_034_100n, {
      refType: 'PAYMENT',
      refId: e2e.ref('pay_a'),
    });

    const res = await e2e.get('/me/wallet', user);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: { balanceTiyin: '2034100', coins: '0', currency: 'UZS' },
    });
    expect(WalletResponseSchema.safeParse(res.body.data).success).toBe(true);
    expect(String(res.headers['cache-control'])).toContain('no-store');
  });

  it('a new user has a zero balance', async () => {
    const user = await e2e.newUser();
    const res = await e2e.get('/me/wallet', user);
    expect(res.body.data).toMatchObject({ balanceTiyin: '0' });
  });

  it("is the sum of the user's own entries only (ownership)", async () => {
    const [a, b] = [await e2e.newUser(), await e2e.newUser()];
    await e2e.seedEntry(a.id, 'TOPUP', 1_000n, { refType: 'PAYMENT', refId: e2e.ref('own_a') });
    await e2e.seedEntry(b.id, 'TOPUP', 90_000n, { refType: 'PAYMENT', refId: e2e.ref('own_b') });

    expect((await e2e.get('/me/wallet', a)).body.data).toMatchObject({ balanceTiyin: '1000' });
    expect((await e2e.get('/me/wallet', b)).body.data).toMatchObject({ balanceTiyin: '90000' });
  });

  it('shows a negative balance after a reversal of spent money', async () => {
    const user = await e2e.newUser();
    await e2e.seedEntry(user.id, 'TOPUP', 100n, { refType: 'PAYMENT', refId: e2e.ref('neg_p') });
    await e2e.seedEntry(user.id, 'TOPUP_REVERSAL', -650n, {
      refType: 'PAYMENT',
      refId: e2e.ref('neg_p'),
    });
    expect((await e2e.get('/me/wallet', user)).body.data).toMatchObject({ balanceTiyin: '-550' });
  });
});

describe('GET /me/wallet cache (wallet:{userId})', () => {
  it('miss -> SUM -> SET with a 60 s expiry; hit -> served from Redis; DEL -> recomputed', async () => {
    const user = await e2e.newUser();
    const key = `wallet:${user.id}`;
    await e2e.seedEntry(user.id, 'TOPUP', 700n, { refType: 'PAYMENT', refId: e2e.ref('cache_1') });
    expect(await e2e.redis().get(key)).toBeNull();

    // miss
    expect((await e2e.get('/me/wallet', user)).body.data).toMatchObject({ balanceTiyin: '700' });
    expect(await e2e.redis().get(key)).toBe('700');
    const ttl = await e2e.redis().ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);

    // hit: a ledger write that did NOT delete the key is invisible, which proves the cache answers
    await e2e.seedEntry(user.id, 'TOPUP', 300n, { refType: 'PAYMENT', refId: e2e.ref('cache_2') });
    expect((await e2e.get('/me/wallet', user)).body.data).toMatchObject({ balanceTiyin: '700' });

    // the writer's DEL makes the next read see the truth
    await e2e.redis().del(key);
    expect((await e2e.get('/me/wallet', user)).body.data).toMatchObject({ balanceTiyin: '1000' });
  });

  it('a corrupt cached value is ignored and recomputed from the ledger', async () => {
    const user = await e2e.newUser();
    await e2e.seedEntry(user.id, 'TOPUP', 42n, { refType: 'PAYMENT', refId: e2e.ref('corrupt_1') });
    await e2e.redis().set(`wallet:${user.id}`, 'not-a-number', 'EX', 60);
    expect((await e2e.get('/me/wallet', user)).body.data).toMatchObject({ balanceTiyin: '42' });
    expect(await e2e.redis().get(`wallet:${user.id}`)).toBe('42');
  });

  it('Redis unavailable: still 200 with the true balance, no error', async () => {
    const user = await e2e.newUser();
    await e2e.seedEntry(user.id, 'TOPUP', 5_000n, { refType: 'PAYMENT', refId: e2e.ref('down_1') });
    const client = e2e.redis();
    const down = new Error('connect ECONNREFUSED');
    const spies = [
      jest.spyOn(client, 'get').mockRejectedValue(down),
      jest.spyOn(client, 'set').mockRejectedValue(down),
    ];
    try {
      const res = await e2e.get('/me/wallet', user);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ balanceTiyin: '5000' });
    } finally {
      spies.forEach((spy) => {
        spy.mockRestore();
      });
    }
  });
});
