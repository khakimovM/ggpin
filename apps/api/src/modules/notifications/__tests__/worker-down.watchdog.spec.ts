import { Logger } from '@nestjs/common';
import { buildTestEnv } from '../../../config/__tests__/test-env';
import type { WatchdogRepository } from '../watchdog.repository';
import { WorkerDownWatchdog } from '../worker-down.watchdog';
import { watchdogSetup } from './watchdog.test-fixtures';

describe('worker-down watchdog (D-34 (12))', () => {
  beforeEach(() => {
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });
  afterEach(() => jest.restoreAllMocks());

  it('one outage = one workerDown alert; a new outage after recovery = one more', async () => {
    const t = watchdogSetup();
    t.world.heartbeat = true;
    await expect(t.watchdog.tick()).resolves.toEqual({ worker: 'UP', queue: 'OK' });
    const firstSeen = t.world.lastSeen;
    t.world.heartbeat = false;
    for (let i = 0; i < 3; i += 1) {
      t.advance(30_000);
      await expect(t.watchdog.tick()).resolves.toMatchObject({ worker: 'DOWN' });
    }
    t.advance(30_000); // 120 s since the last sighting
    await expect(t.watchdog.tick()).resolves.toMatchObject({ worker: 'ALERTED' });
    for (let i = 0; i < 10; i += 1) {
      t.advance(30_000);
      await t.watchdog.tick();
    }
    expect(t.added).toEqual([{ kind: 'OWNER_ALERT', alert: 'workerDown', refId: firstSeen }]);

    t.world.heartbeat = true;
    t.advance(30_000);
    await expect(t.watchdog.tick()).resolves.toMatchObject({ worker: 'UP' });
    const secondSeen = t.world.lastSeen;
    t.world.heartbeat = false;
    t.advance(120_000);
    await expect(t.watchdog.tick()).resolves.toMatchObject({ worker: 'ALERTED' });
    expect(t.added.map((j) => j.refId)).toEqual([firstSeen, secondSeen]);
    expect(secondSeen).not.toBe(firstSeen);
  });

  it('the sighting is stored and compared in Redis time (TIME), not the API clock', async () => {
    const t = watchdogSetup();
    t.world.heartbeat = true;
    t.repo.redisNowMs.mockResolvedValueOnce(1_893_400_000_123);
    await t.watchdog.tick();
    expect(t.world.lastSeen).toBe('1893400000123');
  });

  it('a heartbeat back before the threshold: no alert, and the count starts over', async () => {
    const t = watchdogSetup();
    t.world.heartbeat = true;
    await t.watchdog.tick();
    t.world.heartbeat = false;
    t.advance(119_999);
    await expect(t.watchdog.tick()).resolves.toMatchObject({ worker: 'DOWN' });
    t.world.heartbeat = true;
    t.advance(1);
    await expect(t.watchdog.tick()).resolves.toMatchObject({ worker: 'UP' });
    t.world.heartbeat = false;
    t.advance(119_999);
    await expect(t.watchdog.tick()).resolves.toMatchObject({ worker: 'DOWN' });
    expect(t.add).not.toHaveBeenCalled();
  });

  it('a restarted API (or a second instance) in the same outage adds nothing new', async () => {
    const first = watchdogSetup();
    first.world.heartbeat = true;
    await first.watchdog.tick();
    first.world.heartbeat = false;
    first.advance(150_000);
    await first.watchdog.tick();
    const restarted = watchdogSetup(first.world, first.added);
    restarted.advance(200_000);
    await expect(restarted.watchdog.tick()).resolves.toMatchObject({ worker: 'ALERTED' });
    // Same refId as the first instance's alert: BullMQ would drop it (same notify job id).
    expect(new Set(first.added.map((j) => j.refId)).size).toBe(1);
  });

  it('never seen a heartbeat: counts from its own first look', async () => {
    const t = watchdogSetup();
    await expect(t.watchdog.tick()).resolves.toMatchObject({ worker: 'DOWN' });
    expect(t.repo.storeLastSeenIfAbsent).toHaveBeenCalledTimes(1);
    t.advance(119_999);
    await expect(t.watchdog.tick()).resolves.toMatchObject({ worker: 'DOWN' });
    t.advance(1);
    await expect(t.watchdog.tick()).resolves.toMatchObject({ worker: 'ALERTED' });
    expect(t.added).toHaveLength(1);
  });

  // Audit P1: a value in the future (an edited key, a clock that jumped back) used to win
  // against SET NX forever and silence every outage.
  it.each([
    ['6 h in the future', (now: number) => String(now + 6 * 3_600_000)],
    ['one tick and 1 ms ahead', (now: number) => String(now + 30_001)],
    ['negative', () => '-5'],
    ['not a number', () => 'garbage'],
  ])('an untrusted last sighting (%s) is replaced and the outage still alerts', async (_l, bad) => {
    const t = watchdogSetup();
    t.world.lastSeen = bad(t.now());
    await expect(t.watchdog.tick()).resolves.toMatchObject({ worker: 'DOWN' });
    expect(t.world.lastSeen).toBe(String(t.now()));
    t.advance(120_000);
    await expect(t.watchdog.tick()).resolves.toMatchObject({ worker: 'ALERTED' });
    expect(t.added).toHaveLength(1);
  });

  it('a sighting up to one tick ahead (clock jitter) is kept', async () => {
    const t = watchdogSetup();
    t.world.lastSeen = String(t.now() + 30_000);
    await t.watchdog.tick();
    expect(t.world.lastSeen).toBe(String(t.now() + 30_000));
  });

  it('a Redis failure is FAILED, never a rejection and never an alert', async () => {
    const add = jest.fn();
    const warn = jest.spyOn(Logger.prototype, 'warn');
    const down = () => Promise.reject(new Error('ECONNREFUSED'));
    const broken = new WorkerDownWatchdog(
      {
        redisNowMs: down,
        heartbeatPresent: down,
        lastSeen: down,
        oldestWaitingFulfillJob: down,
      } as unknown as WatchdogRepository,
      { add },
      buildTestEnv(),
    );
    await expect(broken.tick()).resolves.toEqual({ worker: 'FAILED', queue: 'FAILED' });
    await expect(broken.tick()).resolves.toEqual({ worker: 'FAILED', queue: 'FAILED' });
    expect(add).not.toHaveBeenCalled();
    // One warning per check per failure streak, not one per tick.
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('with a bot: an unref’d 30 s timer, cleared on shutdown', async () => {
    const watchdog = new WorkerDownWatchdog(
      {} as WatchdogRepository,
      { add: jest.fn() },
      buildTestEnv({ TELEGRAM_BOT_MODE: 'polling' }),
    );
    const start = jest.spyOn(global, 'setInterval');
    const stop = jest.spyOn(global, 'clearInterval');
    watchdog.onApplicationBootstrap();
    expect(start).toHaveBeenCalledWith(expect.any(Function), 30_000);
    const timer = start.mock.results[0]?.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    await watchdog.beforeApplicationShutdown();
    expect(stop).toHaveBeenCalledWith(timer);
  });

  it('does not start a timer with TELEGRAM_BOT_MODE=off', () => {
    const spy = jest.spyOn(global, 'setInterval');
    const t = watchdogSetup();
    t.watchdog.onApplicationBootstrap();
    expect(spy).not.toHaveBeenCalled();
  });
});
