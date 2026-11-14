import { PAST_VALID_SEC, SIGN_AT_SEC, pinChain } from '../../ton/__tests__/ton-e2e.harness';
import type { OrderFixture } from './fulfill-e2e.fixtures';
import { attemptsOf, orderRow, transfersOf } from './fulfill-e2e.fixtures';
import { useFulfillE2e } from './fulfill-e2e.harness';

// Acceptance criterion 3 (plan §1): the worker "dies" in the middle of a payout and a NEW worker
// runs the same job; nothing is paid twice. Four death points: a hook that throws stands for the
// process dying right there, its module is closed (the processor instance is thrown away), and a
// fresh worker process on the same wallet and chain runs the order again:
//   (a) after the attempt's SENDING commit, before signing;
//   (b) after TonTransfer SIGNED committed, before the broadcast;
//   (c) after the broadcast reached the chain, before BROADCAST was recorded;
//   (d) after the payout landed on the chain, before its confirmation was written (DELIVERED).
// Every case: at most one payout executed on chain, a second TonTransfer only when the first is
// PROVEN never sent (b: EXPIRED), and the order ends DELIVERED or NEEDS_REVIEW.

const t = useFulfillE2e();
const DIED = 'the worker died here';
const die = (): Promise<void> => Promise.reject(new Error(DIED));

async function firstWorkerDies(fixture: OrderFixture): Promise<void> {
  await expect(t.main.service.run(fixture.orderId, { finalAttempt: false })).rejects.toThrow(DIED);
  await t.kill(t.main);
}

async function secondWorkerRuns(fixture: OrderFixture) {
  const second = await t.boot();
  return second.service.run(fixture.orderId, { finalAttempt: false });
}

async function settled(fixture: OrderFixture) {
  const [order, attempts, transfers] = await Promise.all([
    orderRow(t.db, fixture.orderId),
    attemptsOf(t.db, fixture.orderId),
    transfersOf(t.db, fixture.orderId),
  ]);
  expect(['DELIVERED', 'NEEDS_REVIEW']).toContain(order.status);
  expect(t.executedOnChain()).toBeLessThanOrEqual(1);
  return { order, attempts, transfers };
}

describe('fulfill-order: a worker that dies mid-payout never pays twice (criterion 3)', () => {
  it('(a) after SENDING, before signing: the next worker signs that attempt once', async () => {
    pinChain(t.gateway, 0);
    const fixture = await t.order();
    t.main.hooks.afterSendingFn = die;
    await firstWorkerDies(fixture);
    expect(await attemptsOf(t.db, fixture.orderId)).toEqual([
      expect.objectContaining({ status: 'SENDING', externalRef: null }),
    ]);
    expect(await transfersOf(t.db, fixture.orderId)).toHaveLength(0);

    await expect(secondWorkerRuns(fixture)).resolves.toBe('DONE');
    const { order, attempts, transfers } = await settled(fixture);
    expect(order.status).toBe('DELIVERED');
    expect(attempts.map((a) => a.status)).toEqual(['CONFIRMED']);
    expect(transfers).toHaveLength(1);
    expect(t.executedOnChain()).toBe(1);
    expect(t.gateway.callCount('sendBoc')).toBe(1);
  });

  it('(b) after SIGNED, before broadcast: proven never sent (EXPIRED), then one new payout', async () => {
    pinChain(t.gateway, SIGN_AT_SEC);
    const fixture = await t.order();
    t.main.tonHooks.afterStoredFn = die;
    await firstWorkerDies(fixture);
    const [first] = await transfersOf(t.db, fixture.orderId);
    expect(first?.status).toBe('SIGNED');
    expect(t.gateway.callCount('sendBoc')).toBe(0);

    // The chain moves past valid_until + margin: the signed message can never be accepted.
    pinChain(t.gateway, PAST_VALID_SEC);
    await expect(secondWorkerRuns(fixture)).resolves.toBe('DONE');
    const { order, attempts, transfers } = await settled(fixture);
    expect(order.status).toBe('DELIVERED');
    expect(attempts.map((a) => [a.attemptNo, a.status, a.error])).toEqual([
      [1, 'FAILED', 'TON_EXPIRED'],
      [2, 'CONFIRMED', null],
    ]);
    expect(transfers.map((x) => x.status).sort()).toEqual(['CONFIRMED', 'EXPIRED']);
    expect(t.executedOnChain()).toBe(1);
    expect(t.gateway.callCount('sendBoc')).toBe(1);
  });

  it('(c) after the broadcast landed, before BROADCAST was recorded: only followed', async () => {
    pinChain(t.gateway, 0);
    const fixture = await t.order();
    t.gateway.nextSend('LAND_THEN_THROW');
    t.main.tonHooks.afterBroadcastFn = die;
    await firstWorkerDies(fixture);
    const [first] = await transfersOf(t.db, fixture.orderId);
    expect(first?.status).toBe('SIGNED');
    expect(t.executedOnChain()).toBe(1);

    await expect(secondWorkerRuns(fixture)).resolves.toBe('DONE');
    const { order, transfers } = await settled(fixture);
    expect(order.status).toBe('DELIVERED');
    expect(transfers).toHaveLength(1);
    expect(t.executedOnChain()).toBe(1);
    expect(t.gateway.callCount('sendBoc')).toBe(1);
  });

  it('(d) after the payout landed, before DELIVERED was written: only followed', async () => {
    pinChain(t.gateway, 0);
    const fixture = await t.order();
    t.gateway.nextSend('LAND');
    t.main.tonHooks.afterBroadcastFn = die;
    await firstWorkerDies(fixture);
    const [first] = await transfersOf(t.db, fixture.orderId);
    expect(first?.status).toBe('BROADCAST');
    expect((await orderRow(t.db, fixture.orderId)).status).toBe('PROCESSING');

    await expect(secondWorkerRuns(fixture)).resolves.toBe('DONE');
    const { order, attempts, transfers } = await settled(fixture);
    expect(order.status).toBe('DELIVERED');
    expect(attempts.map((a) => a.status)).toEqual(['CONFIRMED']);
    expect(transfers.map((x) => x.status)).toEqual(['CONFIRMED']);
    expect(t.executedOnChain()).toBe(1);
    expect(t.gateway.callCount('sendBoc')).toBe(1);
  });

  it('a lost broadcast that cannot be proven unsent ends in NEEDS_REVIEW, never a second payout', async () => {
    pinChain(t.gateway, 0);
    const fixture = await t.order();
    t.gateway.nextSend('LOSE');
    t.main.tonHooks.afterBroadcastFn = die;
    await firstWorkerDies(fixture);

    const second = await t.boot({ timing: { confirmTimeoutMs: 1_000 } });
    await expect(second.service.run(fixture.orderId, { finalAttempt: false })).resolves.toBe(
      'DONE',
    );
    const { order, transfers } = await settled(fixture);
    expect(order).toEqual(expect.objectContaining({ status: 'NEEDS_REVIEW' }));
    expect(transfers).toHaveLength(1);
    expect(t.executedOnChain()).toBe(0);
    expect(t.gateway.callCount('sendBoc')).toBe(1);
  });
});
