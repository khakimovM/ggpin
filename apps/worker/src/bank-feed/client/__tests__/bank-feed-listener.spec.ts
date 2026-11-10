import { Logger } from '@nestjs/common';
import { alertRef } from '@repo/shared';
import { BankFeedFatalError } from '../bank-feed-client';
import type { PollOutcome } from '../bank-feed-poller';
import { NOW, SlowClient, flush, harness, stopped } from './listener-harness';
import { MemoryLockStore } from './memory-lock-store';

describe('BankFeedListener', () => {
  beforeEach(() => {
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });
  afterEach(() => jest.restoreAllMocks());

  it('leads, then each round checks the authorizations FIRST, polls both sources, writes the heartbeat', async () => {
    const t = harness();
    await t.tick();
    expect(t.listener.state).toBe('leading');
    expect(t.events).toEqual(['authorizations', 'poll:HUMO_BOT', 'poll:UZCARD_BOT']);
    expect(t.beats).toEqual([NOW]);
  });

  it('a second worker does not connect; it takes over after the dead leader TTL', async () => {
    const store = new MemoryLockStore();
    const a = harness({ store });
    const b = harness({ store });
    await a.tick();
    await b.tick();
    expect(b.listener.state).toBe('standby');
    expect(b.client.starts).toBe(0);
    store.nowMs = 30_000;
    await b.tick();
    expect(b.listener.state).toBe('leading');
    await a.tick(); // a's renewal fails: it disconnects
    expect(a.listener.state).toBe('standby');
    expect(a.client.started).toBe(false);
  });

  it('L-2: a failed authorization check reads nothing and writes no heartbeat; poll errors are unhealthy too', async () => {
    const t = harness();
    t.check.mockRejectedValueOnce(new Error('timeout'));
    await t.tick();
    expect(t.polls).toEqual([]);
    expect(t.beats).toEqual([]);
    t.pollWith(() => Promise.reject(new Error('network')));
    await t.listener.pollRound();
    t.pollWith(() => Promise.resolve('FOREIGN_CHAT'));
    await t.listener.pollRound();
    expect(t.beats).toEqual([]);
    t.pollWith(() => Promise.resolve('END'));
    await t.listener.pollRound();
    expect(t.beats).toEqual([NOW]);
  });

  it('I1: a heartbeat write that fails is an unhealthy round, never an unhandled rejection', async () => {
    const t = harness();
    t.beatWith(() => Promise.reject(new Error('redis away')));
    await t.tick();
    await expect(t.listener.pollRound()).resolves.toBeUndefined();
    expect(t.listener.state).toBe('leading');
    // The watchdog was not refreshed by it: 5 minutes later it alerts.
    t.clock.ms = 5 * 60_000;
    await t.tick();
    expect(t.alerts).toContainEqual([
      'listenerDown',
      alertRef.listenerDown(NOW, new Date(NOW.getTime() + 5 * 60_000)),
    ]);
  });

  it('I1/L-6: timers never leak a rejection (beat, poll and alert all failing)', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const t = harness({ timing: { pollMs: 5, lockMs: 5, watchdogMs: 1 } });
    t.beatWith(() => Promise.reject(new Error('redis away')));
    t.alertWith(() => Promise.reject(new Error('redis away')));
    t.listener.onApplicationBootstrap();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(t.listener.state).toBe('leading'); // alive, still leading
    expect(t.beats.length).toBeGreaterThan(1); // rounds kept coming
    t.pollWith(() => Promise.reject(new Error('network')));
    await new Promise((resolve) => setTimeout(resolve, 30));
    await t.listener.onModuleDestroy();
    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toEqual([]);
  });

  it('a revoked session during a round: stopped for good; the connection goes BEFORE the heartbeat and the lock; listenerStopped REVOKED', async () => {
    const t = harness();
    t.pollWith(() => Promise.reject(new BankFeedFatalError('REVOKED')));
    await t.tick();
    expect(t.listener.state).toBe('stopped');
    expect(t.events.slice(-3)).toEqual(['client.stop', 'beat.clear', 'lock.release']);
    expect(t.alerts).toEqual([stopped('REVOKED')]);
    expect(t.store.holder('lock:bank-feed')).toBeNull();
    expect(t.beats).toEqual([]);
    await t.tick();
    expect(t.client.starts).toBe(1);
  });

  it('M5: the stop reason is in the alert (DUPLICATED from the updates loop, BOT_MISMATCH at start)', async () => {
    const t = harness();
    await t.tick();
    t.client.emitFatal(new BankFeedFatalError('DUPLICATED'));
    await flush();
    expect(t.listener.state).toBe('stopped');
    expect(t.alerts).toEqual([stopped('DUPLICATED')]);
    const u = harness();
    u.client.startFailure = new BankFeedFatalError('BOT_MISMATCH');
    await u.tick();
    expect(u.listener.state).toBe('stopped');
    expect(u.alerts).toEqual([stopped('BOT_MISMATCH')]);
  });

  it('D4: a session of another account than the bound one never leads, writes no heartbeat, alerts ACCOUNT_MISMATCH', async () => {
    const t = harness();
    t.accountIs('MISMATCH');
    await t.tick();
    expect(t.listener.state).toBe('stopped');
    expect(t.events).not.toContain('authorizations');
    expect(t.polls).toEqual([]);
    expect(t.beats).toEqual([]);
    expect(t.alerts).toEqual([stopped('ACCOUNT_MISMATCH')]);
    expect(t.store.holder('lock:bank-feed')).toBeNull();
  });

  it('M5: an alert that could not be queued is retried on the next tick', async () => {
    const t = harness();
    let fail = true;
    t.alertWith(() => (fail ? Promise.reject(new Error('redis away')) : Promise.resolve()));
    t.pollWith(() => Promise.reject(new BankFeedFatalError('BANNED')));
    await t.tick();
    expect(t.alerts).toEqual([]);
    fail = false;
    await t.tick();
    expect(t.alerts).toEqual([stopped('BANNED')]);
    await t.tick();
    expect(t.alerts).toHaveLength(1);
  });

  it('a transient start failure disconnects, then frees the lock; the next tick retries', async () => {
    const t = harness();
    t.client.startFailure = new Error('connect timeout');
    await t.tick();
    expect(t.listener.state).toBe('standby');
    expect(t.events).toEqual(['client.stop', 'beat.clear', 'lock.release']);
    t.client.startFailure = null;
    await t.tick();
    expect(t.listener.state).toBe('leading');
  });

  it('I2: a slow start does not stop the renewals; the lock is checked again when it is done', async () => {
    const client = new SlowClient();
    const t = harness({ client });
    await t.listener.tick();
    expect(t.listener.state).toBe('starting');
    t.clock.ms = 10_000;
    t.store.nowMs = 10_000;
    await t.listener.tick(); // returns while the start still hangs: the lock was renewed
    t.clock.ms = 20_000;
    t.store.nowMs = 20_000;
    await t.listener.tick();
    expect(t.store.holder('lock:bank-feed')).not.toBeNull();
    // Meanwhile another worker took the key (e.g. Redis was flushed): after the start, not ours.
    t.store.force('lock:bank-feed', 'someone-else', 30_000);
    client.finishStart();
    await t.listener.settled();
    expect(t.listener.state).toBe('standby');
    expect(t.events).toContain('client.stop');
    expect(t.polls).toEqual([]);
  });

  it('I2: during a long round the lock keeps being renewed; a stale local lease ends leading (no heartbeat; the disconnect itself: m2 in the r2 spec)', async () => {
    const t = harness();
    let finish: () => void = () => undefined;
    t.pollWith(() => new Promise<PollOutcome>((resolve) => (finish = () => resolve('END'))));
    await t.listener.tick();
    await flush();
    t.clock.ms = 10_000;
    t.store.nowMs = 10_000;
    await t.listener.tick(); // not blocked by the hanging round
    expect(t.store.holder('lock:bank-feed')).not.toBeNull();
    expect(t.listener.isLeading()).toBe(true);
    t.clock.ms = 25_000; // no confirmed renewal for 15 s
    expect(t.listener.isLeading()).toBe(false);
    finish();
    await t.listener.settled();
    expect(t.beats).toEqual([]); // the round ended after the lease: no heartbeat
  });

  it('M4: a shutdown while connecting disconnects the late connection and frees the lock', async () => {
    const client = new SlowClient();
    const t = harness({ client });
    await t.listener.tick();
    const destroyed = t.listener.onModuleDestroy();
    await destroyed;
    expect(t.store.holder('lock:bank-feed')).toBeNull();
    client.finishStart();
    await t.listener.settled();
    expect(t.listener.state).toBe('stopped');
    expect(client.started).toBe(false);
    expect(client.closed).toBe(true);
  });

  it('I3: the watchdog alerts listenerDown after 5 minutes without a healthy round, once an hour', async () => {
    const t = harness();
    t.store.force('lock:bank-feed', 'someone-else', 3_600_000); // standby the whole time
    await t.tick();
    t.clock.ms = 4 * 60_000;
    await t.tick();
    expect(t.alerts).toEqual([]);
    t.clock.ms = 5 * 60_000;
    await t.tick();
    t.clock.ms = 6 * 60_000;
    await t.tick();
    const first = alertRef.listenerDown(NOW, new Date(NOW.getTime() + 5 * 60_000));
    expect(t.alerts).toEqual([['listenerDown', first]]);
    t.clock.ms = 61 * 60_000;
    await t.tick();
    expect(t.alerts).toHaveLength(2);
  });

  it('a live update nudges a poll; edits: stored -> `edited`, own (OUTGOING) -> anomaly too, unstored -> poll', async () => {
    const t = harness();
    t.client.emitNew({ source: 'UZCARD_BOT', messageId: 5n });
    expect(t.polls).toEqual([]);
    await t.tick();
    t.polls.length = 0;
    t.client.emitNew({ source: 'UZCARD_BOT', messageId: 6n });
    expect(t.polls).toEqual(['UZCARD_BOT']);
    t.polls.length = 0;
    t.stored.set(77n, { id: 'cm3stored77', rejectReason: null });
    t.stored.set(78n, { id: 'cm3stored78', rejectReason: 'OUTGOING' });
    t.client.emitEdit({ source: 'HUMO_BOT', messageId: 77n });
    t.client.emitEdit({ source: 'HUMO_BOT', messageId: 78n });
    await flush();
    expect(t.alerts).toEqual([
      ['edited', 'cm3stored77'],
      ['edited', 'cm3stored78'],
    ]);
    expect(t.anomalies).toEqual([['HUMO_BOT', 'OUTGOING', 78n]]);
    t.client.emitEdit({ source: 'HUMO_BOT', messageId: 79n });
    await flush();
    expect(t.polls).toEqual(['HUMO_BOT']);
  });

  it('shutdown: disconnect, heartbeat cleared, lock released, client closed', async () => {
    const t = harness();
    await t.tick();
    await t.listener.onModuleDestroy();
    expect(t.listener.state).toBe('stopped');
    expect(t.events.slice(-3)).toEqual(['client.stop', 'beat.clear', 'lock.release']);
    expect(t.store.holder('lock:bank-feed')).toBeNull();
    expect(t.client.closed).toBe(true);
  });
});
