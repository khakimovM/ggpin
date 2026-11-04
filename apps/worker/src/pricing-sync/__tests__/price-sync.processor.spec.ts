import { Logger } from '@nestjs/common';
import { CostSyncService } from '../cost-sync.service';
import { FxSyncService } from '../fx-sync.service';
import { PriceSyncProcessor } from '../price-sync.processor';
import { FakeCostStore, FakeFxSource, FakeFxStore, dryRunConfig } from './pricing-fakes';

const jobNamed = (name: string) => ({ name });

describe('PriceSyncProcessor', () => {
  let fx: FxSyncService;
  let cost: CostSyncService;
  let processor: PriceSyncProcessor;

  beforeEach(() => {
    const config = dryRunConfig(true);
    fx = new FxSyncService(config, new FakeFxSource([]), new FakeFxStore());
    cost = new CostSyncService(config, [], new FakeCostStore([]));
    processor = new PriceSyncProcessor(fx, cost);
  });

  afterEach(() => jest.restoreAllMocks());

  it('dispatches "fx" to the FX sync and "cost" to the cost sync', async () => {
    const fxRun = jest.spyOn(fx, 'run').mockResolvedValue({ written: [], skipped: [] });
    const costRun = jest.spyOn(cost, 'run').mockResolvedValue({ products: 0, snapshots: 0 });

    const before = Date.now();
    await processor.process(jobNamed('fx'));
    expect(fxRun).toHaveBeenCalledTimes(1);
    expect(costRun).not.toHaveBeenCalled();
    // The FX run gets the current time: it bounds the jump guard's comparison row.
    const now: unknown = fxRun.mock.calls[0]?.[0];
    expect(now).toBeInstanceOf(Date);
    expect(now instanceof Date && now.getTime() >= before && now.getTime() <= Date.now()).toBe(
      true,
    );

    await processor.process(jobNamed('cost'));
    expect(costRun).toHaveBeenCalledTimes(1);
    expect(fxRun).toHaveBeenCalledTimes(1);
  });

  it('fails an unknown job name instead of guessing', async () => {
    const fxRun = jest.spyOn(fx, 'run');
    await expect(processor.process(jobNamed('fulfill'))).rejects.toThrow('unknown price-sync job');
    expect(fxRun).not.toHaveBeenCalled();
  });

  it('logs a failed job with its error scrubbed', () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    processor.onFailed(jobNamed('fx'), new Error('Authorization: Bearer abcdefghijklmnop'));
    const line = String(error.mock.calls[0]?.[0]);
    expect(line).toContain('price-sync job fx failed');
    expect(line).not.toContain('abcdefghijklmnop');
  });
});
