import type { NotifyJob } from '@repo/shared';
import { pinChain } from '../../ton/__tests__/ton-e2e.harness';
import { attemptsOf, orderRow, transfersOf } from './fulfill-e2e.fixtures';
import { CountingWalletLock } from './fulfill-e2e.doubles';
import { useFulfillE2e } from './fulfill-e2e.harness';

// Acceptance criterion 4 (plan §1) with the simulator scenarios and the in-memory chain: an unknown
// outcome or a confirmation timeout -> NEEDS_REVIEW + the owner's alert; a price above the stored
// ceiling -> HELD (PRICE_ABOVE_MAX); the per-order and daily TON limits and a low balance -> HELD
// + alert. Nothing is ever sent in a held case.

const t = useFulfillE2e();
const run = (orderId: string, final = false) =>
  t.main.service.run(orderId, { finalAttempt: final });

const review = (orderId: string): NotifyJob[] => [
  { kind: 'ORDER_REVIEW', refId: orderId },
  { kind: 'OWNER_ALERT', alert: 'needsReview', refId: orderId },
];
const heldJobs = (orderId: string, holdId: string): NotifyJob[] => [
  { kind: 'ORDER_REVIEW', refId: orderId },
  { kind: 'OWNER_ALERT', alert: 'held', refId: `${orderId}_${holdId}` },
];

async function expectJobs(jobs: readonly NotifyJob[]): Promise<void> {
  for (const job of jobs)
    expect({ job, queued: await t.hasJob(job) }).toEqual({ job, queued: true });
}

async function latestHeldEventId(orderId: string): Promise<string> {
  const event = await t.db.orderEvent.findFirstOrThrow({
    where: { orderId, to: 'HELD' },
    select: { id: true },
  });
  return event.id;
}

describe('fulfill-order: unknown outcomes go to NEEDS_REVIEW with an alert', () => {
  it('a TON payout whose message is lost and not provably expired: NEEDS_REVIEW', async () => {
    pinChain(t.gateway, 0);
    const main = await t.boot({ timing: { confirmTimeoutMs: 1_000 } });
    const fixture = await t.order();
    t.gateway.nextSend('LOSE');
    await expect(main.service.run(fixture.orderId, { finalAttempt: false })).resolves.toBe('DONE');
    expect(await orderRow(t.db, fixture.orderId)).toEqual(
      expect.objectContaining({ status: 'NEEDS_REVIEW', statusReason: 'CONFIRM_TIMEOUT' }),
    );
    await expectJobs(review(fixture.orderId));
    expect(t.executedOnChain()).toBe(0);
  });

  it('a supplier that answers UNKNOWN: attempt UNKNOWN, order NEEDS_REVIEW', async () => {
    const fixture = await t.order({ adapter: 'RESELLER_STARS' });
    t.script.set(fixture.orderId, 'UNKNOWN');
    await expect(run(fixture.orderId)).resolves.toBe('DONE');
    expect(await orderRow(t.db, fixture.orderId)).toEqual(
      expect.objectContaining({ status: 'NEEDS_REVIEW', statusReason: 'ADAPTER_ERROR' }),
    );
    expect((await attemptsOf(t.db, fixture.orderId)).map((a) => a.status)).toEqual(['UNKNOWN']);
    await expectJobs(review(fixture.orderId));
  });

  it('a supplier payout never confirmed within the timeout: NEEDS_REVIEW (CONFIRM_TIMEOUT)', async () => {
    const fixture = await t.order({ adapter: 'RESELLER_STARS' });
    t.script.set(fixture.orderId, 'TIMEOUT');
    await expect(run(fixture.orderId)).resolves.toBe('DONE');
    expect(await orderRow(t.db, fixture.orderId)).toEqual(
      expect.objectContaining({ status: 'NEEDS_REVIEW', statusReason: 'CONFIRM_TIMEOUT' }),
    );
    const attempts = await attemptsOf(t.db, fixture.orderId);
    expect(attempts.map((a) => [a.status, a.externalRef])).toEqual([
      ['UNKNOWN', `sim-${fixture.orderId}`],
    ]);
    await expectJobs(review(fixture.orderId));
  });
});

