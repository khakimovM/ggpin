import type { AdapterHealth } from '@repo/shared';
import { SimulatedFragmentAdapter } from '../../adapters/simulator/simulated-fragment.adapter';
import { RESELLER_STARS_ADAPTER } from '../../adapters/simulator/simulated-reseller.adapter';
import { guardNetwork } from '../../recipients/__tests__/net-guard';
import { stubAdapter } from '../../recipients/__tests__/recipient-test-doubles';
import { PAST_VALID_SEC, SIGN_AT_SEC, pinChain } from '../../ton/__tests__/ton-e2e.harness';
import { AdapterRouter } from '../adapter-router';
import { useFailoverKit } from './fragment-failover.kit';
import { attemptsOf, orderRow } from './fulfill-e2e.fixtures';
import { useFulfillE2e } from './fulfill-e2e.harness';

// An order that already has an attempt stays on that attempt's adapter (rules/45 step 2, CR m6;
// phase 5 S7): an unresolved attempt is only followed, and even an attempt PROVEN not sent does
// not move the order to another adapter, of another currency (Fragment -> the USDT backup) or of
// the SAME currency (review M3: the core passes the attempt's adapter to the router). Real
// Postgres + Redis DB 15; nothing leaves the process.

const t = useFulfillE2e();
const kit = useFailoverKit(t);
const net = guardNetwork([t.env.DATABASE_URL, t.env.REDIS_URL]);
const DIED = 'the worker died here';
const die = (): Promise<void> => Promise.reject(new Error(DIED));

afterEach(() => net.expectNoOutsideAccess());

describe('an order that already has a Fragment attempt stays on Fragment (rules/45, CR m6)', () => {
  it('an UNRESOLVED attempt (died after SENDING) is only followed, never moved to the backup', async () => {
    pinChain(t.gateway, 0);
    const fixture = await kit.starsOrder({});
    const first = await kit.boot();
    first.hooks.afterSendingFn = die;
    await expect(kit.run(first, fixture.orderId)).rejects.toThrow(DIED);
    await t.kill(first);

    const second = await kit.boot();
    await kit.sessionDies(second);
    expect((await second.moduleRef.get(AdapterRouter).pick(fixture.productId, null))?.code).toBe(
      RESELLER_STARS_ADAPTER,
    );
    await kit.run(second, fixture.orderId);
    const attempts = await attemptsOf(t.db, fixture.orderId);
    expect(attempts.map((a) => [a.attemptNo, a.adapter])).toEqual([[1, 'FRAGMENT']]);
    expect(t.executedOnChain()).toBeLessThanOrEqual(1);
  });

  it('an attempt PROVEN not sent (EXPIRED) does not move either: HELD, NO_ADAPTER', async () => {
    pinChain(t.gateway, SIGN_AT_SEC);
    const fixture = await kit.starsOrder({});
    const first = await kit.boot();
    first.tonHooks.afterStoredFn = die;
    await expect(kit.run(first, fixture.orderId)).rejects.toThrow(DIED);
    await t.kill(first);

    const second = await kit.boot();
    await kit.sessionDies(second);
    // The backup is healthy, but this order's attempts are Fragment's: no adapter for it.
    const router = second.moduleRef.get(AdapterRouter);
    expect((await router.pick(fixture.productId, null))?.code).toBe(RESELLER_STARS_ADAPTER);
    expect(await router.pick(fixture.productId, 'FRAGMENT')).toBeNull();
    pinChain(t.gateway, PAST_VALID_SEC);
    await kit.run(second, fixture.orderId);
    expect(await orderRow(t.db, fixture.orderId)).toEqual(
      expect.objectContaining({ status: 'HELD', statusReason: 'NO_ADAPTER' }),
    );
    const attempts = await attemptsOf(t.db, fixture.orderId);
    expect(attempts.map((a) => [a.attemptNo, a.adapter, a.status])).toEqual([
      [1, 'FRAGMENT', 'FAILED'],
    ]);
    expect(t.executedOnChain()).toBe(0);
  });
});

describe('review M3: the attempt adapter wins over a healthy adapter of the SAME currency', () => {
  it('A proven not sent and DOWN, B (also TON) healthy: HELD NO_ADAPTER, B never touched', async () => {
    let fragmentHealth: AdapterHealth = 'OK';
    const fragment = new SimulatedFragmentAdapter(t.env, t.script, () =>
      Promise.resolve(fragmentHealth),
    );
    const twinValidate = jest.fn(() => Promise.resolve({ status: 'NOT_FOUND' }));
    const twinHealth = jest.fn(() => Promise.resolve<AdapterHealth>('OK'));
    const twin = stubAdapter('TWIN_TON', {
      costCurrency: 'TON',
      validate: twinValidate,
      health: twinHealth,
    });
    const adapters = new Map([
      ['FRAGMENT', fragment],
      ['TWIN_TON', twin],
    ]);
    pinChain(t.gateway, SIGN_AT_SEC);
    const fixture = await t.order({}); // TON, FRAGMENT route and FRAGMENT-issued handle
    await t.db.productRoute.create({
      data: { productId: fixture.productId, adapter: 'TWIN_TON', priority: 2 },
    });
    const first = await kit.boot({ adapters });
    first.tonHooks.afterStoredFn = die;
    await expect(kit.run(first, fixture.orderId)).rejects.toThrow(DIED);
    await t.kill(first);

    fragmentHealth = 'DOWN';
    const second = await kit.boot({ adapters });
    // For a new TON order the twin would be chosen: the router itself is not what stops it.
    const router = second.moduleRef.get(AdapterRouter);
    expect((await router.pick(fixture.productId, null, null, 'TON'))?.code).toBe('TWIN_TON');
    pinChain(t.gateway, PAST_VALID_SEC);
    await kit.run(second, fixture.orderId);
    expect(await orderRow(t.db, fixture.orderId)).toEqual(
      expect.objectContaining({ status: 'HELD', statusReason: 'NO_ADAPTER' }),
    );
    const attempts = await attemptsOf(t.db, fixture.orderId);
    expect(attempts.map((a) => [a.attemptNo, a.adapter, a.status])).toEqual([
      [1, 'FRAGMENT', 'FAILED'],
    ]);
    expect(twinValidate).not.toHaveBeenCalled();
    expect(t.executedOnChain()).toBe(0);
  });
});
