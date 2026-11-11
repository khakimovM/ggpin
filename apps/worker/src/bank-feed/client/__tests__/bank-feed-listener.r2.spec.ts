import { Logger } from '@nestjs/common';
import { alertRef } from '@repo/shared';
import { BankFeedFatalError } from '../bank-feed-client';
import { NOW, flush, harness, stopped } from './listener-harness';

// D-52 r2 (fix round 2): the account binding alerts, the authorization freshness of reads (L-A),
// the local lease checked by the lock timer itself (m2), bounded stop/alert calls (m1) and the
// retry of an edit anomaly that could not be raised (m5).
const FAST = { stopMs: 20, alertMs: 20, redisMs: 20 };
const never = <T>() => new Promise<T>(() => undefined);

describe('BankFeedListener (D-52 r2)', () => {
  beforeEach(() => {
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('L-B: a first binding leads and alerts accountBound once; an already bound account alerts nothing', async () => {
    const t = harness();
    t.accountIs('BOUND');
    await t.tick();
    expect(t.listener.state).toBe('leading');
    expect(t.alerts).toEqual([['accountBound', alertRef.accountBound(NOW)]]);
    const u = harness();
    await u.tick();
    expect(u.listener.state).toBe('leading');
    expect(u.alerts).toEqual([]);
  });

  it('L-B: no bound account but stored history never binds: stopped, ACCOUNT_UNBOUND, nothing read', async () => {
    const t = harness();
    t.accountIs('UNBOUND_HISTORY');
    await t.tick();
    expect(t.listener.state).toBe('stopped');
    expect(t.events).not.toContain('authorizations');
    expect(t.polls).toEqual([]);
    expect(t.alerts).toEqual([stopped('ACCOUNT_UNBOUND')]);
    expect(t.store.holder('lock:bank-feed')).toBeNull();
  });

  it('L-A: nudges read only within 2 poll intervals of a successful authorization check', async () => {
    const t = harness(); // pollMs 20 s
    t.check.mockRejectedValueOnce(new Error('timeout'));
    await t.tick();
    expect(t.listener.isLeading()).toBe(true);
    expect(t.listener.mayRead()).toBe(false); // leading, but the check failed
    t.client.emitNew({ source: 'UZCARD_BOT', messageId: 5n });
    expect(t.polls).toEqual([]);
    await t.listener.pollRound();
    expect(t.listener.mayRead()).toBe(true);
    t.polls.length = 0;
    t.client.emitNew({ source: 'UZCARD_BOT', messageId: 6n });
    expect(t.polls).toEqual(['UZCARD_BOT']);
    t.polls.length = 0;
    // Renewed every 10 s (the lease stays fresh) while no round runs: the check gets old.
    for (const ms of [10_000, 20_000, 30_000, 40_001]) {
      t.clock.ms = ms;
      t.store.nowMs = ms;
      await t.listener.tick();
    }
    expect(t.listener.isLeading()).toBe(true);
    expect(t.listener.mayRead()).toBe(false);
    t.client.emitNew({ source: 'UZCARD_BOT', messageId: 7n });
    expect(t.polls).toEqual([]);
  });

  it('m2: the lock timer itself disconnects on a stale local lease while the renewal hangs', async () => {
    jest.useFakeTimers();
    // The renewal timeout (r3 CR-7) is set past the lease here so that this checks checkLease alone.
    const t = harness({
      timing: {
        pollMs: 20_000,
        lockMs: 10_000,
        watchdogMs: 300_000,
        timeouts: { stopMs: 10_000, alertMs: 5_000, redisMs: 60_000 },
      },
    });
    t.listener.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(0);
    await t.listener.settled();
    expect(t.listener.state).toBe('leading');
    let unblock: () => void = () => undefined;
    t.store.renew = () => new Promise<boolean>((resolve) => (unblock = () => resolve(false)));
    await jest.advanceTimersByTimeAsync(10_000); // a renewal is sent and hangs
    expect(t.listener.state).toBe('leading');
    expect(t.events).not.toContain('client.stop');
    t.clock.ms = 26_000; // no confirmed renewal for more than TTL - margin
    await jest.advanceTimersByTimeAsync(10_000); // the next lock interval: checkLease
    expect(t.listener.state).toBe('standby');
    expect(t.events.slice(-3)).toEqual(['client.stop', 'beat.clear', 'lock.release']);
    unblock();
    await t.listener.onModuleDestroy();
  });

  it('m1: a client.stop that hangs still clears the heartbeat and frees the lock (bounded)', async () => {
    const t = harness({
      timing: { pollMs: 20_000, lockMs: 10_000, watchdogMs: 300_000, timeouts: FAST },
    });
    await t.tick();
    t.client.stop = never;
    await t.listener.onModuleDestroy();
    expect(t.listener.state).toBe('stopped');
    expect(t.events.slice(-2)).toEqual(['beat.clear', 'lock.release']);
    expect(t.store.holder('lock:bank-feed')).toBeNull();
  });

  it('m1: an alert send that hangs does not hold up the lock tick; it is retried until queued', async () => {
    const t = harness({
      timing: { pollMs: 20_000, lockMs: 10_000, watchdogMs: 300_000, timeouts: FAST },
    });
    t.alertWith(never);
    t.pollWith(() => Promise.reject(new BankFeedFatalError('BANNED')));
    await t.tick(); // resolves: the send gave up after alertMs
    expect(t.listener.state).toBe('stopped');
    expect(t.alerts).toEqual([]);
    t.alertWith(() => Promise.resolve());
    await t.tick();
    expect(t.alerts).toEqual([stopped('BANNED')]);
  });

  it('m5: an edit anomaly that could not be raised is raised again on the next lock tick', async () => {
    const t = harness();
    await t.tick();
    t.storeRow('HUMO_BOT', 78n, { id: 'cm3stored78', rejectReason: 'OUTGOING' });
    t.raiseWith(() => Promise.reject(new Error('card busy')));
    t.client.emitEdit({ source: 'HUMO_BOT', messageId: 78n });
    await flush();
    expect(t.alerts).toEqual([['edited', 'cm3stored78']]); // the edit alert went out first
    expect(t.anomalies).toEqual([]);
    t.raiseWith(() => Promise.resolve());
    await t.tick();
    expect(t.anomalies).toEqual([['HUMO_BOT', 'OUTGOING', 78n]]);
    await t.tick();
    expect(t.anomalies).toHaveLength(1); // raised once: nothing left pending
  });
});
