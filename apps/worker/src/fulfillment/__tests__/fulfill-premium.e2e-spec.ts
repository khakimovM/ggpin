import type { NotifyJob } from '@repo/shared';
import { SIMULATED_PREMIUM_NANO_TON } from '../../adapters/simulator/simulated-fragment-prices';
import { SIMULATED_FRAGMENT_PAY_ADDRESS } from '../../adapters/simulator/simulator-script';
import { PAST_VALID_SEC, SIGN_AT_SEC, pinChain } from '../../ton/__tests__/ton-e2e.harness';
import { attemptsOf, ledgerOf, orderRow, timelineOf, transfersOf } from './fulfill-e2e.fixtures';
import { useFulfillE2e } from './fulfill-e2e.harness';
import {
  PREMIUM_NANO,
  RecordingFragment,
  premiumOrder,
  requestedAddress,
  requestedNano,
  type PremiumOrderFixture,
} from './premium-e2e.fixtures';

// Phase 6 S2 (plan §1 criterion 1, §3 P6-S2): Telegram Premium through the real fulfill-order run
// (real Postgres + Redis, the simulated Fragment, the in-memory chain, FULFILLMENT_DRY_RUN=true).
// The product is the `telegram-premium` slug with a 3/6/12 month SKU; the order's quantity is the
// term in months. Every payout is exactly the simulated price of THAT term, the core hands the
// order's SKU and months to `prepare`, and the Stars safeguards hold for Premium unchanged: price
// above the stored ceiling -> HELD, an unknown TON outcome -> NEEDS_REVIEW, the per-order limit ->
// HELD, a worker dying mid-payout never pays twice.

const t = useFulfillE2e();

async function order(months: 3 | 6 | 12): Promise<PremiumOrderFixture> {
  const fixture = await premiumOrder(t.db, months);
  t.track(fixture.orderId);
  return fixture;
}

async function expectJobs(jobs: readonly NotifyJob[]): Promise<void> {
  for (const job of jobs)
    expect({ job, queued: await t.hasJob(job) }).toEqual({ job, queued: true });
}

const purchaseOnly = (fixture: PremiumOrderFixture) => [
  { kind: 'PURCHASE', amountTiyin: -fixture.priceTiyin },
];

/** A replayed job changed nothing: same status, the PURCHASE alone, still one transfer. */
async function replayChangedNothing(fixture: PremiumOrderFixture, status: string): Promise<void> {
  expect((await orderRow(t.db, fixture.orderId)).status).toBe(status);
  expect(await ledgerOf(t.db, fixture.orderId)).toEqual(purchaseOnly(fixture));
  expect(await transfersOf(t.db, fixture.orderId)).toHaveLength(1);
}

describe('fulfill-order: Telegram Premium terms are delivered at their own price', () => {
  it('the test prices are the simulator table (3.75 / 5 / 9.1 TON)', () => {
    expect([...SIMULATED_PREMIUM_NANO_TON.entries()]).toEqual([
      [3, PREMIUM_NANO[3]],
      [6, PREMIUM_NANO[6]],
      [12, PREMIUM_NANO[12]],
    ]);
  });

  it.each([3, 6, 12] as const)(
    '%i months: DELIVERED, one payout of exactly that term, prepare got the SKU and months',
    async (months) => {
      pinChain(t.gateway, 0);
      const fragment = new RecordingFragment(t.env, t.script);
      const worker = await t.boot({ adapters: new Map([['FRAGMENT', fragment]]) });
      const fixture = await order(months);
      await expect(worker.service.run(fixture.orderId, { finalAttempt: false })).resolves.toBe(
        'DONE',
      );

      const stored = await t.db.order.findUniqueOrThrow({
        where: { id: fixture.orderId },
        select: { status: true, quantity: true, skuId: true, deliveredAt: true },
      });
      expect(stored).toEqual(
        expect.objectContaining({ status: 'DELIVERED', quantity: months, skuId: fixture.skuId }),
      );
      expect(stored.deliveredAt).not.toBeNull();
      expect(await timelineOf(t.db, fixture.orderId)).toEqual([
        'QUEUED',
        'PROCESSING',
        'DELIVERED',
      ]);
      // What the core handed the adapter: the Premium slug, the order's SKU and its months.
      expect(fragment.seen).toHaveLength(1);
      expect(fragment.seen[0]).toEqual(
        expect.objectContaining({
          orderId: fixture.orderId,
          product: { id: fixture.productId, slug: 'telegram-premium' },
          sku: { id: fixture.skuId, quantity: months },
        }),
      );
      const attempts = await attemptsOf(t.db, fixture.orderId);
      expect(attempts.map((a) => [a.attemptNo, a.adapter, a.status, a.costMinor])).toEqual([
        [1, 'FRAGMENT', 'CONFIRMED', PREMIUM_NANO[months]],
      ]);
      expect(requestedNano(attempts[0]?.request)).toBe(PREMIUM_NANO[months]);
      // Paid to the simulated Fragment payee only (the attempt's instruction and the transfer).
      expect(requestedAddress(attempts[0]?.request)).toBe(SIMULATED_FRAGMENT_PAY_ADDRESS);
      const transfers = await transfersOf(t.db, fixture.orderId);
      expect(transfers.map((x) => [x.status, x.amountNanoTon, x.toAddress])).toEqual([
        ['CONFIRMED', PREMIUM_NANO[months], SIMULATED_FRAGMENT_PAY_ADDRESS],
      ]);
      expect(t.executedOnChain()).toBe(1);
      expect(t.gateway.callCount('sendBoc')).toBe(1);
      expect(await ledgerOf(t.db, fixture.orderId)).toEqual(purchaseOnly(fixture));
      expect(await t.hasJob({ kind: 'ORDER_DELIVERED', refId: fixture.orderId })).toBe(true);

      // A replayed job pays nothing again.
      await expect(worker.service.run(fixture.orderId, { finalAttempt: true })).resolves.toBe(
        'REPLAYED',
      );
      await replayChangedNothing(fixture, 'DELIVERED');
      expect(t.gateway.callCount('sendBoc')).toBe(1);
      expect(t.executedOnChain()).toBe(1);
    },
  );
});

