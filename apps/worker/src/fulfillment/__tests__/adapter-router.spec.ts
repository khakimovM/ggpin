import type { AdapterHealth } from '@repo/shared';
import type { FulfillmentAdapter } from '../../adapters/fulfillment-adapter';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import { AdapterRouter } from '../adapter-router';

function adapter(code: string, health: () => Promise<AdapterHealth>): FulfillmentAdapter {
  const unused = () => Promise.reject(new Error('not used by the router'));
  return {
    code,
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
});
