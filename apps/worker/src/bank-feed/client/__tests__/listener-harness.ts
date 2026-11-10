// The BankFeedListener test harness (bank-feed-listener.spec.ts): an in-memory lock, a fake
// client and recorders for every side effect, on a clock the test moves by hand.
import { alertRef, type BankFeedSource } from '@repo/shared';
import type { AccountCheck } from '../bank-feed-account.repository';
import type { BankFeedSession } from '../bank-feed-client';
import { BankFeedListener } from '../bank-feed-listener';
import type { PollOutcome } from '../bank-feed-poller';
import { FakeBankFeedClient } from '../fake-bank-feed.client';
import { LeaderLock } from '../leader-lock';
import type { ListenerTimeouts } from '../listener-timeouts';
import { MemoryLockStore } from './memory-lock-store';

export const NOW = new Date('2030-05-01T10:00:00.000Z');
export const BOTS: Record<BankFeedSource, bigint> = {
  HUMO_BOT: 900_000_001n,
  UZCARD_BOT: 900_000_002n,
};

/** A client whose start the test resolves by hand (a slow or hanging connect). */
export class SlowClient extends FakeBankFeedClient {
  private release: (() => void) | null = null;
  override async start(
    verifyAccount?: (accountId: bigint) => Promise<void>,
  ): Promise<BankFeedSession> {
    await new Promise<void>((resolve) => (this.release = resolve));
    return super.start(verifyAccount);
  }
  finishStart(): void {
    this.release?.();
  }
}

export function harness(
  opts: {
    store?: MemoryLockStore;
    client?: FakeBankFeedClient;
    timing?: { pollMs: number; lockMs: number; watchdogMs: number; timeouts?: ListenerTimeouts };
  } = {},
) {
  const store = opts.store ?? new MemoryLockStore();
  const client = opts.client ?? new FakeBankFeedClient();
  const clock = { ms: 0 };
  const events: string[] = [];
  const beats: Date[] = [];
  const alerts: [string, string][] = [];
  const polls: BankFeedSource[] = [];
  let pollResult: () => Promise<PollOutcome> = () => Promise.resolve('END');
  let beatResult: () => Promise<void> = () => Promise.resolve();
  let alertResult: () => Promise<void> = () => Promise.resolve();
  // An account bound on an earlier start (the common case); BOUND sends `accountBound`.
  let account: AccountCheck = 'MATCH';
  let raiseResult: () => Promise<void> = () => Promise.resolve();
  const stored = new Map<bigint, { id: string; rejectReason: string | null }>();
  const anomalies: [string, string, bigint][] = [];
  const check = jest.fn(() => {
    events.push('authorizations');
    return Promise.resolve('UNCHANGED' as const);
  });
  const stop = client.stop.bind(client);
  client.stop = () => {
    events.push('client.stop');
    return stop();
  };
  const release = store.release.bind(store);
  store.release = (key, token) => {
    events.push('lock.release');
    return release(key, token);
  };
  const listener = new BankFeedListener({
    client,
    poller: {
      poll: (source, guard) => {
        if (guard !== undefined && !guard()) return Promise.resolve('NOT_LEADER');
        polls.push(source);
        events.push(`poll:${source}`);
        return pollResult();
      },
    },
    lock: new LeaderLock(store, 'lock:bank-feed', 30_000, 15_000, () => clock.ms),
    beat: {
      beat: (at) => {
        beats.push(at);
        return beatResult();
      },
      clear: () => {
        events.push('beat.clear');
        return Promise.resolve();
      },
    },
    authorizations: { check },
    account: { check: () => Promise.resolve(account) },
    messages: { storedMessage: (_bot, id) => Promise.resolve(stored.get(id) ?? null) },
    anomaly: {
      raise: async (source, reason, id) => {
        await raiseResult();
        anomalies.push([source, reason, id]);
      },
    },
    pinnedBot: (source) => BOTS[source],
    notifier: {
      alert: async (alert, ref) => {
        await alertResult();
        alerts.push([alert, ref]);
      },
    },
    timing: opts.timing ?? { pollMs: 20_000, lockMs: 10_000, watchdogMs: 5 * 60_000 },
    now: () => new Date(NOW.getTime() + clock.ms),
  });
  // Production runs the watchdog on its own timer of the same interval (r2 m1).
  const tick = async () => {
    await listener.tick();
    await listener.watch();
    await listener.settled();
  };
  return {
    listener,
    client,
    store,
    clock,
    events,
    beats,
    alerts,
    polls,
    stored,
    anomalies,
    check,
    tick,
    pollWith: (fn: () => Promise<PollOutcome>) => (pollResult = fn),
    beatWith: (fn: () => Promise<void>) => (beatResult = fn),
    alertWith: (fn: () => Promise<void>) => (alertResult = fn),
    raiseWith: (fn: () => Promise<void>) => (raiseResult = fn),
    accountIs: (value: AccountCheck) => (account = value),
  };
}

export const flush = () => new Promise((resolve) => setImmediate(resolve));
export const stopped = (reason: Parameters<typeof alertRef.listenerStopped>[0], ms = 0) =>
  ['listenerStopped', alertRef.listenerStopped(reason, new Date(NOW.getTime() + ms))] as const;
