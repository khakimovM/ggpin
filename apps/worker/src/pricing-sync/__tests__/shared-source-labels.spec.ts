import { Logger } from '@nestjs/common';
import type * as Shared from '@repo/shared';
import { SimulatedFragmentPrices } from '../../adapters/simulator/simulated-fragment-prices';
import { CostSyncService } from '../cost-sync.service';
import { SimulatedFxSource } from '../fx-sources/simulated-fx.source';
import { FxSyncService } from '../fx-sync.service';
import { FakeCostStore, FakeFxStore, candidate, dryRunConfig } from './pricing-fakes';

// The worker must take both labels from @repo/shared, the one place the API reads them from too
// (review M1). Swapping the shared values here proves no worker copy of them is left: a local
// constant or a hand-built "derived:" string would keep writing the old labels.
jest.mock('@repo/shared', () => {
  const actual = jest.requireActual<typeof Shared>('@repo/shared');
  return {
    ...actual,
    SIMULATOR_SOURCE: 'shared-sim',
    derivedFxSource: (tonUsdtId: string, usdtUzsId: string) =>
      `shared-derived(${tonUsdtId},${usdtUzsId})`,
  };
});

describe('price-source labels come from @repo/shared', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('both simulators are named with the shared SIMULATOR_SOURCE', () => {
    expect(new SimulatedFxSource().name).toBe('shared-sim');
    expect(new SimulatedFragmentPrices().name).toBe('shared-sim');
  });

  it('the FX sync labels simulated rows and the derived row through the shared helpers', async () => {
    const store = new FakeFxStore();
    await new FxSyncService(dryRunConfig(true), new SimulatedFxSource(), store).run(new Date());

    expect(store.written().map((row) => row.source)).toEqual([
      'shared-sim',
      'shared-sim',
      'shared-derived(fx-2,fx-1)',
    ]);
  });

  it('the cost sync labels simulated rows with the shared SIMULATOR_SOURCE', async () => {
    const store = new FakeCostStore([candidate({ productId: 'p', allowCustomQty: true })]);
    await new CostSyncService(dryRunConfig(true), [new SimulatedFragmentPrices()], store).run();
    expect(store.inserted.map((row) => row.source)).toEqual(['shared-sim']);
  });
});
