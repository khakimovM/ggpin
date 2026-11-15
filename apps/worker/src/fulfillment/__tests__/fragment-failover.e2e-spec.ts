import {
  captureLogs,
  fragmentAlerts,
} from '../../adapters/fragment/__tests__/fragment-e2e.harness';
import { FragmentKeepaliveService } from '../../adapters/fragment/fragment-keepalive.service';
import { namespacedProviderRef } from '../../adapters/provider-ref';
import {
  RESELLER_STARS_ADAPTER,
  SimulatedResellerAdapter,
} from '../../adapters/simulator/simulated-reseller.adapter';
import { simulatedProviderRef } from '../../adapters/simulator/simulator-script';
import { CostSyncService } from '../../pricing-sync/cost-sync.service';
import { FxSyncService } from '../../pricing-sync/fx-sync.service';
import { guardNetwork } from '../../recipients/__tests__/net-guard';
import { AdapterRouter } from '../adapter-router';
import { RECHECKED_REF_KEY } from '../fulfill-recipient';
import { useFailoverKit } from './fragment-failover.kit';
import { STARS, attemptsOf, ledgerOf, orderRow } from './fulfill-e2e.fixtures';
import { useFulfillE2e } from './fulfill-e2e.harness';
import { orderAtCurrentPrice, starsProduct } from './fulfill-e2e.quote';

// Acceptance criterion 5 (plan §1, phase 5 S7, review M1/M2): the dry-run keep-alive sees a
// logged-out (synthetic) Fragment page twice -> the session is DEAD and the owner gets ONE
// fragmentSessionDead -> the cost sync prices the product from its healthy backup (USDT) -> a new
// order at that price is delivered by RESELLER_STARS. Orders priced in TON wait (HELD) instead of
// going to a provider that cannot pay them. Real Postgres + Redis DB 15; nothing leaves the
// process (network guard, audit I-6). Orders that already have an attempt:
// fragment-failover-attempts.e2e-spec.ts.

const t = useFulfillE2e();
const kit = useFailoverKit(t);
const net = guardNetwork([t.env.DATABASE_URL, t.env.REDIS_URL]);

// Only this file's own spies are restored: jest.restoreAllMocks would lift the network guard too.
const spies: jest.SpyInstance[] = [];

type FakeTimerConfig = NonNullable<Parameters<typeof jest.useFakeTimers>[0]>;
/** Every fakeable API except Date: the clock moves, timers and ticks stay real. */
const REAL_TIMERS: NonNullable<Extract<FakeTimerConfig, { doNotFake?: unknown }>['doNotFake']> = [
  'hrtime',
  'nextTick',
  'performance',
  'queueMicrotask',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'requestIdleCallback',
  'cancelIdleCallback',
  'setImmediate',
  'clearImmediate',
  'setInterval',
  'clearInterval',
  'setTimeout',
  'clearTimeout',
];

function resellerSpies() {
  const validate = jest.spyOn(SimulatedResellerAdapter.prototype, 'validateRecipient');
  const prepare = jest.spyOn(SimulatedResellerAdapter.prototype, 'prepare');
  spies.push(validate, prepare);
  return { validate, prepare };
}

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  net.expectNoOutsideAccess();
});

const newestSnapshot = (productId: string) =>
  t.db.costSnapshot.findFirstOrThrow({
    where: { productId, skuId: null },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { adapter: true, currency: true },
  });

