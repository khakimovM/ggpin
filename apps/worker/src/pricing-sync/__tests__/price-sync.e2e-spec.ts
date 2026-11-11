import { getQueueToken } from '@nestjs/bullmq';
import { Test, type TestingModule } from '@nestjs/testing';
import { createPrismaClient, type PrismaClient } from '@repo/db';
import { PRICE_SYNC_EVERY_MS, QUEUES } from '@repo/shared';
import type { Queue } from 'bullmq';
import {
  SIMULATED_PREMIUM_NANO_TON,
  SIMULATED_STAR_NANO_TON,
} from '../../adapters/simulator/simulated-fragment-prices';
import { WorkerConfigModule } from '../../config/config.module';
import { buildE2eEnv } from '../../config/__tests__/e2e-env';
import type { Env } from '../../config/env';
import { PrismaModule } from '../../infra/prisma/prisma.module';
import { withoutPaymentCrons } from '../../__tests__/payment-cron-isolation';
import { WorkerModule } from '../../worker.module';
import { CostSyncService } from '../cost-sync.service';
import { FxSyncService } from '../fx-sync.service';
import { PriceSyncProcessor } from '../price-sync.processor';
import { PriceSyncScheduler } from '../price-sync.scheduler';
import { PricingSyncModule } from '../pricing-sync.module';
import {
  E2E_FX_SOURCE,
  cleanupSince,
  deleteSyncedPriceRows,
  resetPriceSyncQueue,
} from './price-sync-e2e-cleanup';
import { createFixtures, deleteFixtures, type Fixtures } from './price-sync-e2e-fixtures';

// Real ggpin_test Postgres + Redis DB 15. Run through the e2e lock: the cost sync reads every
// product in the database. Fixtures carry a per-run suffix and are removed afterwards.

/** The sync services on the real database, without the scheduler/processor (no background runs). */
async function syncModule(env: Env): Promise<TestingModule> {
  const moduleRef = await Test.createTestingModule({
    imports: [WorkerConfigModule.forRoot(env), PrismaModule, PricingSyncModule],
  })
    .overrideProvider(PriceSyncProcessor)
    .useValue({})
    .overrideProvider(PriceSyncScheduler)
    .useValue({})
    .compile();
  moduleRef.useLogger(false);
  await moduleRef.init();
  return moduleRef;
}

