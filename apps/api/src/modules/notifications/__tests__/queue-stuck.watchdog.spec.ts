import { Logger } from '@nestjs/common';
import { QUEUE_STUCK_AFTER_MS } from '@repo/shared';
import { watchdogSetup, type FakeFulfillJob } from './watchdog.test-fixtures';

// queueStuck from the API watchdog (S6 review M2, audit M-2, re-review "episodes"): ONE followed
// job, timed from when the watchdog first saw it waiting (Redis clock), never from BullMQ's add
// time. Synthetic job ids only.
const MIN = 60_000;
const TICK = 30_000;

type Setup = ReturnType<typeof watchdogSetup>;

function stuckSetup(): Setup {
  const t = watchdogSetup();
  t.world.heartbeat = true;
  return t;
}

// Ticks every 30 s for `ms`, calling `between` before each tick (the worker's moves).
async function run(t: Setup, ms: number, between: () => void = () => undefined): Promise<void> {
  for (let passed = 0; passed < ms; passed += TICK) {
    t.advance(TICK);
    between();
    await t.watchdog.tick();
  }
}

// A worker that takes the next waiting job every `everyMs` and finishes the one before.
function serialWorker(t: Setup, everyMs: number, waits: number[] = []): () => void {
  let since = everyMs;
  return () => {
    since += TICK;
    if (since < everyMs) return;
    since = 0;
    for (const job of t.world.jobs) if (job.state === 'active') job.state = 'completed';
    const next = t.world.jobs.find((j) => j.state === 'waiting');
    if (next === undefined) return;
    waits.push(t.now() - next.addedAt);
    take(next);
  };
}

function take(job: FakeFulfillJob): void {
  job.state = 'active';
  job.taken += 1;
}

const refIds = (t: Setup) => t.added.map((j) => j.refId);