describe('fulfill-order: Telegram Premium holds and reviews like Stars', () => {
  it('Fragment asks more than the stored ceiling: HELD (PRICE_ABOVE_MAX), nothing sent', async () => {
    const fixture = await order(6);
    t.script.set(fixture.orderId, 'PRICE_UP');
    await expect(t.main.service.run(fixture.orderId, { finalAttempt: false })).resolves.toBe(
      'DONE',
    );
    expect(await orderRow(t.db, fixture.orderId)).toEqual(
      expect.objectContaining({ status: 'HELD', statusReason: 'PRICE_ABOVE_MAX' }),
    );
    expect(await attemptsOf(t.db, fixture.orderId)).toHaveLength(0);
    expect(await transfersOf(t.db, fixture.orderId)).toHaveLength(0);
    const held = await t.db.orderEvent.findFirstOrThrow({
      where: { orderId: fixture.orderId, to: 'HELD' },
      select: { id: true },
    });
    await expectJobs([
      { kind: 'ORDER_REVIEW', refId: fixture.orderId },
      { kind: 'OWNER_ALERT', alert: 'held', refId: `${fixture.orderId}_${held.id}` },
    ]);
    expect(await ledgerOf(t.db, fixture.orderId)).toEqual(purchaseOnly(fixture));
    expect(t.gateway.callCount('sendBoc')).toBe(0);
  });

  it('a TON payout whose outcome is unknown (lost, not provably expired): NEEDS_REVIEW, no refund', async () => {
    pinChain(t.gateway, 0);
    const worker = await t.boot({ timing: { confirmTimeoutMs: 1_000 } });
    const fixture = await order(12);
    t.gateway.nextSend('LOSE');
    await expect(worker.service.run(fixture.orderId, { finalAttempt: false })).resolves.toBe(
      'DONE',
    );
    expect(await orderRow(t.db, fixture.orderId)).toEqual(
      expect.objectContaining({ status: 'NEEDS_REVIEW', statusReason: 'CONFIRM_TIMEOUT' }),
    );
    const transfers = await transfersOf(t.db, fixture.orderId);
    expect(transfers.map((x) => [x.status, x.amountNanoTon])).toEqual([
      ['BROADCAST', PREMIUM_NANO[12]],
    ]);
    await expectJobs([
      { kind: 'ORDER_REVIEW', refId: fixture.orderId },
      { kind: 'OWNER_ALERT', alert: 'needsReview', refId: fixture.orderId },
    ]);
    expect(await ledgerOf(t.db, fixture.orderId)).toEqual(purchaseOnly(fixture));
    expect(t.executedOnChain()).toBe(0);
    // The retry of the job never signs a second payout for it.
    await expect(worker.service.run(fixture.orderId, { finalAttempt: true })).resolves.toBe(
      'REPLAYED',
    );
    await replayChangedNothing(fixture, 'NEEDS_REVIEW');
    expect(t.gateway.callCount('sendBoc')).toBe(1);
  });

  it('Fragment unreachable before any payment (simulator UNKNOWN): retried, then HELD, never review', async () => {
    const fixture = await order(3);
    t.script.set(fixture.orderId, 'UNKNOWN');
    await expect(t.main.service.run(fixture.orderId, { finalAttempt: false })).rejects.toThrow(
      'simulated provider outage',
    );
    await expect(t.main.service.run(fixture.orderId, { finalAttempt: true })).resolves.toBe('DONE');
    expect(await orderRow(t.db, fixture.orderId)).toEqual(
      expect.objectContaining({ status: 'HELD', statusReason: 'ADAPTER_ERROR' }),
    );
    expect(await attemptsOf(t.db, fixture.orderId)).toHaveLength(0);
    expect(await transfersOf(t.db, fixture.orderId)).toHaveLength(0);
    expect(await ledgerOf(t.db, fixture.orderId)).toEqual(purchaseOnly(fixture));
    expect(t.gateway.callCount('sendBoc')).toBe(0);
  });

  it('a per-order TON limit below the 12-month price: 12 months HELD (LIMIT_PER_ORDER), 6 months delivered', async () => {
    pinChain(t.gateway, 0);
    const limit = PREMIUM_NANO[12] - 1n;
    const worker = await t.boot({ env: { ...t.env, TON_MAX_PER_ORDER_NANO: limit } });
    const year = await order(12);
    await expect(worker.service.run(year.orderId, { finalAttempt: false })).resolves.toBe('DONE');
    expect(await orderRow(t.db, year.orderId)).toEqual(
      expect.objectContaining({ status: 'HELD', statusReason: 'LIMIT_PER_ORDER' }),
    );
    const [attempt] = await attemptsOf(t.db, year.orderId);
    expect(attempt).toEqual(
      expect.objectContaining({ status: 'FAILED', error: 'LIMIT_PER_ORDER' }),
    );
    await expectJobs([
      { kind: 'ORDER_REVIEW', refId: year.orderId },
      { kind: 'OWNER_ALERT', alert: 'held', refId: `${year.orderId}_${attempt?.id ?? ''}` },
    ]);
    expect(await transfersOf(t.db, year.orderId)).toHaveLength(0);
    expect(t.gateway.callCount('sendBoc')).toBe(0);
    expect(await ledgerOf(t.db, year.orderId)).toEqual(purchaseOnly(year));

    const half = await order(6);
    await expect(worker.service.run(half.orderId, { finalAttempt: false })).resolves.toBe('DONE');
    expect((await orderRow(t.db, half.orderId)).status).toBe('DELIVERED');
    expect((await transfersOf(t.db, half.orderId)).map((x) => x.amountNanoTon)).toEqual([
      PREMIUM_NANO[6],
    ]);
    expect(t.executedOnChain()).toBe(1);
  });
});

