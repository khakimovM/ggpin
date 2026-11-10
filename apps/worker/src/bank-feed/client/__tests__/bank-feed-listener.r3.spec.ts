import { Logger } from '@nestjs/common';
import { alertRef } from '@repo/shared';
import type { BankFeedSession } from '../bank-feed-client';
import { FakeBankFeedClient } from '../fake-bank-feed.client';
import { NOW, flush, harness } from './listener-harness';

// D-52 r3 (fix round 3): the accountBound alert survives a start that fails after the account
// check (CR-1), a hanging lock renewal is bounded (CR-7), and edits plus their pending anomalies
// need only the lead, not a fresh authorization check (audit I-A).
const FAST = { stopMs: 20, alertMs: 20, redisMs: 20 };
const never = <T>() => new Promise<T>(() => undefined);

/** getMe and the account check succeed, then a later start step (warming peers) fails once. */
class FailsAfterVerify extends FakeBankFeedClient {
  failures = 1;
  override async start(
    verifyAccount?: (accountId: bigint) => Promise<void>,
  ): Promise<BankFeedSession> {
    if (this.failures === 0) return super.start(verifyAccount);
    this.failures -= 1;
    this.starts += 1;
    if (verifyAccount !== undefined) await verifyAccount(this.accountId);
    throw new Error('PEER_WARM_TIMEOUT');
  }
}

describe('BankFeedListener (D-52 r3)', () => {
  beforeEach(() => {
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('CR-1: BOUND then a non-fatal start failure still alerts accountBound; the MATCH retry does not repeat it', async () => {
    const t = harness({ client: new FailsAfterVerify() });
    t.accountIs('BOUND');
    await t.tick();
    expect(t.listener.state).toBe('standby'); // stood down, will retry
    expect(t.alerts).toEqual([['accountBound', alertRef.accountBound(NOW)]]);
    t.accountIs('MATCH'); // the binding was written by the first start
    await t.tick();
    expect(t.listener.state).toBe('leading');
    expect(t.client.starts).toBe(2);
    expect(t.alerts).toEqual([['accountBound', alertRef.accountBound(NOW)]]);
  });

  it('CR-1: an accountBound alert that could not be queued stays pending and goes on the next tick', async () => {
    const t = harness({
      client: new FailsAfterVerify(),
      timing: { pollMs: 20_000, lockMs: 10_000, watchdogMs: 300_000, timeouts: FAST },
    });
    t.accountIs('BOUND');
    t.alertWith(() => Promise.reject(new Error('redis down')));
    await t.tick();
    expect(t.alerts).toEqual([]);
    t.alertWith(() => Promise.resolve());
    t.accountIs('MATCH');
    await t.tick();
    expect(t.listener.state).toBe('leading');
    expect(t.alerts).toEqual([['accountBound', alertRef.accountBound(NOW)]]);
  });

  it('CR-7: a lock renewal that hangs ends the tick as not held; the next tick works', async () => {
    jest.useFakeTimers();
    const t = harness({
      timing: { pollMs: 20_000, lockMs: 10_000, watchdogMs: 300_000, timeouts: FAST },
    });
    await t.tick();
    expect(t.listener.state).toBe('leading');
    const renew = t.store.renew.bind(t.store);
    t.store.renew = never;
    const tick = t.listener.tick();
    await jest.advanceTimersByTimeAsync(FAST.redisMs);
    await tick; // settles: the renewal counted as lost after redisMs
    expect(t.listener.state).toBe('standby');
    expect(t.events.slice(-3)).toEqual(['client.stop', 'beat.clear', 'lock.release']);
    expect(t.store.holder('lock:bank-feed')).toBeNull();
    t.store.renew = renew;
    await t.tick();
    expect(t.listener.state).toBe('leading');
    expect(t.store.holder('lock:bank-feed')).not.toBeNull();
  });

  it('I-A: with a stale authorization check the leader still raises an OUTGOING edit and retries a pending one', async () => {
    const t = harness();
    t.check.mockRejectedValue(new Error('timeout')); // every authorization check fails
    await t.tick();
    expect(t.listener.isLeading()).toBe(true);
    expect(t.listener.mayRead()).toBe(false);
    t.stored.set(78n, { id: 'cm3stored78', rejectReason: 'OUTGOING' });
    t.stored.set(79n, { id: 'cm3stored79', rejectReason: 'OUTGOING' });
    t.client.emitEdit({ source: 'HUMO_BOT', messageId: 78n });
    await flush();
    expect(t.alerts).toEqual([['edited', 'cm3stored78']]);
    expect(t.anomalies).toEqual([['HUMO_BOT', 'OUTGOING', 78n]]);
    t.raiseWith(() => Promise.reject(new Error('card busy')));
    t.client.emitEdit({ source: 'UZCARD_BOT', messageId: 79n });
    await flush();
    expect(t.anomalies).toHaveLength(1); // kept pending
    t.raiseWith(() => Promise.resolve());
    await t.tick();
    expect(t.listener.mayRead()).toBe(false);
    expect(t.anomalies).toEqual([
      ['HUMO_BOT', 'OUTGOING', 78n],
      ['UZCARD_BOT', 'OUTGOING', 79n],
    ]);
    // A nudge still needs the fresh check (r2 L-A): no read.
    t.client.emitNew({ source: 'HUMO_BOT', messageId: 80n });
    expect(t.polls).toEqual([]);
    // An edit of a message not stored yet is left to the poll, which needs the fresh check too:
    // the only edit branch that reads Telegram stays closed (r3 security check I-1).
    const alertsBefore = [...t.alerts];
    t.client.emitEdit({ source: 'HUMO_BOT', messageId: 81n });
    await flush();
    expect(t.polls).toEqual([]);
    expect(t.alerts).toEqual(alertsBefore);
  });

  it('I-A: a worker that is not leading handles no edit at all', async () => {
    const t = harness();
    t.stored.set(78n, { id: 'cm3stored78', rejectReason: 'OUTGOING' });
    t.client.emitEdit({ source: 'HUMO_BOT', messageId: 78n });
    await flush();
    expect(t.alerts).toEqual([]);
    expect(t.anomalies).toEqual([]);
  });
});
