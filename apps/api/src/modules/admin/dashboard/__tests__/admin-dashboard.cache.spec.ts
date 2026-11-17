import type { RedisService } from '../../../../infra/redis/redis.service';
import {
  AdminDashboardCache,
  DASHBOARD_CACHE_PREFIX,
  type DashboardFigures,
} from '../admin-dashboard.cache';

const FIGURES: DashboardFigures = {
  period: { from: '2026-11-10T00:00:00.000Z', to: '2026-11-17T00:00:00.000Z' },
  kpi: {
    revenueTiyin: '0',
    ordersCount: 0,
    deliveredCount: 0,
    deliveryRateBps: null,
    avgDeliverySec: null,
    grossProfitTiyin: '0',
    newUsersCount: 0,
    topupsTiyin: '0',
    topupsCount: 0,
  },
  charts: { revenue: [], productShare: [], topupBankShare: [] },
};

function setup() {
  const client = { get: jest.fn(), set: jest.fn().mockResolvedValue('OK') };
  return { client, cache: new AdminDashboardCache({ client } as unknown as RedisService) };
}

// CR minor: the cache is best effort both ways. Redis down, or a value that is not the figures'
// shape, is a miss (the service computes), never an error for the owner's screen.
describe('AdminDashboardCache', () => {
  it('round trip: set writes JSON with a 60 s expiry, get reads it back', async () => {
    const { client, cache } = setup();
    await cache.set('k', FIGURES);
    expect(client.set).toHaveBeenCalledWith(
      `${DASHBOARD_CACHE_PREFIX}k`,
      JSON.stringify(FIGURES),
      'EX',
      60,
    );
    client.get.mockResolvedValueOnce(JSON.stringify(FIGURES));
    await expect(cache.get('k')).resolves.toEqual(FIGURES);
    client.get.mockResolvedValueOnce(null);
    await expect(cache.get('k')).resolves.toBeNull();
  });

  it('Redis down: get is a miss, set resolves', async () => {
    const { client, cache } = setup();
    client.get.mockRejectedValue(new Error('connect ECONNREFUSED'));
    client.set.mockRejectedValue(new Error('connect ECONNREFUSED'));
    await expect(cache.get('k')).resolves.toBeNull();
    await expect(cache.set('k', FIGURES)).resolves.toBeUndefined();
  });

  it('corrupt value: not JSON, or JSON of another shape, is a miss', async () => {
    const { client, cache } = setup();
    client.get.mockResolvedValueOnce('{not json');
    await expect(cache.get('k')).resolves.toBeNull();
    client.get.mockResolvedValueOnce(JSON.stringify({ ...FIGURES, kpi: { revenueTiyin: 5 } }));
    await expect(cache.get('k')).resolves.toBeNull();
    client.get.mockResolvedValueOnce(JSON.stringify({ ...FIGURES, extra: true }));
    await expect(cache.get('k')).resolves.toBeNull();
  });
});