describe('fulfill-order: a worker dying mid-payout of a Premium order never pays twice', () => {
  const DIED = 'the worker died here';
  const die = (): Promise<void> => Promise.reject(new Error(DIED));

  async function diesThenSecondRuns(fixture: PremiumOrderFixture): Promise<void> {
    await expect(t.main.service.run(fixture.orderId, { finalAttempt: false })).rejects.toThrow(
      DIED,
    );
    const firstTransfers = await transfersOf(t.db, fixture.orderId);
    expect(firstTransfers.map((x) => [x.status, x.amountNanoTon])).toEqual([
      ['SIGNED', fixture.costNano],
    ]);
    await t.kill(t.main);
  }

  it('(b) after SIGNED, before broadcast: proven never sent (EXPIRED), then one payout of the term', async () => {
    pinChain(t.gateway, SIGN_AT_SEC);
    const fixture = await order(12);
    t.main.tonHooks.afterStoredFn = die;
    await diesThenSecondRuns(fixture);
    expect(t.gateway.callCount('sendBoc')).toBe(0);

    pinChain(t.gateway, PAST_VALID_SEC);
    const second = await t.boot();
    await expect(second.service.run(fixture.orderId, { finalAttempt: false })).resolves.toBe(
      'DONE',
    );
    expect((await orderRow(t.db, fixture.orderId)).status).toBe('DELIVERED');
    const attempts = await attemptsOf(t.db, fixture.orderId);
    expect(attempts.map((a) => [a.attemptNo, a.status, a.error])).toEqual([
      [1, 'FAILED', 'TON_EXPIRED'],
      [2, 'CONFIRMED', null],
    ]);
    const transfers = await transfersOf(t.db, fixture.orderId);
    expect(transfers.map((x) => `${x.status}:${String(x.amountNanoTon)}`).sort()).toEqual([
      `CONFIRMED:${String(PREMIUM_NANO[12])}`,
      `EXPIRED:${String(PREMIUM_NANO[12])}`,
    ]);
    expect(t.executedOnChain()).toBe(1);
    expect(t.gateway.callCount('sendBoc')).toBe(1);
    expect(await ledgerOf(t.db, fixture.orderId)).toEqual(purchaseOnly(fixture));
  });

  it('(c) after the broadcast landed, before BROADCAST was recorded: only followed', async () => {
    pinChain(t.gateway, 0);
    const fixture = await order(6);
    t.gateway.nextSend('LAND_THEN_THROW');
    t.main.tonHooks.afterBroadcastFn = die;
    await diesThenSecondRuns(fixture);
    expect(t.executedOnChain()).toBe(1);

    const second = await t.boot();
    await expect(second.service.run(fixture.orderId, { finalAttempt: false })).resolves.toBe(
      'DONE',
    );
    expect((await orderRow(t.db, fixture.orderId)).status).toBe('DELIVERED');
    const transfers = await transfersOf(t.db, fixture.orderId);
    expect(transfers.map((x) => [x.status, x.amountNanoTon])).toEqual([
      ['CONFIRMED', PREMIUM_NANO[6]],
    ]);
    expect(t.executedOnChain()).toBe(1);
    expect(t.gateway.callCount('sendBoc')).toBe(1);
    expect(await ledgerOf(t.db, fixture.orderId)).toEqual(purchaseOnly(fixture));
  });
});
