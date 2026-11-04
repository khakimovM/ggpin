import { createPrismaClient, type PrismaClient } from '@repo/db';
import { QUEUES } from '@repo/shared';
import { Queue } from 'bullmq';
import type { Env } from '../../config/env';

/** FxRate.source of rows the e2e suites insert themselves (baselines, jump-guard anchors). */
export const E2E_FX_SOURCE = 'e2e-fixture';

/**
 * Lower bound for "rows this suite wrote". createdAt defaults are not one transaction time (rows
 * of one transaction differ by milliseconds) and the clock that sets them may differ slightly
 * from this process's, so the bound goes a minute back. Runs are serialised by the e2e lock, so
 * anything matched in that minute is a leftover of this or the previous suite's sync rows.
 */
export function cleanupSince(): Date {
  return new Date(Date.now() - 60_000);
}

/**
 * Removes the price-sync queue (jobs AND schedulers) from the e2e Redis DB (15), so a later
 * suite that boots WorkerModule does not inherit scheduled runs. Never touches DB 0.
 */
export async function resetPriceSyncQueue(env: Env): Promise<void> {
  const queue = new Queue(QUEUES.PRICE_SYNC, { connection: { url: env.REDIS_URL } });
  try {
    await queue.obliterate({ force: true });
  } finally {
    await queue.close();
  }
}

/**
 * Deletes the price rows a worker boot or a sync run wrote into the shared ggpin_test database
 * since `since`: simulator/derived/fixture FxRates and simulator CostSnapshots that nothing
 * references. Leaving them would change "latest rate" for the next suite (and a CostSnapshot
 * would block another suite from deleting its product: the FK is RESTRICT). Runs are serialised
 * by the e2e lock, so rows newer than `since` are this suite's own.
 */
export async function deleteSyncedPriceRows(prisma: PrismaClient, since: Date): Promise<void> {
  await prisma.costSnapshot.deleteMany({
    where: { createdAt: { gte: since }, source: 'simulator', quotes: { none: {} } },
  });
  await prisma.fxRate.deleteMany({
    where: {
      createdAt: { gte: since },
      OR: [
        { source: 'simulator' },
        { source: { startsWith: 'derived:' } },
        { source: E2E_FX_SOURCE },
      ],
      quotes: { none: {} },
      orders: { none: {} },
    },
  });
}

/** For suites that boot WorkerModule without caring about prices (e.g. queue.e2e-spec). */
export async function cleanUpPriceSync(env: Env, since: Date): Promise<void> {
  await resetPriceSyncQueue(env);
  const prisma = createPrismaClient(env.DATABASE_URL);
  try {
    await deleteSyncedPriceRows(prisma, since);
  } finally {
    await prisma.$disconnect();
  }
}
