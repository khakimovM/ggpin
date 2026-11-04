import { Logger } from '@nestjs/common';
import {
  SIMULATED_PREMIUM_NANO_TON,
  SIMULATED_STAR_NANO_TON,
  SimulatedFragmentPrices,
} from '../../adapters/simulator/simulated-fragment-prices';
import type { CostLine, CostSource } from '../cost-sources/cost-source';
import { CostSyncService } from '../cost-sync.service';
import { FakeCostStore, candidate, dryRunConfig } from './pricing-fakes';

const stars = candidate({
  productId: 'p-stars',
  allowCustomQty: true,
  skus: [
    { id: 's-50', quantity: 50, isActive: true },
    { id: 's-100', quantity: 100, isActive: true },
  ],
});
const premium = candidate({
  productId: 'p-premium',
  skus: [
    { id: 'm-3', quantity: 3, isActive: true },
    { id: 'm-6', quantity: 6, isActive: true },
    { id: 'm-12', quantity: 12, isActive: false },
  ],
});

/** A source that returns fixed lines, to exercise the service's own validation. */
class StubSource implements CostSource {
  costsCalls = 0;
  constructor(
    private readonly lines: readonly CostLine[] | Error,
    readonly simulated = true,
    readonly name = 'stub',
    readonly adapter = 'FRAGMENT',
  ) {}
  costs(): Promise<readonly CostLine[]> {
    this.costsCalls += 1;
    return this.lines instanceof Error ? Promise.reject(this.lines) : Promise.resolve(this.lines);
  }
}

const oneStar: CostLine[] = [{ skuId: null, basisQuantity: 1, currency: 'TON', costMinor: 7n }];