describe('fulfill-order: the price and the limits hold the order with an alert', () => {
  it('Fragment asks more than maxCostMinor: HELD (PRICE_ABOVE_MAX), no attempt, nothing sent', async () => {
    const fixture = await t.order();
    t.script.set(fixture.orderId, 'PRICE_UP');
    await expect(run(fixture.orderId)).resolves.toBe('DONE');
    expect(await orderRow(t.db, fixture.orderId)).toEqual(
      expect.objectContaining({ status: 'HELD', statusReason: 'PRICE_ABOVE_MAX' }),
    );
    expect(await attemptsOf(t.db, fixture.orderId)).toHaveLength(0);
    await expectJobs(heldJobs(fixture.orderId, await latestHeldEventId(fixture.orderId)));
    expect(t.gateway.callCount('sendBoc')).toBe(0);
  });

  it('a supplier price above maxCostMinor holds the same way', async () => {
    const fixture = await t.order({ adapter: 'RESELLER_STARS' });
    t.script.set(fixture.orderId, 'PRICE_UP');
    await run(fixture.orderId);
    expect((await orderRow(t.db, fixture.orderId)).statusReason).toBe('PRICE_ABOVE_MAX');
  });

  it.each([
    ['LIMIT_PER_ORDER', { TON_MAX_PER_ORDER_NANO: 100_000_000n }],
    ['LIMIT_DAILY', { TON_MAX_DAILY_NANO: 200_000_000n }],
  ] as const)('%s: HELD before signing, attempt FAILED, alert', async (reason, limits) => {
    pinChain(t.gateway, 0);
    const main = await t.boot({ env: { ...t.env, ...limits } });
    const fixture = await t.order();
    await expect(main.service.run(fixture.orderId, { finalAttempt: false })).resolves.toBe('DONE');
    expect(await orderRow(t.db, fixture.orderId)).toEqual(
      expect.objectContaining({ status: 'HELD', statusReason: reason }),
    );
    const [attempt] = await attemptsOf(t.db, fixture.orderId);
    expect(attempt).toEqual(expect.objectContaining({ status: 'FAILED', error: reason }));
    const ref = `${fixture.orderId}_${attempt?.id ?? ''}`;
    await expectJobs(heldJobs(fixture.orderId, attempt?.id ?? ''));
    if (reason === 'LIMIT_DAILY') {
      await expectJobs([{ kind: 'OWNER_ALERT', alert: 'tonDailyLimit', refId: ref }]);
    }
    expect(await transfersOf(t.db, fixture.orderId)).toHaveLength(0);
    expect(t.gateway.callCount('sendBoc')).toBe(0);
  });

  it('a balance below amount + fee reserve: HELD (LOW_BALANCE) with an alert', async () => {
    pinChain(t.gateway, 0);
    t.gateway.setBalance(t.wallet.address, 100_000_000n);
    const fixture = await t.order();
    await run(fixture.orderId);
    expect(await orderRow(t.db, fixture.orderId)).toEqual(
      expect.objectContaining({ status: 'HELD', statusReason: 'LOW_BALANCE' }),
    );
    const [attempt] = await attemptsOf(t.db, fixture.orderId);
    await expectJobs(heldJobs(fixture.orderId, attempt?.id ?? ''));
    expect(t.gateway.callCount('sendBoc')).toBe(0);
  });

  it('the replay of a TON-held order sends its notices without pay() or the wallet lock (CR m3)', async () => {
    pinChain(t.gateway, 0);
    const walletLock = new CountingWalletLock();
    const main = await t.boot({
      env: { ...t.env, TON_MAX_PER_ORDER_NANO: 100_000_000n },
      walletLock,
    });
    const held = await t.order();
    await main.service.run(held.orderId, { finalAttempt: false });
    const [attempt] = await attemptsOf(t.db, held.orderId);
    const jobs = heldJobs(held.orderId, attempt?.id ?? '');
    for (const job of jobs) await t.dropJob(job);
    const reads = t.gateway.callCount('getAccountState');
    walletLock.acquired = 0;

    // Another order's live payout holds the wallet while the replay runs: it is never refused.
    const live = await t.order();
    const lease = await walletLock.acquire();
    await expect(main.service.run(held.orderId, { finalAttempt: false })).resolves.toBe('REPLAYED');
    await expectJobs(jobs);
    expect(walletLock.acquired).toBe(1);
    await lease?.release();
    expect(t.gateway.callCount('getAccountState')).toBe(reads);
    expect(t.gateway.callCount('sendBoc')).toBe(0);
    expect(await attemptsOf(t.db, held.orderId)).toHaveLength(1);
    // The released wallet pays the other order (its first try at the lock).
    const relaxed = await t.boot({ walletLock });
    await expect(relaxed.service.run(live.orderId, { finalAttempt: false })).resolves.toBe('DONE');
    expect((await orderRow(t.db, live.orderId)).status).toBe('DELIVERED');
    expect(walletLock.acquired).toBe(2);
  });
});

describe('fulfill-order: no usable adapter, a refusing or failing provider', () => {
  it('no route at all: HELD (NO_ADAPTER)', async () => {
    const fixture = await t.order({ noRoute: true });
    await run(fixture.orderId);
    expect((await orderRow(t.db, fixture.orderId)).statusReason).toBe('NO_ADAPTER');
  });

  it('a TON-priced order routed to a USDT adapter: HELD (NO_ADAPTER), no cross-currency', async () => {
    const fixture = await t.order({ routeAdapter: 'RESELLER_STARS' });
    await run(fixture.orderId);
    expect(await orderRow(t.db, fixture.orderId)).toEqual(
      expect.objectContaining({ status: 'HELD', statusReason: 'NO_ADAPTER' }),
    );
    expect(await attemptsOf(t.db, fixture.orderId)).toHaveLength(0);
  });

  it('Fragment refuses to prepare: HELD (ADAPTER_ERROR)', async () => {
    const fixture = await t.order();
    t.script.set(fixture.orderId, 'NOT_SENT');
    await run(fixture.orderId);
    expect((await orderRow(t.db, fixture.orderId)).statusReason).toBe('ADAPTER_ERROR');
  });

  it('Fragment unreachable: retried while attempts remain, HELD on the last one', async () => {
    const fixture = await t.order();
    t.script.set(fixture.orderId, 'UNKNOWN');
    await expect(run(fixture.orderId)).rejects.toThrow('simulated provider outage');
    expect((await orderRow(t.db, fixture.orderId)).status).toBe('PROCESSING');
    await expect(run(fixture.orderId, true)).resolves.toBe('DONE');
    expect(await orderRow(t.db, fixture.orderId)).toEqual(
      expect.objectContaining({ status: 'HELD', statusReason: 'ADAPTER_ERROR' }),
    );
    expect(await attemptsOf(t.db, fixture.orderId)).toHaveLength(0);
    await expectJobs(heldJobs(fixture.orderId, await latestHeldEventId(fixture.orderId)));
  });
});
