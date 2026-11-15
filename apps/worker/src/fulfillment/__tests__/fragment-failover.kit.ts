import { QUEUES } from '@repo/shared';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import {
  clearFragmentState,
  removeFragmentAlerts,
} from '../../adapters/fragment/__tests__/fragment-e2e.harness';
import { FragmentKeepaliveService } from '../../adapters/fragment/fragment-keepalive.service';
import { FragmentPageScript } from '../../adapters/fragment/fragment-probe';
import { RESELLER_STARS_ADAPTER } from '../../adapters/simulator/simulated-reseller.adapter';
import type { OrderFixture, OrderOptions } from './fulfill-e2e.fixtures';
import type { BootOptions, FulfillE2e, FulfillInstance } from './fulfill-e2e.harness';

// Shared by the Fragment failover suites (phase 5 S7): a synthetic Fragment page the dry-run
// keep-alive looks at, the FragmentSession table and Redis `fragment:health` cleared around every
// test (process-wide state), and the steps the suites repeat. Nothing leaves the process.

export function useFailoverKit(t: FulfillE2e) {
  const pages = new FragmentPageScript();
  const state = {} as { redis: Redis; notify: Queue };

  beforeAll(() => {
    state.redis = new Redis(t.env.REDIS_URL);
    state.notify = new Queue(QUEUES.NOTIFY, { connection: { url: t.env.REDIS_URL } });
  });

  beforeEach(async () => {
    pages.set('LOGGED_IN');
    await clearFragmentState(t.db, state.redis);
    await removeFragmentAlerts(state.notify);
  });

  afterAll(async () => {
    await clearFragmentState(t.db, state.redis);
    await removeFragmentAlerts(state.notify);
    await state.notify.close();
    state.redis.disconnect();
  });

  /** A worker with the Fragment keep-alive on the synthetic page (no consumer, no schedule). */
  const boot = (extra: Omit<BootOptions, 'fragmentPages'> = {}) =>
    t.boot({ ...extra, fragmentPages: pages });

  /** A session that logged in once, then two logged-out looks: DEAD (and one alert). */
  async function sessionDies(instance: FulfillInstance): Promise<void> {
    // The dry-run probe never opens the blob (plan §8): a placeholder is enough.
    await t.db.fragmentSession.create({ data: { cookiesEnc: 'synthetic-blob', status: 'ACTIVE' } });
    const keepalive = instance.moduleRef.get(FragmentKeepaliveService);
    await expect(keepalive.tick()).resolves.toBe('OK');
    pages.set('LOGGED_OUT');
    await expect(keepalive.tick()).resolves.toBe('FAILING');
    await expect(keepalive.tick()).resolves.toBe('DEAD');
  }

  /** A Stars product routed FRAGMENT first, RESELLER_STARS second, with a paid order. */
  async function starsOrder(options: OrderOptions): Promise<OrderFixture> {
    const fixture = await t.order({ ...options, routeAdapter: 'FRAGMENT' });
    await t.db.productRoute.create({
      data: { productId: fixture.productId, adapter: RESELLER_STARS_ADAPTER, priority: 2 },
    });
    return fixture;
  }

  const run = (instance: FulfillInstance, orderId: string, finalAttempt = false) =>
    instance.service.run(orderId, { finalAttempt });

  return {
    pages,
    boot,
    sessionDies,
    starsOrder,
    run,
    get redis() {
      return state.redis;
    },
    get notify() {
      return state.notify;
    },
  };
}