describe('queueStuck watchdog (episodes)', () => {
  beforeEach(() => {
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });
  afterEach(() => jest.restoreAllMocks());

  it('one job untaken for more than 5 min since first seen: one alert, refId = id + first seen', async () => {
    const t = stuckSetup();
    t.enqueue('cmorder1');
    const firstSeen = t.now();
    await expect(t.watchdog.tick()).resolves.toEqual({ worker: 'UP', queue: 'OK' });
    t.advance(QUEUE_STUCK_AFTER_MS); // exactly 5 min: not yet
    await expect(t.watchdog.tick()).resolves.toMatchObject({ queue: 'OK' });
    t.advance(1);
    await expect(t.watchdog.tick()).resolves.toMatchObject({ queue: 'STUCK' });
    expect(t.added).toEqual([
      { kind: 'OWNER_ALERT', alert: 'queueStuck', refId: `cmorder1_${String(firstSeen)}` },
    ]);
    await run(t, 10 * MIN);
    expect(t.added).toHaveLength(1); // re-added each tick, dropped by the notify job id
    expect(t.add.mock.calls.length).toBeGreaterThan(20);
  });

  it('Q1: a healthy serial worker (12 orders, ~60 s each) never alerts', async () => {
    const t = stuckSetup();
    const jobs = Array.from({ length: 12 }, (_, i) => t.enqueue(`cmorder${String(i + 1)}`));
    await t.watchdog.tick();
    const waits: number[] = [];
    await run(t, 15 * MIN, serialWorker(t, MIN, waits));
    expect(jobs.every((j) => j.state === 'completed' || j.state === 'active')).toBe(true);
    expect(t.add).not.toHaveBeenCalled();
    // The last order did wait ~11 min since it was ADDED: the old add-time rule alerted here.
    expect(Math.max(...waits)).toBeGreaterThan(2 * QUEUE_STUCK_AFTER_MS);
  });

  it('Q2: a 20 min outage with 8 orders, then a drain: exactly one alert, for the first', async () => {
    const t = stuckSetup();
    for (let i = 1; i <= 8; i += 1) t.enqueue(`cmorder${String(i)}`);
    const firstSeen = t.now();
    await t.watchdog.tick();
    await run(t, 20 * MIN);
    await run(t, 15 * MIN, serialWorker(t, MIN));
    expect(refIds(t)).toEqual([`cmorder1_${String(firstSeen)}`]);
    expect(t.world.jobs.every((j) => j.state === 'completed')).toBe(true);
    expect(t.world.queueWatch).toBeNull(); // empty queue: the key is cleared
  });

  it('a retried old job back in wait gets a fresh 5 minutes, then alerts', async () => {
    const t = stuckSetup();
    const job = t.enqueue('cmorder1');
    await t.watchdog.tick();
    take(job);
    await run(t, MIN);
    job.state = 'delayed'; // failed, backoff
    await run(t, 60 * MIN);
    job.state = 'waiting'; // back in wait, BullMQ add time now an hour old
    let backSince = 0;
    await run(t, TICK, () => {
      backSince = t.now();
    });
    await run(t, QUEUE_STUCK_AFTER_MS - TICK);
    expect(t.add).not.toHaveBeenCalled();
    await run(t, 2 * TICK);
    expect(refIds(t)).toEqual([`cmorder1_${String(backSince)}`]);
  });

  it('a job taken and back in wait between two ticks is followed afresh (take count)', async () => {
    const t = stuckSetup();
    const job = t.enqueue('cmorder1');
    await t.watchdog.tick();
    await run(t, 4 * MIN);
    job.taken += 1; // taken, failed with no backoff, waiting again: still `waiting` at each look
    await run(t, 2 * MIN);
    expect(t.add).not.toHaveBeenCalled();
    await run(t, 4 * MIN);
    expect(t.added).toHaveLength(1);
  });

  // Audit P2: a worker that boots, beats once, crashes and restarts ~90 s later never misses its
  // heartbeat for 120 s, so workerDown stays silent. The job it never takes is the signal.
  it('P2 crash loop: the heartbeat comes and goes, the job waits, one queueStuck', async () => {
    const t = stuckSetup();
    t.enqueue('cmorder1');
    const outcomes: string[] = [];
    for (let cycle = 0; cycle < 10; cycle += 1) {
      t.world.heartbeat = true;
      t.advance(TICK);
      outcomes.push((await t.watchdog.tick()).worker);
      t.world.heartbeat = false;
      for (let i = 0; i < 3; i += 1) {
        t.advance(TICK);
        outcomes.push((await t.watchdog.tick()).worker);
      }
    }
    expect(outcomes).not.toContain('ALERTED'); // the heartbeat alone sees nothing
    expect(t.added.map((j) => (j.kind === 'OWNER_ALERT' ? j.alert : j.kind))).toEqual([
      'queueStuck',
    ]);
  });

  it('two API instances: one first sighting (compare-and-set), one refId', async () => {
    const t = stuckSetup();
    const other = t.otherInstance();
    t.enqueue('cmorder1');
    const firstSeen = t.now();
    await Promise.all([t.watchdog.tick(), other.tick()]);
    const writes = await Promise.all(
      t.repo.replaceQueueWatch.mock.results.map((r) => r.value as Promise<boolean>),
    );
    expect(writes.sort()).toEqual([false, true]);
    for (let i = 0; i < 24; i += 1) {
      t.advance(TICK);
      await (i % 2 === 0 ? other.tick() : t.watchdog.tick());
    }
    const sent = t.add.mock.calls.map(([, data]) => (data as { refId: string }).refId);
    expect(new Set(sent)).toEqual(new Set([`cmorder1_${String(firstSeen)}`]));
    expect(t.added).toHaveLength(1);
  });

  it('a sighting another instance wrote after our read is kept, not overwritten', async () => {
    const t = stuckSetup();
    t.enqueue('cmorder1');
    const theirs = JSON.stringify({ id: 'cmorder1', at: t.now() - 4 * MIN, taken: 0 });
    // We read "nothing followed"; the other instance writes its older sighting right after.
    t.repo.queueWatch.mockImplementationOnce(() => {
      queueMicrotask(() => {
        t.world.queueWatch = theirs;
      });
      return Promise.resolve(null);
    });
    await t.watchdog.tick();
    expect(t.world.queueWatch).toBe(theirs);
    await run(t, MIN + TICK);
    expect(t.added).toHaveLength(1); // their 4 min + 1.5 min: past 5 min from THEIR sighting
  });

  it.each([
    ['garbage', 'not json'],
    ['a foreign shape', JSON.stringify({ id: 'cmorder1', at: 1, taken: 0, extra: true })],
    ['a future sighting', 'FUTURE'],
  ])('%s in the key is replaced by now and cannot silence the alert', async (_label, value) => {
    const t = stuckSetup();
    t.enqueue('cmorder1');
    const future = { id: 'cmorder1', at: t.now() + 6 * 60 * MIN, taken: 0 };
    t.world.queueWatch = value === 'FUTURE' ? JSON.stringify(future) : value;
    const rewrittenAt = t.now();
    await t.watchdog.tick();
    expect(JSON.parse(t.world.queueWatch ?? 'null')).toEqual({
      id: 'cmorder1',
      at: rewrittenAt,
      taken: 0,
    });
    await run(t, QUEUE_STUCK_AFTER_MS + TICK);
    expect(refIds(t)).toEqual([`cmorder1_${String(rewrittenAt)}`]);
  });

  it('a followed job that is gone: the next waiting job is followed from now', async () => {
    const t = stuckSetup();
    t.enqueue('cmorderA');
    await t.watchdog.tick();
    t.world.jobs = []; // removed (the order was handled elsewhere)
    t.enqueue('cmorderB');
    t.advance(TICK);
    await t.watchdog.tick();
    expect(JSON.parse(t.world.queueWatch ?? 'null')).toMatchObject({ id: 'cmorderB', at: t.now() });
  });

  it('a failing queue read does not stop the heartbeat check, and the reverse', async () => {
    const t = stuckSetup();
    t.repo.queueWatch.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(t.watchdog.tick()).resolves.toEqual({ worker: 'UP', queue: 'FAILED' });
    t.enqueue('cmorder1');
    await t.watchdog.tick();
    t.advance(6 * MIN);
    t.repo.heartbeatPresent.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(t.watchdog.tick()).resolves.toEqual({ worker: 'FAILED', queue: 'STUCK' });
  });
});
