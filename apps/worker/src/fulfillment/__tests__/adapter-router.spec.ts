import type { AdapterHealth, CostCurrency } from '@repo/shared';
import type { FulfillmentAdapter } from '../../adapters/fulfillment-adapter';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import { AdapterRouter, HEALTH_CACHE_MS, HEALTH_TIMEOUT_MS } from '../adapter-router';

/** RESELLER_STARS charges USDT (like its simulator); every other code here charges TON. */
function adapter(
  code: string,
  health: () => Promise<AdapterHealth>,
  costCurrency: CostCurrency = code === 'RESELLER_STARS' ? 'USDT' : 'TON',
): FulfillmentAdapter {
  const unused = () => Promise.reject(new Error('not used by the router'));
  return {
    code,
    costCurrency,
    health,
    validateRecipient: unused,
    quote: unused,
    prepare: unused,
    send: unused,
    confirm: unused,
    getBalance: unused,
  };
}

function routerWith(routes: string[], adapters: FulfillmentAdapter[]) {
  const findMany = jest.fn(() => Promise.resolve(routes.map((code) => ({ adapter: code }))));
  const prisma = { client: { productRoute: { findMany } } };
  const router = new AdapterRouter(
    prisma as unknown as PrismaService,
    new Map(adapters.map((a) => [a.code, a])),
  );
  router['logger'].warn = jest.fn();
  return { router, findMany };
}

const ok = () => Promise.resolve<AdapterHealth>('OK');
const down = () => Promise.resolve<AdapterHealth>('DOWN');