describe('CostSyncService', () => {
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  const run = (
    store: FakeCostStore,
    dryRun = true,
    sources: CostSource[] = [new SimulatedFragmentPrices()],
  ) => new CostSyncService(dryRunConfig(dryRun), sources, store).run();

  it('writes one product-level row for Stars and one row per active Premium SKU, in TON', async () => {
    const store = new FakeCostStore([stars, premium]);
    const result = await run(store);

    expect(result).toEqual({ products: 2, snapshots: 3 });
    const common = { adapter: 'FRAGMENT', currency: 'TON', source: 'simulator' };
    expect(store.inserted).toEqual([
      {
        ...common,
        productId: 'p-stars',
        skuId: null,
        basisQuantity: 1,
        costMinor: SIMULATED_STAR_NANO_TON,
      },
      {
        ...common,
        productId: 'p-premium',
        skuId: 'm-3',
        basisQuantity: 3,
        costMinor: SIMULATED_PREMIUM_NANO_TON.get(3),
      },
      {
        ...common,
        productId: 'p-premium',
        skuId: 'm-6',
        basisQuantity: 6,
        costMinor: SIMULATED_PREMIUM_NANO_TON.get(6),
      },
    ]);
  });

  it('skips inactive products', async () => {
    const store = new FakeCostStore([{ ...stars, isActive: false }, premium]);
    await run(store);
    expect(store.inserted.map((row) => row.productId)).not.toContain('p-stars');
  });

  it.each([
    [
      'first enabled route is another adapter',
      [
        { adapter: 'RESELLER_STARS', isEnabled: true },
        { adapter: 'FRAGMENT', isEnabled: true },
      ],
    ],
    ['FRAGMENT route disabled', [{ adapter: 'FRAGMENT', isEnabled: false }]],
    ['no route at all', []],
  ])('skips a product when %s', async (_why, routes) => {
    const store = new FakeCostStore([{ ...stars, routes }]);
    expect(await run(store)).toEqual({ products: 0, snapshots: 0 });
    expect(store.inserted).toEqual([]);
  });

  it('uses FRAGMENT when a disabled route sorts before it', async () => {
    const routes = [
      { adapter: 'RESELLER_STARS', isEnabled: false },
      { adapter: 'FRAGMENT', isEnabled: true },
    ];
    const store = new FakeCostStore([{ ...stars, routes }]);
    expect(await run(store)).toEqual({ products: 1, snapshots: 1 });
  });

  it('with FULFILLMENT_DRY_RUN=false writes nothing, reads nothing and logs one error', async () => {
    const store = new FakeCostStore([stars, premium]);
    expect(await run(store, false)).toEqual({ products: 0, snapshots: 0 });
    expect(store.inserted).toEqual([]);
    expect(store.listCalls).toBe(0);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('FULFILLMENT_DRY_RUN=false'));
  });

  it('drops lines that break the snapshot rules and keeps the valid ones', async () => {
    const ton = 'TON' as const;
    const source = new StubSource([
      { skuId: 'm-3', basisQuantity: 3, currency: ton, costMinor: 1n }, // valid
      { skuId: 'm-3', basisQuantity: 3, currency: ton, costMinor: 0n },
      { skuId: 'm-3', basisQuantity: 3, currency: ton, costMinor: -5n },
      { skuId: 'm-3', basisQuantity: 4, currency: ton, costMinor: 1n },
      { skuId: 'm-12', basisQuantity: 12, currency: ton, costMinor: 1n }, // inactive SKU
      { skuId: 'other', basisQuantity: 1, currency: ton, costMinor: 1n },
      { skuId: null, basisQuantity: 1, currency: ton, costMinor: 1n }, // fixed-pack product
      { skuId: 'm-6', basisQuantity: 0, currency: ton, costMinor: 1n },
    ]);
    const store = new FakeCostStore([premium]);
    expect(await run(store, true, [source])).toEqual({ products: 1, snapshots: 1 });
    expect(store.inserted).toEqual([
      expect.objectContaining({ skuId: 'm-3', basisQuantity: 3, costMinor: 1n }),
    ]);
    expect(warn).toHaveBeenCalledTimes(7);
  });

  describe('stored label follows the simulated flag, not the name', () => {
    it.each(['stub', 'reseller-api', '', 'derived:a*b'])(
      'a simulated source named %p writes source "simulator"',
      async (name) => {
        const store = new FakeCostStore([stars]);
        await run(store, true, [new StubSource(oneStar, true, name)]);
        expect(store.inserted).toEqual([expect.objectContaining({ source: 'simulator' })]);
        expect(error).not.toHaveBeenCalled();
      },
    );

    it('a real source writes its own name', async () => {
      const store = new FakeCostStore([stars]);
      await run(store, false, [new StubSource(oneStar, false, 'fragment-live')]);
      expect(store.inserted).toEqual([expect.objectContaining({ source: 'fragment-live' })]);
    });

    it.each([
      ['simulator', true],
      ['simulator', false],
      ['SIMULATOR', true],
      ['derived:x*y', true],
      ['', true],
      ['  ', false],
    ])(
      'a real source named %p is refused (dry-run=%p): not asked, nothing written, one error',
      async (name, dryRun) => {
        const store = new FakeCostStore([stars]);
        const source = new StubSource(oneStar, false, name);
        expect(await run(store, dryRun, [source])).toEqual({ products: 0, snapshots: 0 });
        expect(store.inserted).toEqual([]);
        expect(source.costsCalls).toBe(0);
        expect(store.listCalls).toBe(0);
        expect(error).toHaveBeenCalledTimes(1);
        expect(error).toHaveBeenCalledWith(expect.stringContaining('reserved name'));
      },
    );

    it('refuses only the bad source; another adapter still writes, still one error', async () => {
      const reseller = candidate({
        productId: 'p-reseller',
        allowCustomQty: true,
        routes: [{ adapter: 'RESELLER_STARS', isEnabled: true }],
      });
      const store = new FakeCostStore([stars, reseller]);
      const bad = new StubSource(oneStar, false, 'simulator', 'FRAGMENT');
      const good = new StubSource(oneStar, false, 'reseller-api', 'RESELLER_STARS');

      expect(await run(store, true, [bad, good])).toEqual({ products: 1, snapshots: 1 });
      expect(store.inserted).toEqual([
        expect.objectContaining({ productId: 'p-reseller', source: 'reseller-api' }),
      ]);
      expect(bad.costsCalls).toBe(0);
      expect(error).toHaveBeenCalledTimes(1);
    });
  });

  it('a failing source skips only that product and its error text is scrubbed', async () => {
    const store = new FakeCostStore([premium]);
    const result = await run(store, true, [
      new StubSource(new Error('GET https://x.test/?api_key=p4ss failed')),
    ]);
    expect(result).toEqual({ products: 0, snapshots: 0 });
    const logged = warn.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
    expect(logged).toContain('p-premium');
    expect(logged).not.toContain('p4ss');
  });
});
