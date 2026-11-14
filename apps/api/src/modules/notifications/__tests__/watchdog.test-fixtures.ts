import { notifyJobSchema, type NotifyJob } from '@repo/shared';
import { buildTestEnv } from '../../../config/__tests__/test-env';
import type { WatchdogRepository } from '../watchdog.repository';
import { WorkerDownWatchdog, type WatchdogQueue } from '../worker-down.watchdog';

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
  };
  const add = jest.fn((_name: string, data: unknown, opts: { jobId: string }) => {
    if (!ids.has(opts.jobId)) {
      ids.add(opts.jobId);
      added.push(notifyJobSchema.parse(data));
    }
    return Promise.resolve({});
  });
  const env = buildTestEnv({ WORKER_DOWN_ALERT_AFTER_MS: '120000' });
  const build = () =>
    new WorkerDownWatchdog(
      repo as unknown as WatchdogRepository,
      { add } as unknown as WatchdogQueue,
      env,
    );
  return {
    world,
    added,
    add,
    repo,
    watchdog: build(),
    /** Another API instance: the same Redis, the same notify queue, its own process. */
    otherInstance: build,
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
  return { lastSeen: null, heartbeat: false, jobs: [], queueWatch: null };
}