describe('price sync on the real database (dry-run simulator)', () => {
  const env = buildE2eEnv();
  let prisma: PrismaClient;
  let since: Date;
  let fixtures: Fixtures;
  let moduleRef: TestingModule;

  const latest = (pair: string) =>
    prisma.fxRate.findFirst({ where: { pair }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  // Anchors "last stored rate" so leftovers of other suites cannot trip the jump guard here.
  const anchor = (pair: string, rate: string) =>
    prisma.fxRate.create({ data: { pair, rate, source: E2E_FX_SOURCE } });

  beforeAll(async () => {
    expect(env.FULFILLMENT_DRY_RUN).toBe(true);
    prisma = createPrismaClient(env.DATABASE_URL);
    since = cleanupSince();
    await resetPriceSyncQueue(env);
    fixtures = await createFixtures(prisma);
    moduleRef = await syncModule(env);
  });

  afterAll(async () => {
    await moduleRef.close();
    await deleteFixtures(prisma, fixtures);
    await deleteSyncedPriceRows(prisma, since);
    await resetPriceSyncQueue(env);
    await prisma.$disconnect();
  });

  it('one FX run writes USDT_UZS, TON_USDT and the derived TON_UZS', async () => {
    await anchor('USDT_UZS', '12650');
    await anchor('TON_USDT', '3.2');

    const result = await moduleRef.get(FxSyncService).run(new Date());

    expect(result).toEqual({ written: ['USDT_UZS', 'TON_USDT', 'TON_UZS'], skipped: [] });
    const usdtUzs = await latest('USDT_UZS');
    const tonUsdt = await latest('TON_USDT');
    const tonUzs = await latest('TON_UZS');
    expect(usdtUzs).toMatchObject({ rate: '12650', source: 'simulator' });
    expect(tonUsdt).toMatchObject({ rate: '3.2', source: 'simulator' });
    expect(tonUzs).toMatchObject({
      rate: '40480',
      source: `derived:${tonUsdt?.id ?? '?'}*${usdtUzs?.id ?? '?'}`,
    });
  });

  it('one cost run writes snapshots only for active FRAGMENT-first products', async () => {
    const result = await moduleRef.get(CostSyncService).run();
    expect(result.snapshots).toBeGreaterThanOrEqual(3);

    const rows = await prisma.costSnapshot.findMany({
      where: {
        productId: {
          in: [fixtures.starsId, fixtures.premiumId, fixtures.inactiveId, fixtures.otherRouteId],
        },
      },
      orderBy: { basisQuantity: 'asc' },
    });
    const common = { adapter: 'FRAGMENT', currency: 'TON', source: 'simulator' };
    expect(rows).toEqual([
      expect.objectContaining({
        ...common,
        productId: fixtures.starsId,
        skuId: null,
        basisQuantity: 1,
        costMinor: SIMULATED_STAR_NANO_TON,
      }),
      expect.objectContaining({
        ...common,
        productId: fixtures.premiumId,
        skuId: fixtures.premiumSkus.m3,
        basisQuantity: 3,
        costMinor: SIMULATED_PREMIUM_NANO_TON.get(3),
      }),
      expect.objectContaining({
        ...common,
        productId: fixtures.premiumId,
        skuId: fixtures.premiumSkus.m6,
        basisQuantity: 6,
        costMinor: SIMULATED_PREMIUM_NANO_TON.get(6),
      }),
    ]);
  });

  it('the jump guard blocks a rate more than 10% from the last stored one (and its derived row)', async () => {
    const anchorRow = await anchor('USDT_UZS', '20000');
    const tonUzsBefore = await latest('TON_UZS');

    const result = await moduleRef.get(FxSyncService).run(new Date());

    expect(result).toEqual({ written: ['TON_USDT'], skipped: ['USDT_UZS'] });
    expect((await latest('USDT_UZS'))?.id).toBe(anchorRow.id);
    expect((await latest('TON_UZS'))?.id).toBe(tonUzsBefore?.id);
  });

  it('the jump guard ignores rows stamped more than MAX_CLOCK_SKEW_MS ahead, not nearer ones', async () => {
    const now = new Date();
    const stampedAt = (offsetMs: number, rate: string) =>
      prisma.fxRate.create({
        data: {
          pair: 'USDT_UZS',
          rate,
          source: E2E_FX_SOURCE,
          createdAt: new Date(now.getTime() + offsetMs),
        },
      });
    await anchor('USDT_UZS', '12650');
    const ids: string[] = [];
    try {
      // An hour ahead and far off: as the anchor it would block the correct 12650.
      ids.push((await stampedAt(3_600_000, '50000')).id);
      expect(await moduleRef.get(FxSyncService).run(now)).toEqual({
        written: ['USDT_UZS', 'TON_USDT', 'TON_UZS'],
        skipped: [],
      });

      // 30 s ahead is within the tolerated skew: still the anchor, so 12650 is blocked.
      ids.push((await stampedAt(30_000, '20000')).id);
      expect(await moduleRef.get(FxSyncService).run(now)).toEqual({
        written: ['TON_USDT'],
        skipped: ['USDT_UZS'],
      });
    } finally {
      // Future rows would stay "latest" for the next tests (and suites) until real time passes.
      await prisma.fxRate.deleteMany({ where: { id: { in: ids } } });
    }
  });

  it('with FULFILLMENT_DRY_RUN=false nothing is written', async () => {
    const live = await syncModule({ ...env, FULFILLMENT_DRY_RUN: false });
    try {
      const fxBefore = await prisma.fxRate.count();
      const costBefore = await prisma.costSnapshot.count();

      expect((await live.get(FxSyncService).run(new Date())).written).toEqual([]);
      expect(await live.get(CostSyncService).run()).toEqual({ products: 0, snapshots: 0 });

      expect(await prisma.fxRate.count()).toBe(fxBefore);
      expect(await prisma.costSnapshot.count()).toBe(costBefore);
    } finally {
      await live.close();
    }
  });

  it('booting the worker twice leaves exactly 2 job schedulers, and the boot run writes prices', async () => {
    const simulatorRows = () => prisma.fxRate.count({ where: { source: 'simulator' } });
    const before = await simulatorRows();
    for (let boot = 0; boot < 2; boot += 1) {
      const worker = await withoutPaymentCrons(
        Test.createTestingModule({ imports: [WorkerModule.register(env)] }),
      ).compile();
      worker.useLogger(false);
      await worker.init();
      try {
        await worker.get(PriceSyncScheduler).whenScheduled();
        const queue = worker.get<Queue>(getQueueToken(QUEUES.PRICE_SYNC), { strict: false });
        const schedulers = await queue.getJobSchedulers();
        expect(schedulers.map((s) => s.key).sort()).toEqual(['price-sync:cost', 'price-sync:fx']);
        expect(schedulers.every((s) => Number(s.every) === PRICE_SYNC_EVERY_MS)).toBe(true);
        if (boot === 1) {
          // The processor really consumed a boot job: new simulator FxRate rows appeared.
          await expect(waitFor(async () => (await simulatorRows()) > before)).resolves.toBe(true);
        }
      } finally {
        await worker.close();
      }
    }
  });
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
