import { ADMIN_RETRYABLE_QUEUES, QUEUE_NAMES } from '@repo/shared';
import { RedisService } from '../../../infra/redis/redis.service';
import { DASHBOARD_CACHE_PREFIX } from '../dashboard/admin-dashboard.cache';
import { useAdminE2e } from './admin-e2e.harness';
import {
  buildReadWorld,
  isolatedInstant,
  TOPUP_TIYIN,
  type ReadWorld,
} from './admin-read.fixtures';
import { leaks } from './admin-read.scan';
import { checkRead } from './admin-read.schemas';

const A = '/api/v1/admin';
const HOUR = 3_600_000;
type Row = Record<string, unknown>;
type Body = { data: Row | Row[]; meta?: Record<string, number> };

// Dashboard (an isolated past window, so the figures are exactly this suite's rows), catalog,
// settings, FX history, queues and the OWNER's admin list.
describe('admin read: dashboard, catalog, settings, infra, admins (real app)', () => {
  const t = useAdminE2e();
  let w: ReadWorld;
  let at: Date;
  let ownerId = '';
  let owner = '';
  let operator = '';

  beforeAll(async () => {
    at = isolatedInstant();
    w = await buildReadWorld(t.db(), at);
    const ownerAdmin = await t.newAdmin('OWNER');
    ownerId = ownerAdmin.id;
    owner = (await t.login(ownerAdmin)).cookie;
    operator = (await t.login(await t.newAdmin('OPERATOR'))).cookie;
  });

  const get = async (url: string, cookie = owner) => {
    const res = await t.request('GET', url, t.spa({ cookie }));
    checkRead(url, res.statusCode, res.json());
    return { status: res.statusCode, body: res.json<Body>() };
  };
  const rows = (body: Body): Row[] => (Array.isArray(body.data) ? body.data : []);
  const one = (body: Body): Row => (Array.isArray(body.data) ? {} : body.data);

  it('dashboard (range): KPIs and charts of exactly this window', async () => {
    const from = new Date(at.getTime() - HOUR).toISOString();
    const to = new Date(at.getTime() + HOUR).toISOString();
    const { status, body } = await get(
      `${A}/dashboard?period=range&from=${from}&to=${to}`,
      operator,
    );
    expect(status).toBe(200);
    const data = one(body);
    expect(data['period']).toEqual({ from, to });
    expect(data['kpi']).toEqual({
      revenueTiyin: '1500000',
      ordersCount: 1,
      deliveredCount: 1,
      deliveryRateBps: 10_000,
      avgDeliverySec: 90,
      grossProfitTiyin: '250000',
      newUsersCount: 1,
      topupsTiyin: TOPUP_TIYIN.toString(),
      topupsCount: 1,
    });
    const charts = data['charts'] as Record<string, Row[]>;
    const chartSum = (charts['revenue'] ?? []).reduce(
      (sum, day) => sum + BigInt(String(day['revenueTiyin'])),
      0n,
    );
    expect(chartSum).toBe(1_500_000n);
    expect(charts['productShare']).toEqual([
      expect.objectContaining({ productId: w.productId, revenueTiyin: '1500000', ordersCount: 1 }),
    ]);
    expect(charts['topupBankShare']).toEqual([
      { bank: 'HUMO', amountTiyin: TOPUP_TIYIN.toString(), count: 1 },
    ]);
    expect(Array.isArray(data['alerts'])).toBe(true);
    expect(leaks(body)).toEqual([]);
  });

  it('dashboard: OWNER and OPERATOR get the same figures, each computed fresh (no role in the cache key)', async () => {
    const from = new Date(at.getTime() - HOUR).toISOString();
    const to = new Date(at.getTime() + HOUR).toISOString();
    const url = `${A}/dashboard?period=range&from=${from}&to=${to}`;
    const redis = t.app().get(RedisService).client;
    const fresh = async (cookie: string) => {
      await redis.del(`${DASHBOARD_CACHE_PREFIX}range:${from}:${to}`);
      const { status, body } = await get(url, cookie);
      expect(status).toBe(200);
      const { period, kpi, charts } = one(body);
      return { period, kpi, charts };
    };
    const asOwner = await fresh(owner);
    expect(await redis.exists(`${DASHBOARD_CACHE_PREFIX}range:${from}:${to}`)).toBe(1);
    expect(await fresh(operator)).toEqual(asOwner);
  });

  it('dashboard: presets take no dates; range needs both and at most 366 days', async () => {
    for (const period of ['today', 'week', 'month']) {
      expect([period, (await get(`${A}/dashboard?period=${period}`)).status]).toEqual([
        period,
        200,
      ]);
    }
    const iso = (ms: number) => new Date(ms).toISOString();
    for (const bad of [
      `period=week&from=${iso(0)}`,
      `period=range&from=${iso(0)}`,
      `period=range&from=${iso(0)}&to=${iso(367 * 24 * HOUR)}`,
      `period=range&from=${iso(HOUR)}&to=${iso(0)}`,
      'period=year',
    ]) {
      expect([bad, (await get(`${A}/dashboard?${bad}`)).status]).toEqual([bad, 400]);
    }
  });

  it('catalog: counts, product detail without inputSchema, routes UNKNOWN', async () => {
    const categories = rows((await get(`${A}/categories`, operator)).body);
    expect(categories.find((c) => c['id'] === w.categoryId)).toMatchObject({ productsCount: 1 });
    const products = rows((await get(`${A}/products`, operator)).body);
    expect(products.find((p) => p['id'] === w.productId)).toMatchObject({
      activeSkusCount: 1,
      routesEnabledCount: 1,
    });
    const detail = await get(`${A}/products/${w.productId}`, operator);
    expect(one(detail.body)['skus']).toEqual([
      expect.objectContaining({ id: w.skuId, minMarginTiyin: '0', markupBps: 1500 }),
    ]);
    expect(one(detail.body)['routes']).toEqual([
      expect.objectContaining({ adapter: 'FRAGMENT', health: 'UNKNOWN', healthCheckedAt: null }),
    ]);
    expect(leaks(detail.body)).toEqual([]);
    // A fixed-pack product takes no typed quantity.
    const qty = await get(`${A}/products/${w.productId}/price-preview?quantity=7`, operator);
    // An admin route speaks 400 + fields (docs/04 «Xatolar (admin)»), not the store's 422 (CR m3).
    expect(qty.status).toBe(400);
    expect(qty.body).toMatchObject({
      error: {
        code: 'VALIDATION_ERROR',
        details: { fields: [{ path: 'quantity', code: 'QTY_OUT_OF_RANGE' }] },
      },
    });
    const both = await get(
      `${A}/products/${w.productId}/price-preview?quantity=7&skuId=${w.skuId}`,
    );
    expect(both.status).toBe(400);
  });

  it('settings and FX history: strings only, a fixed list, paginated history', async () => {
    const settings = await get(`${A}/settings`, operator);
    const items = (one(settings.body)['items'] ?? []) as Row[];
    expect(items.map((item) => item['key'])).toContain('TOPUP_MIN_TIYIN');
    for (const item of items) expect(typeof item['value']).toBe('string');
    expect(leaks(settings.body)).toEqual([]);
    const history = await get(`${A}/fx/history?pair=USDT_UZS&limit=100`, operator);
    expect(rows(history.body).some((row) => row['id'] === w.fxRateId)).toBe(true);
    for (const row of rows(history.body)) expect(row['pair']).toBe('USDT_UZS');
    expect((await get(`${A}/fx/history?limit=101`)).status).toBe(400);
    expect((await get(`${A}/fx/history?pair=EUR_UZS`)).status).toBe(400);
  });

  it('infra queues: every queue, only notify and tg-outbox retryable', async () => {
    const list = rows((await get(`${A}/infra/queues`, operator)).body);
    expect(list.map((q) => q['name']).sort()).toEqual([...QUEUE_NAMES].sort());
    for (const queue of list) {
      expect(queue['retryable']).toBe(
        (ADMIN_RETRYABLE_QUEUES as readonly unknown[]).includes(queue['name']),
      );
    }
  });

  it('admins (OWNER): allowlisted, last login, sessions with the current one marked', async () => {
    const admins = await get(`${A}/admins`);
    const me = rows(admins.body).find((a) => a['id'] === ownerId);
    expect(me).toMatchObject({ role: 'OWNER', allowlisted: true, isActive: true });
    expect(typeof me?.['telegramId']).toBe('string');
    expect(me?.['lastLoginAt']).not.toBeNull();
    expect(Number(me?.['activeSessions'])).toBeGreaterThanOrEqual(1);
    const sessions = await get(`${A}/admins/${ownerId}/sessions`);
    const list = rows(sessions.body);
    expect(list.filter((s) => s['current'] === true)).toHaveLength(1);
    for (const s of list) {
      expect(s['userAgent']).toBeNull();
      // Stored masked at login (/24); the harness signs in from 10.x addresses.
      expect(String(s['ipMasked'])).toMatch(/^10\.\d+\.\d+\.x$/);
    }
    expect(leaks(admins.body)).toEqual([]);
    expect(leaks(sessions.body)).toEqual([]);
    expect((await get(`${A}/admins`, operator)).status).toBe(404);
  });
});
