import { Logger } from '@nestjs/common';
import type { NotifyJob } from '@repo/shared';
import { buildTestEnv } from '../../../config/__tests__/test-env';
import { BankfeedDownWatchdog } from '../bankfeed-down.watchdog';
import type { WatchdogRepository } from '../watchdog.repository';
import { watchdogSetup } from './watchdog.test-fixtures';

const alertOf = (job: NotifyJob): string => (job.kind === 'OWNER_ALERT' ? job.alert : job.kind);

describe('bankfeed-down watchdog (D-76 (4))', () => {
  beforeEach(() => {
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });
  afterEach(() => jest.restoreAllMocks());

  it('no heartbeat: one bankfeedDown after the threshold, never repeated in the same outage', async () => {
    const t = watchdogSetup();
    t.world.bankfeedHeartbeat = true;
    await expect(t.bankfeed.tick()).resolves.toBe('UP');
    const seen = t.world.bankfeedLastSeen;
    t.world.bankfeedHeartbeat = false;
    t.advance(119_999);
    await expect(t.bankfeed.tick()).resolves.toBe('DOWN');
    expect(t.add).not.toHaveBeenCalled();
    t.advance(1);
    await expect(t.bankfeed.tick()).resolves.toBe('ALERTED');
    for (let i = 0; i < 10; i += 1) {
      t.advance(30_000);
      await expect(t.bankfeed.tick()).resolves.toBe('ALERTED');
    }
    expect(t.added).toEqual([{ kind: 'OWNER_ALERT', alert: 'bankfeedDown', refId: seen }]);
    // Every repeat builds the same notify job id (BullMQ drops it).
    expect(new Set(t.add.mock.calls.map((c) => c[2].jobId)).size).toBe(1);
  });

  it('recovery re-arms: the next outage is one more alert with a new refId', async () => {
    const t = watchdogSetup();
    t.world.bankfeedHeartbeat = true;
    await t.bankfeed.tick();
    const first = t.world.bankfeedLastSeen;
    t.world.bankfeedHeartbeat = false;
    t.advance(150_000);
    await expect(t.bankfeed.tick()).resolves.toBe('ALERTED');

    t.world.bankfeedHeartbeat = true;
    t.advance(30_000);
    await expect(t.bankfeed.tick()).resolves.toBe('UP');
    const second = t.world.bankfeedLastSeen;
    t.world.bankfeedHeartbeat = false;
    t.advance(120_000);
    await expect(t.bankfeed.tick()).resolves.toBe('ALERTED');
    expect(t.added.map((j) => [alertOf(j), j.refId])).toEqual([
      ['bankfeedDown', first],
      ['bankfeedDown', second],
    ]);
    expect(second).not.toBe(first);
  });

  it('a restarted API in the same outage builds the same refId', async () => {
    const first = watchdogSetup();
    first.world.bankfeedHeartbeat = true;
    await first.bankfeed.tick();
    first.world.bankfeedHeartbeat = false;
    first.advance(150_000);
    await first.bankfeed.tick();
    const restarted = watchdogSetup(first.world, first.added);
    restarted.advance(200_000);
    await expect(restarted.bankfeed.tick()).resolves.toBe('ALERTED');
    expect(new Set(first.added.map((j) => j.refId)).size).toBe(1);
    // The same notify job id from both processes: BullMQ would drop the restarted one's add.
    const jobIds = [...first.add.mock.calls, ...restarted.add.mock.calls].map((c) => c[2].jobId);
    expect(jobIds).toHaveLength(2);
    expect(new Set(jobIds).size).toBe(1);
  });

  it('two API instances ticking in turn: one alert, one job id', async () => {
    const t = watchdogSetup();
    const other = t.otherBankfeed();
    t.world.bankfeedHeartbeat = true;
    await t.bankfeed.tick();
    t.world.bankfeedHeartbeat = false;
    for (let i = 0; i < 12; i += 1) {
      t.advance(15_000);
      await (i % 2 === 0 ? other : t.bankfeed).tick();
    }
    expect(t.added).toHaveLength(1);
    expect(t.add.mock.calls.length).toBeGreaterThan(1);
    expect(new Set(t.add.mock.calls.map((c) => c[2].jobId)).size).toBe(1);
  });

  // CR #1: the text says new requests are stopped, so it waits for the top-up gate to close.
  describe('the top-up gate (BankFeedHealth.isAlive)', () => {
    it('over the threshold with the gate still open: ARMED, no alert', async () => {
      const t = watchdogSetup();
      t.world.bankfeedHeartbeat = true;
      await t.bankfeed.tick();
      t.world.bankfeedHeartbeat = false;
      t.world.topupGateOpen = true;
      for (let i = 0; i < 6; i += 1) {
        t.advance(30_000);
        await t.bankfeed.tick();
      }
      await expect(t.bankfeed.tick()).resolves.toBe('ARMED');
      expect(t.add).not.toHaveBeenCalled();
    });

    it('the gate closes on a later tick: one alert, with the refId of the outage start', async () => {
      const t = watchdogSetup();
      t.world.bankfeedHeartbeat = true;
      await t.bankfeed.tick();
      const seen = t.world.bankfeedLastSeen;
      t.world.bankfeedHeartbeat = false;
      t.world.topupGateOpen = true;
      t.advance(150_000);
      await expect(t.bankfeed.tick()).resolves.toBe('ARMED');
      t.advance(30_000);
      await expect(t.bankfeed.tick()).resolves.toBe('ARMED');
      t.world.topupGateOpen = false;
      t.advance(30_000);
      await expect(t.bankfeed.tick()).resolves.toBe('ALERTED');
      t.advance(30_000);
      await expect(t.bankfeed.tick()).resolves.toBe('ALERTED');
      expect(t.added).toEqual([{ kind: 'OWNER_ALERT', alert: 'bankfeedDown', refId: seen }]);
    });

    it('the gate is only asked over the threshold (no read while UP or DOWN)', async () => {
      const t = watchdogSetup();
      t.world.bankfeedHeartbeat = true;
      await t.bankfeed.tick();
      t.world.bankfeedHeartbeat = false;
      t.advance(60_000);
      await expect(t.bankfeed.tick()).resolves.toBe('DOWN');
      expect(t.gate.isAlive).not.toHaveBeenCalled();
    });

    it('a gate read that throws counts as closed (the gate fails closed): the alert goes', async () => {
      const t = watchdogSetup();
      t.gate.isAlive.mockRejectedValue(new Error('ECONNREFUSED'));
      await t.bankfeed.tick();
      t.advance(120_000);
      await expect(t.bankfeed.tick()).resolves.toBe('ALERTED');
      expect(t.added.map(alertOf)).toEqual(['bankfeedDown']);
    });

    it('an open gate never holds workerDown back', async () => {
      const t = watchdogSetup();
      t.world.topupGateOpen = true;
      await t.watchdog.tick();
      await t.bankfeed.tick();
      t.advance(120_000);
      await expect(t.watchdog.tick()).resolves.toMatchObject({ worker: 'ALERTED' });
      await expect(t.bankfeed.tick()).resolves.toBe('ARMED');
      expect(t.added.map(alertOf)).toEqual(['workerDown']);
    });
  });

  it.each([
    ['6 h in the future', (now: number) => String(now + 6 * 3_600_000)],
    ['not a number', () => 'garbage'],
  ])('an untrusted sighting (%s) is replaced and still alerts', async (_l, bad) => {
    const t = watchdogSetup();
    t.world.bankfeedLastSeen = bad(t.now());
    await expect(t.bankfeed.tick()).resolves.toBe('DOWN');
    expect(t.world.bankfeedLastSeen).toBe(String(t.now()));
    t.advance(120_000);
    await expect(t.bankfeed.tick()).resolves.toBe('ALERTED');
    expect(t.added).toHaveLength(1);
  });

  describe('independent of workerDown', () => {
    it('a dead fulfillment worker with a live bankfeed: only workerDown', async () => {
      const t = watchdogSetup();
      t.world.bankfeedHeartbeat = true;
      for (let i = 0; i < 6; i += 1) {
        await t.watchdog.tick();
        await expect(t.bankfeed.tick()).resolves.toBe('UP');
        t.advance(30_000);
      }
      expect(t.added.map(alertOf)).toEqual(['workerDown']);
      expect(t.world.lastSeen).not.toBe(t.world.bankfeedLastSeen);
    });

    it('a dead bankfeed with a live worker: only bankfeedDown', async () => {
      const t = watchdogSetup();
      t.world.heartbeat = true;
      for (let i = 0; i < 6; i += 1) {
        await expect(t.watchdog.tick()).resolves.toMatchObject({ worker: 'UP' });
        await t.bankfeed.tick();
        t.advance(30_000);
      }
      expect(t.added.map(alertOf)).toEqual(['bankfeedDown']);
    });

    it('both dead from the same moment: two alerts, one each, same refId but distinct job ids', async () => {
      const t = watchdogSetup();
      t.world.heartbeat = true;
      t.world.bankfeedHeartbeat = true;
      await t.watchdog.tick();
      await t.bankfeed.tick();
      t.world.heartbeat = false;
      t.world.bankfeedHeartbeat = false;
      for (let i = 0; i < 8; i += 1) {
        t.advance(30_000);
        await t.watchdog.tick();
        await t.bankfeed.tick();
      }
      expect(t.added.map(alertOf).sort()).toEqual(['bankfeedDown', 'workerDown']);
      const [a, b] = t.added;
      expect(a?.refId).toBe(b?.refId);
      expect(new Set(t.add.mock.calls.map((c) => c[2].jobId)).size).toBe(2);
    });

    it('one recovering does not re-arm or silence the other', async () => {
      const t = watchdogSetup();
      await t.watchdog.tick();
      await t.bankfeed.tick();
      t.advance(120_000);
      await t.watchdog.tick();
      await t.bankfeed.tick();
      expect(t.added).toHaveLength(2);
      t.world.heartbeat = true; // only the worker comes back
      t.advance(30_000);
      await t.watchdog.tick();
      await expect(t.bankfeed.tick()).resolves.toBe('ALERTED');
      expect(t.added).toHaveLength(2);
    });
  });

  it('a Redis failure is FAILED, never a rejection and never an alert; one warning per streak', async () => {
    const add = jest.fn();
    const warn = jest.spyOn(Logger.prototype, 'warn');
    const down = () => Promise.reject(new Error('ECONNREFUSED'));
    const broken = new BankfeedDownWatchdog(
      {
        redisNowMs: down,
        bankfeedHeartbeatPresent: down,
        bankfeedLastSeen: down,
      } as unknown as WatchdogRepository,
      { add },
      buildTestEnv(),
      { isAlive: jest.fn(() => Promise.resolve(false)) },
    );
    await expect(broken.tick()).resolves.toBe('FAILED');
    await expect(broken.tick()).resolves.toBe('FAILED');
    expect(add).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a heartbeat read failure after a sighting never alerts either', async () => {
    const t = watchdogSetup();
    t.world.bankfeedHeartbeat = true;
    await t.bankfeed.tick();
    t.repo.bankfeedHeartbeatPresent.mockRejectedValue(new Error('ECONNRESET'));
    for (let i = 0; i < 10; i += 1) {
      t.advance(30_000);
      await expect(t.bankfeed.tick()).resolves.toBe('FAILED');
    }
    expect(t.add).not.toHaveBeenCalled();
  });

  it('with a bot: an unref’d 30 s timer, cleared on shutdown', async () => {
    const watchdog = new BankfeedDownWatchdog(
      {} as WatchdogRepository,
      { add: jest.fn() },
      buildTestEnv({ TELEGRAM_BOT_MODE: 'polling' }),
      { isAlive: jest.fn(() => Promise.resolve(false)) },
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
    watchdogSetup().bankfeed.onApplicationBootstrap();
    expect(spy).not.toHaveBeenCalled();
  });
});
