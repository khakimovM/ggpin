import { notifyJobSchema, type NotifyJob } from '@repo/shared';
import { buildTestEnv } from '../../../config/__tests__/test-env';
import { BankfeedDownWatchdog } from '../bankfeed-down.watchdog';
import type { WatchdogRepository } from '../watchdog.repository';
import type { WatchdogQueue } from '../heartbeat-outage';
import { WorkerDownWatchdog } from '../worker-down.watchdog';

/**
 * The watchdog over an in-memory repository and a notify queue that drops a repeated job id like
 * BullMQ does (`add` is a jest mock, so a spec can also assert it was never called). One hand-moved
 * clock stands for Redis TIME; no timer is started (ticks are called).
 */
export interface FakeFulfillJob {
  readonly id: string;
  /** BullMQ state: `waiting` / `prioritized` wait to be taken; anything else does not. */
  state: 'waiting' | 'prioritized' | 'active' | 'delayed' | 'completed';
  /** attemptsStarted: bumped every time a worker takes the job. */
  taken: number;
  readonly addedAt: number;
}

export interface WatchdogWorld {
  lastSeen: string | null;
  heartbeat: boolean;
  /** fulfill-order jobs in the order they were added (the first waiting one is taken next). */
  jobs: FakeFulfillJob[];
  /** The queue-watch key (raw, as Redis holds it). */
  queueWatch: string | null;
  /** `bankfeed:process-heartbeat` present (D-76 (4)). */
  bankfeedHeartbeat: boolean;
  /** The bankfeed sighting key (raw, as Redis holds it). */
  bankfeedLastSeen: string | null;
  /** BankFeedHealth.isAlive(): true = new top-up requests are still accepted. */
  topupGateOpen: boolean;
}

export function watchdogSetup(world: WatchdogWorld = newWorld(), added: NotifyJob[] = []) {
  const ids = new Set<string>();
  let now = new Date('2030-01-01T09:00:00.000Z').getTime();
  const repo = {
    redisNowMs: jest.fn(() => Promise.resolve(now)),
    heartbeatPresent: jest.fn(() => Promise.resolve(world.heartbeat)),
    lastSeen: jest.fn(() => Promise.resolve(world.lastSeen)),
    storeLastSeen: jest.fn((ms: number) => {
      world.lastSeen = String(ms);
      return Promise.resolve();
    }),
    storeLastSeenIfAbsent: jest.fn((ms: number) => {
      world.lastSeen ??= String(ms);
      return Promise.resolve();
    }),
    oldestWaitingFulfillJob: jest.fn(() => {
      const job = world.jobs.find((j) => j.state === 'waiting' || j.state === 'prioritized');
      return Promise.resolve(
        job === undefined ? null : { id: job.id, addedAt: job.addedAt, taken: job.taken },
      );
    }),
    fulfillJob: jest.fn((id: string) => {
      const job = world.jobs.find((j) => j.id === id);
      return Promise.resolve(job === undefined ? null : { state: job.state, taken: job.taken });
    }),
    queueWatch: jest.fn(() => Promise.resolve(world.queueWatch)),
    // The compare-and-set of the Lua script.
    replaceQueueWatch: jest.fn((expected: string | null, next: string | null) => {
      if (world.queueWatch !== expected) return Promise.resolve(false);
      world.queueWatch = next;
      return Promise.resolve(true);
    }),
    bankfeedHeartbeatPresent: jest.fn(() => Promise.resolve(world.bankfeedHeartbeat)),
    bankfeedLastSeen: jest.fn(() => Promise.resolve(world.bankfeedLastSeen)),
    storeBankfeedLastSeen: jest.fn((ms: number) => {
      world.bankfeedLastSeen = String(ms);
      return Promise.resolve();
    }),
    storeBankfeedLastSeenIfAbsent: jest.fn((ms: number) => {
      world.bankfeedLastSeen ??= String(ms);
      return Promise.resolve();
    }),
  };
  const add = jest.fn((_name: string, data: unknown, opts: { jobId: string }) => {
    if (!ids.has(opts.jobId)) {
      ids.add(opts.jobId);
      added.push(notifyJobSchema.parse(data));
    }
    return Promise.resolve({});
  });
  // The top-up gate (BankFeedHealth.isAlive): closed unless a spec opens it.
  const gate = { isAlive: jest.fn(() => Promise.resolve(world.topupGateOpen)) };
  const env = buildTestEnv({ WORKER_DOWN_ALERT_AFTER_MS: '120000' });
  const build = () =>
    new WorkerDownWatchdog(
      repo as unknown as WatchdogRepository,
      { add } as unknown as WatchdogQueue,
      env,
    );
  const buildBankfeed = () =>
    new BankfeedDownWatchdog(
      repo as unknown as WatchdogRepository,
      { add } as unknown as WatchdogQueue,
      env,
      gate,
    );
  return {
    world,
    added,
    add,
    repo,
    gate,
    watchdog: build(),
    /** The bankfeed watchdog of the same API: the same Redis and notify queue (D-76 (4)). */
    bankfeed: buildBankfeed(),
    /** Another API instance: the same Redis, the same notify queue, its own process. */
    otherInstance: build,
    /** The bankfeed watchdog of another API instance (same Redis, queue and gate). */
    otherBankfeed: buildBankfeed,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    /** A fulfill-order job added now, waiting. */
    enqueue: (id: string): FakeFulfillJob => {
      const job: FakeFulfillJob = { id, state: 'waiting', taken: 0, addedAt: now };
      world.jobs.push(job);
      return job;
    },
  };
}

export function newWorld(): WatchdogWorld {
  return {
    lastSeen: null,
    heartbeat: false,
    jobs: [],
    queueWatch: null,
    bankfeedHeartbeat: false,
    bankfeedLastSeen: null,
    topupGateOpen: false,
  };
}
