import { sumBalance } from '@repo/db';
import { useAdminE2e } from './admin-e2e.harness';
import { purgeFixtureCatalogAround } from './admin-fixture-purge';
import { extraOrder } from './admin-read.extra-order';
import { buildReadWorld, PHONE, type ReadWorld } from './admin-read.fixtures';
import { leaks } from './admin-read.scan';
import { checkRead } from './admin-read.schemas';

const A = '/api/v1/admin';
type Body = {
  data: Record<string, unknown> & { items?: unknown[] };
  meta?: Record<string, number>;
};
type Row = Record<string, unknown>;

// GET /admin/users*: pagination and its limit, filters, money as strings, the balance as
// SUM(ledger), the phone by role, and no secrets in any body.
describe('admin read: users (real app)', () => {
  const t = useAdminE2e();
  purgeFixtureCatalogAround(t, 'ar-');
  let w: ReadWorld;
  let owner = '';
  let operator = '';
  let support = '';
  let failedOrderId = '';

  beforeAll(async () => {
    w = await buildReadWorld(t.db(), new Date(Date.now() - 3_600_000));
    // Not delivered: listed in the orders tab, never counted in ordersCount / ordersTotalTiyin.
    failedOrderId = await extraOrder(t.db(), w.orderId, 'FAILED');
    owner = (await t.login(await t.newAdmin('OWNER'))).cookie;
    operator = (await t.login(await t.newAdmin('OPERATOR'))).cookie;
    support = (await t.login(await t.newAdmin('SUPPORT'))).cookie;
  });

  const get = async (url: string, cookie = owner) => {
    const res = await t.request('GET', url, t.spa({ cookie }));
    checkRead(url, res.statusCode, res.json());
    return { status: res.statusCode, body: res.json<Body>() };
  };
  const items = (body: Body): Row[] => (Array.isArray(body.data) ? (body.data as Row[]) : []);

  it('list: search by telegram id and @username, money as strings, balance = SUM(ledger)', async () => {
    const expected = await sumBalance(t.db(), w.user.id);
    expect(expected).toBe(w.balanceTiyin);
    for (const q of [w.user.telegramId.toString(), `@${w.user.username}`, w.user.id]) {
      const { status, body } = await get(`${A}/users?q=${encodeURIComponent(q)}`);
      expect(status).toBe(200);
      const rows = items(body);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: w.user.id,
        telegramId: w.user.telegramId.toString(),
        balanceTiyin: expected.toString(),
        ordersCount: 1,
        ordersTotalTiyin: '1500000',
      });
      expect(body.meta).toMatchObject({ page: 1, total: 1 });
      expect(leaks(body)).toEqual([]);
    }
  });

  it('list: limit 100 is fine, 101 and 0 are 400; page 2 is past the end', async () => {
    expect((await get(`${A}/users?limit=100`)).status).toBe(200);
    for (const bad of ['limit=101', 'limit=0', 'page=0', 'nope=1']) {
      const res = await get(`${A}/users?${bad}`);
      expect([bad, res.status]).toEqual([bad, 400]);
    }
    const q = encodeURIComponent(`@${w.user.username}`);
    const second = await get(`${A}/users?q=${q}&limit=1&page=2`);
    expect(items(second.body)).toEqual([]);
    expect(second.body.meta).toMatchObject({ page: 2, limit: 1, total: 1 });
  });

  it('list: status filters split the users', async () => {
    const q = encodeURIComponent(`@${w.user.username}`);
    expect(items((await get(`${A}/users?q=${q}&status=ACTIVE`)).body)).toHaveLength(1);
    expect(items((await get(`${A}/users?q=${q}&status=BLOCKED`)).body)).toHaveLength(0);
    expect(items((await get(`${A}/users?q=${q}&status=FROZEN`)).body)).toHaveLength(0);
  });

  it('detail: OWNER and OPERATOR see the phone, SUPPORT a masked one', async () => {
    for (const cookie of [owner, operator]) {
      const { body } = await get(`${A}/users/${w.user.id}`, cookie);
      expect(body.data['phone']).toBe(PHONE);
    }
    const masked = await get(`${A}/users/${w.user.id}`, support);
    expect(masked.status).toBe(200);
    expect(masked.body.data['phone']).toBe('+998 ** *** ** 67');
    expect(JSON.stringify(masked.body)).not.toContain('901234567');
    expect(masked.body.data['balanceTiyin']).toBe(w.balanceTiyin.toString());
    for (const cookie of [owner, operator, support]) {
      expect(leaks((await get(`${A}/users/${w.user.id}`, cookie)).body)).toEqual([]);
    }
  });

  it('tabs: orders with profit, ledger summing to the balance, payments, referrals, sessions', async () => {
    const orders = items((await get(`${A}/users/${w.user.id}/orders`, support)).body);
    expect(orders.map((row) => [row['id'], row['status']])).toEqual([
      [w.orderId, 'DELIVERED'],
      [failedOrderId, 'FAILED'],
    ]);
    expect(orders[0]).toMatchObject({
      id: w.orderId,
      priceTiyin: '1600000',
      discountTiyin: '100000',
      totalTiyin: '1500000',
      costMinor: '1000000',
      profitTiyin: '250000',
      status: 'DELIVERED',
    });
    expect(orders[0]?.['recipient']).toEqual({
      displayName: 'Some One',
      fields: { username: 'someone' },
    });

    const ledger = await get(`${A}/users/${w.user.id}/ledger?limit=2`, support);
    expect(ledger.body.meta).toMatchObject({ total: 3, limit: 2 });
    const page2 = await get(`${A}/users/${w.user.id}/ledger?limit=2&page=2`, support);
    const all = [...items(ledger.body), ...items(page2.body)];
    expect(all).toHaveLength(3);
    const sum = all.reduce((s, row) => s + BigInt(String(row['amountTiyin'])), 0n);
    expect(sum).toBe(w.balanceTiyin);

    const payments = items((await get(`${A}/users/${w.user.id}/payments`, support)).body);
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      id: w.paymentId,
      status: 'CONFIRMED',
      amountTiyin: '2012300',
    });

    expect((await get(`${A}/users/${w.user.id}/referrals`, support)).status).toBe(200);
    // Web sessions store the IP already masked (/24): shown as stored, never re-masked to null.
    await t.db().webSession.create({
      data: {
        userId: w.user.id,
        refreshHash: `ar-${w.user.id}`,
        familyId: `ar-${w.user.id}`,
        ip: '10.1.2.x',
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    const sessions = items((await get(`${A}/users/${w.user.id}/sessions`, support)).body);
    expect(sessions).toEqual([expect.objectContaining({ ipMasked: '10.1.2.x', revokedAt: null })]);
    for (const tab of ['orders', 'ledger', 'payments', 'referrals', 'sessions']) {
      const { body } = await get(`${A}/users/${w.user.id}/${tab}`, support);
      expect([tab, leaks(body)]).toEqual([tab, []]);
      expect([tab, (await get(`${A}/users/${w.user.id}/${tab}?limit=101`)).status]).toEqual([
        tab,
        400,
      ]);
    }
  });
});
