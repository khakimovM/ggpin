import { Logger } from '@nestjs/common';
import { SimulatedFragmentPrices } from '../../adapters/simulator/simulated-fragment-prices';
import { SimulatedResellerPrices } from '../../adapters/simulator/simulated-reseller-prices';
import { SIMULATED_STAR_MICRO_USDT } from '../../adapters/simulator/simulated-reseller.adapter';
import { CostSyncService } from '../cost-sync.service';
import { FakeCostStore, candidate, dryRunConfig } from './pricing-fakes';

// Phase 5 S7 review M2: the cost sync prices a product from its first HEALTHY enabled route, so
// while Fragment is DOWN new quotes are in the backup's currency (criterion 5 end to end:
// fragment-failover.e2e-spec.ts). No healthy route -> the first enabled route, as before S7.

beforeEach(() => {
  for (const level of ['log', 'warn', 'error'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  }
});

afterEach(() => jest.restoreAllMocks());

describe('S7 review M2: priced by the first HEALTHY enabled route', () => {
  const both = candidate({
    productId: 'p-both',
    allowCustomQty: true,
    routes: [
      { adapter: 'FRAGMENT', isEnabled: true },
      { adapter: 'RESELLER_STARS', isEnabled: true },
    ],
  });
  const sources = () => [new SimulatedFragmentPrices(), new SimulatedResellerPrices()];
  const runWith = (store: FakeCostStore, healthy: readonly string[] | null) =>
    new CostSyncService(
      dryRunConfig(true),
      sources(),
      store,
      healthy === null ? null : { isHealthy: (a) => Promise.resolve(healthy.includes(a)) },
    ).run();

  it('Fragment DOWN, backup healthy: the backup prices it, in USDT', async () => {
    const store = new FakeCostStore([both]);
    await runWith(store, ['RESELLER_STARS']);
    expect(store.inserted).toEqual([
      expect.objectContaining({ adapter: 'RESELLER_STARS', currency: 'USDT' }),
    ]);
    expect(store.inserted[0]?.costMinor).toBe(SIMULATED_STAR_MICRO_USDT);
  });

  it('both healthy: the first route by priority (Fragment, TON)', async () => {
    const store = new FakeCostStore([both]);
    await runWith(store, ['FRAGMENT', 'RESELLER_STARS']);
    expect(store.inserted).toEqual([
      expect.objectContaining({ adapter: 'FRAGMENT', currency: 'TON' }),
    ]);
  });

  it('a health check that throws counts as unhealthy: only FRAGMENT throws -> the backup', async () => {
    const store = new FakeCostStore([both]);
    const fragmentThrows = {
      isHealthy: (a: string) =>
        a === 'FRAGMENT' ? Promise.reject(new Error('db down')) : Promise.resolve(true),
    };
    await new CostSyncService(dryRunConfig(true), sources(), store, fragmentThrows).run();
    expect(store.inserted).toEqual([
      expect.objectContaining({ adapter: 'RESELLER_STARS', currency: 'USDT' }),
    ]);
  });

  it('none healthy, no health source, or a health that throws: the first enabled route, as before', async () => {
    for (const healthy of [[], null]) {
      const store = new FakeCostStore([both]);
      await runWith(store, healthy);
      expect(store.inserted).toEqual([expect.objectContaining({ adapter: 'FRAGMENT' })]);
    }
    const store = new FakeCostStore([both]);
    const throwing = { isHealthy: () => Promise.reject(new Error('redis down')) };
    await new CostSyncService(dryRunConfig(true), sources(), store, throwing).run();
    expect(store.inserted).toEqual([expect.objectContaining({ adapter: 'FRAGMENT' })]);
  });

  it('a disabled healthy route is never chosen; the backup prices no fixed-pack product', async () => {
    const disabled = candidate({
      productId: 'p-dis',
      allowCustomQty: true,
      routes: [
        { adapter: 'FRAGMENT', isEnabled: true },
        { adapter: 'RESELLER_STARS', isEnabled: false },
      ],
    });
    const pack = candidate({
      productId: 'p-pack',
      routes: [{ adapter: 'RESELLER_STARS', isEnabled: true }],
      skus: [{ id: 'm-3', quantity: 3, isActive: true }],
    });
    const store = new FakeCostStore([disabled, pack]);
    await runWith(store, ['RESELLER_STARS']);
    expect(store.inserted).toEqual([
      expect.objectContaining({ productId: 'p-dis', adapter: 'FRAGMENT' }),
    ]);
  });
});