describe('AdapterRouter', () => {
  it('the first enabled route (by priority) whose adapter is registered and healthy', async () => {
    const { router, findMany } = routerWith(
      ['GONE', 'FRAGMENT', 'RESELLER_STARS'],
      [adapter('FRAGMENT', down), adapter('RESELLER_STARS', ok)],
    );
    expect((await router.pick('p1', null))?.code).toBe('RESELLER_STARS');
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { productId: 'p1', isEnabled: true } }),
    );
  });

  it('an order that had an attempt keeps that adapter, or gets none', async () => {
    const { router } = routerWith(
      ['FRAGMENT', 'RESELLER_STARS'],
      [adapter('FRAGMENT', down), adapter('RESELLER_STARS', ok)],
    );
    expect(await router.pick('p1', 'FRAGMENT')).toBeNull();
    expect((await router.pick('p1', 'RESELLER_STARS'))?.code).toBe('RESELLER_STARS');
  });

  it('a health check that throws or says DEGRADED does not route', async () => {
    const { router } = routerWith(
      ['FRAGMENT', 'RESELLER_STARS'],
      [
        adapter('FRAGMENT', () => Promise.reject(new Error('timeout'))),
        adapter('RESELLER_STARS', () => Promise.resolve<AdapterHealth>('DEGRADED')),
      ],
    );
    expect(await router.pick('p1', null)).toBeNull();
    expect(router.adapterOf('FRAGMENT')?.code).toBe('FRAGMENT');
    expect(router.adapterOf('NOPE')).toBeNull();
  });

  it('CR m6: an order with a proven-not-sent attempt never moves, even to a healthy backup', async () => {
    const { router } = routerWith(
      ['FRAGMENT', 'RESELLER_STARS'],
      [adapter('FRAGMENT', down), adapter('RESELLER_STARS', ok)],
    );
    // The issuer preference never overrides the attempt's adapter.
    expect(await router.pick('p1', 'FRAGMENT', 'RESELLER_STARS')).toBeNull();
  });

  it('CR #2: the issuer of the recipient handle goes first when enabled and healthy', async () => {
    const { router } = routerWith(
      ['FRAGMENT', 'RESELLER_STARS'],
      [adapter('FRAGMENT', ok), adapter('RESELLER_STARS', ok)],
    );
    expect((await router.pick('p1', null, 'RESELLER_STARS'))?.code).toBe('RESELLER_STARS');
    expect((await router.pick('p1', null, 'FRAGMENT'))?.code).toBe('FRAGMENT');
    // Not a route of this product: priority order, never a route that is not enabled.
    expect((await router.pick('p1', null, 'FAZERCARDS'))?.code).toBe('FRAGMENT');
  });

  it('CR #2: an unhealthy issuer falls back to the next route by priority', async () => {
    const { router } = routerWith(
      ['FRAGMENT', 'RESELLER_STARS'],
      [adapter('FRAGMENT', down), adapter('RESELLER_STARS', ok)],
    );
    expect((await router.pick('p1', null, 'FRAGMENT'))?.code).toBe('RESELLER_STARS');
  });

  it('M1: an order is offered only to adapters of its cost currency, before anything is asked', async () => {
    const fragmentHealth = jest.fn(down);
    const resellerHealth = jest.fn(ok);
    const { router } = routerWith(
      ['FRAGMENT', 'RESELLER_STARS'],
      [adapter('FRAGMENT', fragmentHealth), adapter('RESELLER_STARS', resellerHealth)],
    );
    // A TON order with Fragment DOWN: nobody, and the USDT reseller is not even asked.
    expect(await router.pick('p1', null, null, 'TON')).toBeNull();
    expect(resellerHealth).not.toHaveBeenCalled();
    // A recipient check (no order, no currency) gets the healthy backup.
    expect((await router.pick('p1', null))?.code).toBe('RESELLER_STARS');
    expect((await router.pick('p1', null, null, 'USDT'))?.code).toBe('RESELLER_STARS');
  });

  it('M1: the issuer preference works only inside the currency (a USDT issuer, a TON order)', async () => {
    const { router } = routerWith(
      ['FRAGMENT', 'RESELLER_STARS'],
      [adapter('FRAGMENT', ok), adapter('RESELLER_STARS', ok)],
    );
    expect((await router.pick('p1', null, 'RESELLER_STARS', 'TON'))?.code).toBe('FRAGMENT');
    expect((await router.pick('p1', null, 'FRAGMENT', 'USDT'))?.code).toBe('RESELLER_STARS');
    // Two adapters of one currency: the issuer goes first among them.
    const twins = routerWith(
      ['FRAGMENT', 'TWIN'],
      [adapter('FRAGMENT', ok), adapter('TWIN', ok, 'TON')],
    );
    expect((await twins.router.pick('p1', null, 'TWIN', 'TON'))?.code).toBe('TWIN');
    // The attempt's adapter in another currency than the order: nothing (never cross-currency).
    expect(await router.pick('p1', 'RESELLER_STARS', null, 'TON')).toBeNull();
  });

  it('isHealthy: the cached health of a registered adapter; an unknown code is not healthy', async () => {
    const health = jest.fn(ok);
    const { router } = routerWith(
      [],
      [adapter('FRAGMENT', health), adapter('RESELLER_STARS', down)],
    );
    await expect(router.isHealthy('FRAGMENT')).resolves.toBe(true);
    await expect(router.isHealthy('FRAGMENT')).resolves.toBe(true);
    expect(health).toHaveBeenCalledTimes(1);
    await expect(router.isHealthy('RESELLER_STARS')).resolves.toBe(false);
    await expect(router.isHealthy('NOPE')).resolves.toBe(false);
  });

  it('I-1: health is asked once per HEALTH_CACHE_MS, again after it, and at once after forgetHealth', async () => {
    let now = 5_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const health = jest.fn(ok);
    const { router } = routerWith(['FRAGMENT'], [adapter('FRAGMENT', health)]);
    await router.pick('p1', null);
    await router.pick('p1', null);
    now += HEALTH_CACHE_MS - 1;
    await router.pick('p1', null);
    expect(health).toHaveBeenCalledTimes(1);
    now += 1;
    await router.pick('p1', null);
    expect(health).toHaveBeenCalledTimes(2);
    router.forgetHealth('FRAGMENT');
    await router.pick('p1', null);
    expect(health).toHaveBeenCalledTimes(3);
    jest.restoreAllMocks();
  });

  it('I-1: a cached DOWN keeps routing away; a hanging health() is DOWN after HEALTH_TIMEOUT_MS', async () => {
    jest.useFakeTimers();
    try {
      const hanging = jest.fn(() => new Promise<AdapterHealth>(() => undefined));
      const { router } = routerWith(
        ['FRAGMENT', 'RESELLER_STARS'],
        [adapter('FRAGMENT', hanging), adapter('RESELLER_STARS', ok)],
      );
      const picked = router.pick('p1', null);
      await jest.advanceTimersByTimeAsync(HEALTH_TIMEOUT_MS);
      expect((await picked)?.code).toBe('RESELLER_STARS');
      expect((await router.pick('p1', null))?.code).toBe('RESELLER_STARS');
      expect(hanging).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