describe('criterion 5 end to end: Fragment dies, the backup prices and delivers', () => {
  it('DEAD + one alert -> cost sync prices RESELLER_STARS (USDT) -> a new order -> DELIVERED', async () => {
    const logs = captureLogs();
    const instance = await kit.boot({ pricing: true });
    const product = await starsProduct(t.db);
    try {
      const router = instance.moduleRef.get(AdapterRouter);
      const costSync = instance.moduleRef.get(CostSyncService);
      await instance.moduleRef.get(FxSyncService).run(new Date());
      // Alive: priced from Fragment, in TON.
      await costSync.run();
      await expect(newestSnapshot(product.id)).resolves.toEqual({
        adapter: 'FRAGMENT',
        currency: 'TON',
      });

      await kit.sessionDies(instance);
      const alerts = await fragmentAlerts(kit.notify);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ kind: 'OWNER_ALERT', alert: 'fragmentSessionDead' });
      await expect(kit.redis.get('fragment:health')).resolves.toBe('down');

      // The next cost sync prices from the first HEALTHY route: the backup, in USDT.
      await costSync.run();
      await expect(newestSnapshot(product.id)).resolves.toEqual({
        adapter: RESELLER_STARS_ADAPTER,
        currency: 'USDT',
      });

      // The recipient check (what RecipientLookupService does: the router, then the adapter).
      const picked = await router.pick(product.id, null);
      expect(picked?.code).toBe(RESELLER_STARS_ADAPTER);
      if (picked === null) throw new Error('no adapter');
      const username = `fo${Date.now().toString(36)}`;
      const check = await picked.validateRecipient(
        product,
        { username },
        new AbortController().signal,
      );
      if (check.status !== 'FOUND') throw new Error(`recipient ${check.status}`);

      // The quote and the order at the current price (fulfill-e2e.quote.ts says what is assumed).
      const order = await orderAtCurrentPrice(t.db, {
        productId: product.id,
        quantity: STARS,
        recipient: { username, displayName: check.displayName },
        providerRef: namespacedProviderRef(picked.code, check.providerRef),
      });
      t.track(order.orderId);
      expect(order).toMatchObject({
        costCurrency: 'USDT',
        snapshotAdapter: RESELLER_STARS_ADAPTER,
      });

      await expect(kit.run(instance, order.orderId)).resolves.toBe('DONE');
      expect((await orderRow(t.db, order.orderId)).status).toBe('DELIVERED');
      const attempts = await attemptsOf(t.db, order.orderId);
      expect(attempts.map((a) => [a.adapter, a.status])).toEqual([
        [RESELLER_STARS_ADAPTER, 'CONFIRMED'],
      ]);
      expect(t.executedOnChain()).toBe(0);
      // The keep-alive went on looking: still one alert for this one death.
      await instance.moduleRef.get(FragmentKeepaliveService).tick();
      expect(await fragmentAlerts(kit.notify)).toHaveLength(1);
    } finally {
      logs.restore();
      // Inactive again: later cost syncs of the shared test database leave it alone.
      await t.db.product.update({ where: { id: product.id }, data: { isActive: false } });
    }
    expect(logs.lines.join('\n')).not.toMatch(/synthetic-blob|abc123abc123|<html/);
  });
});

describe('the switch-over window: an order priced in TON before the death (review M1)', () => {
  it.each([
    ['NOT_FOUND', false],
    ['OK', false],
    ['UNKNOWN', true],
  ] as const)(
    'backup would answer %s (last try: %s): HELD NO_ADAPTER, the backup is never asked',
    async (scenario, finalAttempt) => {
      const { validate, prepare } = resellerSpies();
      const instance = await kit.boot();
      const fixture = await kit.starsOrder({}); // FRAGMENT-priced (TON), FRAGMENT-issued handle
      await kit.sessionDies(instance);
      t.script.setDefault(scenario);
      await expect(kit.run(instance, fixture.orderId, finalAttempt)).resolves.toBe('DONE');
      expect(await orderRow(t.db, fixture.orderId)).toEqual(
        expect.objectContaining({ status: 'HELD', statusReason: 'NO_ADAPTER' }),
      );
      expect(validate).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
      expect((await ledgerOf(t.db, fixture.orderId)).map((l) => l.kind)).toEqual(['PURCHASE']);
      expect(await attemptsOf(t.db, fixture.orderId)).toHaveLength(0);
      const held = await t.db.orderEvent.findFirstOrThrow({
        where: { orderId: fixture.orderId, to: 'HELD' },
      });
      expect(held.note).toContain('no healthy TON route');
    },
  );

  it('a TON order whose handle the backup issued, Fragment healthy: Fragment re-checks and delivers', async () => {
    const { prepare } = resellerSpies();
    const instance = await kit.boot();
    const fixture = await kit.starsOrder({ issuer: RESELLER_STARS_ADAPTER });
    await expect(kit.run(instance, fixture.orderId)).resolves.toBe('DONE');
    expect((await orderRow(t.db, fixture.orderId)).status).toBe('DELIVERED');
    expect(prepare).not.toHaveBeenCalled();
    const order = await t.db.order.findUniqueOrThrow({ where: { id: fixture.orderId } });
    const username = String(Reflect.get(Object(order.recipient), 'username'));
    const [attempt] = await attemptsOf(t.db, fixture.orderId);
    expect(attempt?.adapter).toBe('FRAGMENT');
    expect(Reflect.get(Object(attempt?.request), RECHECKED_REF_KEY)).toBe(
      namespacedProviderRef('FRAGMENT', simulatedProviderRef(username)),
    );
    expect(t.executedOnChain()).toBe(1);
  });
});

