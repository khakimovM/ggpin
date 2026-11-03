import { Logger } from '@nestjs/common';
import { multiplyRates } from '@repo/shared';
import type { FxQuote } from '../fx-sources/fx-source';
import { SimulatedFxSource } from '../fx-sources/simulated-fx.source';
import { FxSyncService } from '../fx-sync.service';
import { FakeFxSource, FakeFxStore, dryRunConfig } from './pricing-fakes';

const quotes = (usdtUzs: string, tonUsdt: string): FxQuote[] => [
  { pair: 'USDT_UZS', rate: usdtUzs },
  { pair: 'TON_USDT', rate: tonUsdt },
];

describe('FxSyncService', () => {
  let store: FakeFxStore;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    store = new FakeFxStore();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  const service = (source: FakeFxSource | SimulatedFxSource, dryRun = true) =>
    new FxSyncService(dryRunConfig(dryRun), source, store);

  it('writes both sourced rates and the derived TON_UZS naming its two parents', async () => {
    const result = await service(new SimulatedFxSource()).run();

    expect(result).toEqual({ written: ['USDT_UZS', 'TON_USDT', 'TON_UZS'], skipped: [] });
    const [usdtUzs, tonUsdt, tonUzs] = store.written();
    expect(usdtUzs).toMatchObject({ pair: 'USDT_UZS', rate: '12650', source: 'simulator' });
    expect(tonUsdt).toMatchObject({ pair: 'TON_USDT', rate: '3.2', source: 'simulator' });
    expect(tonUzs).toMatchObject({
      pair: 'TON_UZS',
      rate: '40480',
      source: `derived:${tonUsdt?.id ?? '?'}*${usdtUzs?.id ?? '?'}`,
    });
  });

  it('rounds the derived rate UP at the 18th decimal', async () => {
    // 1.000000000000000001 × 0.5 = 0.5000000000000000005 (19 decimals)
    await service(new FakeFxSource(quotes('0.5', '1.000000000000000001'))).run();

    const derived = store.written().find((row) => row.pair === 'TON_UZS');
    expect(derived?.rate).toBe('0.500000000000000001');
    expect(derived?.rate).toBe(multiplyRates('1.000000000000000001', '0.5', 'up'));
    expect(multiplyRates('1.000000000000000001', '0.5', 'down')).toBe('0.5');
  });

  describe('jump guard (FX_MAX_JUMP_BPS = 1000, 10%)', () => {
    beforeEach(() => {
      store.seed('USDT_UZS', '10000');
      store.seed('TON_USDT', '3.2');
    });

    it.each([
      ['up', '11001'],
      ['down', '8999'],
    ])('blocks a move of just over 10%% %s and then writes no derived rate', async (_dir, rate) => {
      const result = await service(new FakeFxSource(quotes(rate, '3.2'))).run();

      expect(result).toEqual({ written: ['TON_USDT'], skipped: ['USDT_UZS'] });
      expect(store.written().map((row) => row.pair)).toEqual(['TON_USDT']);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('USDT_UZS'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('seed-USDT_UZS'));
    });

    it.each([
      ['up', '11000'],
      ['down', '9000'],
    ])('allows a move of exactly 10%% %s', async (_dir, rate) => {
      const result = await service(new FakeFxSource(quotes(rate, '3.2'))).run();
      expect(result.written).toEqual(['USDT_UZS', 'TON_USDT', 'TON_UZS']);
    });

    it('guards TON_USDT too: a blocked TON_USDT means no TON_UZS', async () => {
      const result = await service(new FakeFxSource(quotes('10000', '3.53'))).run();

      expect(result).toEqual({ written: ['USDT_UZS'], skipped: ['TON_USDT'] });
      expect(store.written().some((row) => row.pair === 'TON_UZS')).toBe(false);
    });

    it('writes nothing at all when both pairs jump', async () => {
      const result = await service(new FakeFxSource(quotes('20000', '1'))).run();
      expect(result).toEqual({ written: [], skipped: ['USDT_UZS', 'TON_USDT'] });
      expect(store.written()).toEqual([]);
    });
  });

  describe('FULFILLMENT_DRY_RUN=false (no real source yet)', () => {
    it('writes nothing, never asks the simulator, and logs exactly one error', async () => {
      const source = new FakeFxSource(quotes('12650', '3.2'));
      const result = await service(source, false).run();

      expect(result.written).toEqual([]);
      expect(store.rows).toEqual([]);
      expect(source.fetchCalls).toBe(0);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('FULFILLMENT_DRY_RUN=false'));
    });

    it('a non-simulated source is not blocked by the dry-run gate', async () => {
      const result = await service(new FakeFxSource(quotes('12650', '3.2'), false), false).run();
      expect(result.written).toEqual(['USDT_UZS', 'TON_USDT', 'TON_UZS']);
      expect(error).not.toHaveBeenCalled();
    });
  });

  describe('source answer validation', () => {
    it.each(['0', '0.000', '-1', '1e3', ' 12650', '012650', '1.0000000000000000001', '', 'NaN'])(
      'drops USDT_UZS rate %p and derives nothing',
      async (bad) => {
        const result = await service(new FakeFxSource(quotes(bad, '3.2'))).run();
        expect(result).toEqual({ written: ['TON_USDT'], skipped: ['USDT_UZS'] });
      },
    );

    it('drops a pair quoted twice and a pair that is missing', async () => {
      const source = new FakeFxSource([
        { pair: 'USDT_UZS', rate: '12650' },
        { pair: 'USDT_UZS', rate: '12651' },
      ]);
      const result = await service(source).run();
      expect(result).toEqual({ written: [], skipped: ['USDT_UZS', 'TON_USDT'] });
      expect(store.rows).toEqual([]);
    });

    it('drops a quote for a pair the source may not provide (TON_UZS is always derived)', async () => {
      const source = new FakeFxSource([...quotes('12650', '3.2'), { pair: 'TON_UZS', rate: '1' }]);
      await service(source).run();
      expect(store.written().find((row) => row.pair === 'TON_UZS')?.rate).toBe('40480');
    });
  });
});
