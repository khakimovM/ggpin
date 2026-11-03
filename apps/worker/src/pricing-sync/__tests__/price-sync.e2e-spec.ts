import { randomUUID } from 'node:crypto';
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

// Real ggpin_test Postgres + Redis DB 15. Run through the e2e lock: the cost sync reads every
// product in the database. Fixtures carry a per-run suffix and are removed afterwards.
const RUN = randomUUID().slice(0, 8);

interface Fixtures {
  categoryId: string;
  starsId: string;
  premiumId: string;
  premiumSkus: Record<'m3' | 'm6' | 'm12', string>;
  inactiveId: string;
  otherRouteId: string;
}

async function createFixtures(prisma: PrismaClient): Promise<Fixtures> {
  const category = await prisma.category.create({
    data: { slug: `e2e-ps-${RUN}`, nameUz: 'Test', nameRu: 'Тест' },
  });
  const product = (slug: string, extra: { isActive?: boolean; allowCustomQty?: boolean }) =>
    prisma.product.create({
      data: {
        slug: `e2e-ps-${slug}-${RUN}`,
        categoryId: category.id,
        nameUz: slug,
        nameRu: slug,
        imageUrl: '/e2e.png',
        deliveryType: 'TG_USERNAME',
        inputSchema: [],
        isActive: extra.isActive ?? true,
        allowCustomQty: extra.allowCustomQty ?? false,
        ...(extra.allowCustomQty === true ? { minQty: 50, maxQty: 100_000 } : {}),
      },
    });
  const sku = async (productId: string, quantity: number, isActive = true) =>
    (
      await prisma.sku.create({
        data: {
          productId,
          labelUz: `${quantity}`,
          labelRu: `${quantity}`,
          quantity,
          markupBps: 1000,
          isActive,
        },
      })
    ).id;
  const route = (productId: string, adapter: string, priority: number, isEnabled = true) =>
    prisma.productRoute.create({ data: { productId, adapter, priority, isEnabled } });

  const stars = await product('stars', { allowCustomQty: true });
  await sku(stars.id, 50);
  await route(stars.id, 'FRAGMENT', 1);
  await route(stars.id, 'RESELLER_STARS', 2);

  const premium = await product('premium', {});
  const premiumSkus = {
    m3: await sku(premium.id, 3),
    m6: await sku(premium.id, 6),
    m12: await sku(premium.id, 12, false),
  };
  await route(premium.id, 'RESELLER_STARS', 1, false);
  await route(premium.id, 'FRAGMENT', 2);

  const inactive = await product('inactive', { isActive: false, allowCustomQty: true });
  await route(inactive.id, 'FRAGMENT', 1);

  const otherRoute = await product('other', { allowCustomQty: true });
  await route(otherRoute.id, 'RESELLER_STARS', 1);
  await route(otherRoute.id, 'FRAGMENT', 2);

  return {
    categoryId: category.id,
    starsId: stars.id,
    premiumId: premium.id,
    premiumSkus,
    inactiveId: inactive.id,
    otherRouteId: otherRoute.id,
  };
}

async function deleteFixtures(prisma: PrismaClient, f: Fixtures): Promise<void> {
  const productId = { in: [f.starsId, f.premiumId, f.inactiveId, f.otherRouteId] };
  await prisma.costSnapshot.deleteMany({ where: { productId } });
  await prisma.productRoute.deleteMany({ where: { productId } });
  await prisma.sku.deleteMany({ where: { productId } });
  await prisma.product.deleteMany({ where: { id: productId } });
  await prisma.category.delete({ where: { id: f.categoryId } });
}

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

    const result = await moduleRef.get(FxSyncService).run();

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

    const result = await moduleRef.get(FxSyncService).run();

    expect(result).toEqual({ written: ['TON_USDT'], skipped: ['USDT_UZS'] });
    expect((await latest('USDT_UZS'))?.id).toBe(anchorRow.id);
    expect((await latest('TON_UZS'))?.id).toBe(tonUzsBefore?.id);
  });

  it('with FULFILLMENT_DRY_RUN=false nothing is written', async () => {
    const live = await syncModule({ ...env, FULFILLMENT_DRY_RUN: false });
    try {
      const fxBefore = await prisma.fxRate.count();
      const costBefore = await prisma.costSnapshot.count();

      expect((await live.get(FxSyncService).run()).written).toEqual([]);
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
      const worker = await Test.createTestingModule({
        imports: [WorkerModule.register(env)],
      }).compile();
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