describe('a USDT order whose handle Fragment issued, Fragment DEAD (CR #2)', () => {
  it('the backup checks the recipient again before anything moves, then delivers', async () => {
    const instance = await kit.boot();
    const fixture = await kit.starsOrder({ adapter: RESELLER_STARS_ADAPTER, issuer: 'FRAGMENT' });
    await kit.sessionDies(instance);
    await expect(kit.run(instance, fixture.orderId)).resolves.toBe('DONE');
    expect((await orderRow(t.db, fixture.orderId)).status).toBe('DELIVERED');
    const order = await t.db.order.findUniqueOrThrow({ where: { id: fixture.orderId } });
    const username = String(Reflect.get(Object(order.recipient), 'username'));
    const [attempt] = await attemptsOf(t.db, fixture.orderId);
    expect(attempt?.adapter).toBe(RESELLER_STARS_ADAPTER);
    expect(Reflect.get(Object(attempt?.request), RECHECKED_REF_KEY)).toBe(
      namespacedProviderRef(RESELLER_STARS_ADAPTER, simulatedProviderRef(username)),
    );
  });

  it('the backup does not find that recipient: FAILED + REFUND (RECIPIENT_CHANGED)', async () => {
    const instance = await kit.boot();
    const fixture = await kit.starsOrder({ adapter: RESELLER_STARS_ADAPTER, issuer: 'FRAGMENT' });
    await kit.sessionDies(instance);
    t.script.setDefault('NOT_FOUND');
    await expect(kit.run(instance, fixture.orderId)).resolves.toBe('DONE');
    expect(await orderRow(t.db, fixture.orderId)).toEqual(
      expect.objectContaining({ status: 'REFUNDED', statusReason: 'RECIPIENT_CHANGED' }),
    );
    expect((await ledgerOf(t.db, fixture.orderId)).map((l) => l.kind).sort()).toEqual([
      'PURCHASE',
      'REFUND',
    ]);
    expect(await attemptsOf(t.db, fixture.orderId)).toHaveLength(0);
  });

  it('L-1: an order confirmed more than RECHECK_MAX_AGE_MS ago is HELD, the backup not asked', async () => {
    const { validate } = resellerSpies();
    const instance = await kit.boot();
    const fixture = await kit.starsOrder({ adapter: RESELLER_STARS_ADAPTER, issuer: 'FRAGMENT' });
    await kit.sessionDies(instance);
    // The database stamps Order.createdAt itself (insert guard, immutable after), so the order
    // cannot be made old: the worker's WHOLE clock is moved two hours on instead (an order:retry
    // hours later). Only Date is faked — both Date.now() and `new Date()` (S7 re-review N1: a
    // Date.now spy alone let a `confirmedAt: new Date()` mutant through); timers stay real so
    // Prisma, Redis and BullMQ run as usual.
    jest.useFakeTimers({ now: Date.now() + 2 * 3_600_000, doNotFake: REAL_TIMERS });
    try {
      await expect(kit.run(instance, fixture.orderId)).resolves.toBe('DONE');
    } finally {
      jest.useRealTimers();
    }
    expect(await orderRow(t.db, fixture.orderId)).toEqual(
      expect.objectContaining({ status: 'HELD', statusReason: 'ADAPTER_ERROR' }),
    );
    expect(validate).not.toHaveBeenCalled();
    expect(await attemptsOf(t.db, fixture.orderId)).toHaveLength(0);
    const held = await t.db.orderEvent.findFirstOrThrow({
      where: { orderId: fixture.orderId, to: 'HELD' },
    });
    expect(held.note).toContain('too old for a name-only re-check');
  });
});
