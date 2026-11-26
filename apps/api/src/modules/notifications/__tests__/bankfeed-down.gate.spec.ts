import { Logger } from '@nestjs/common';
import { watchdogSetup } from './watchdog.test-fixtures';

// The bankfeedDown alert waits for the top-up gate (CR #1); how that wait is logged (CR delta).
// buildTestEnv's BANK_FEED_HEARTBEAT_MAX_AGE_SEC is the default 120 s.
describe('bankfeed-down watchdog: holding for the top-up gate', () => {
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  /** An outage over the threshold with the gate open: the first ARMED tick. */
  async function armed() {
    const t = watchdogSetup();
    t.world.bankfeedHeartbeat = true;
    await t.bankfeed.tick();
    t.world.bankfeedHeartbeat = false;
    t.world.topupGateOpen = true;
    t.advance(120_000);
    await expect(t.bankfeed.tick()).resolves.toBe('ARMED');
    return t;
  }

  it('held longer than BANK_FEED_HEARTBEAT_MAX_AGE_SEC: one error, minutes only', async () => {
    const t = await armed();
    t.advance(120_000);
    await expect(t.bankfeed.tick()).resolves.toBe('ARMED');
    expect(error).not.toHaveBeenCalled();
    t.advance(30_000);
    await t.bankfeed.tick();
    for (let i = 0; i < 10; i += 1) {
      t.advance(30_000);
      await t.bankfeed.tick();
    }
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      'bankfeed down but the top-up gate is still open after 2 min: ' +
        'the listener heartbeat is written without a bankfeed process heartbeat',
    );
    expect(t.add).not.toHaveBeenCalled();
  });

  it('a new outage is held and logged afresh', async () => {
    const t = await armed();
    t.advance(150_000);
    await t.bankfeed.tick();
    expect(error).toHaveBeenCalledTimes(1);
    t.world.bankfeedHeartbeat = true;
    t.advance(30_000);
    await expect(t.bankfeed.tick()).resolves.toBe('UP');
    t.world.bankfeedHeartbeat = false;
    t.advance(120_000);
    await expect(t.bankfeed.tick()).resolves.toBe('ARMED');
    t.advance(150_000);
    await t.bankfeed.tick();
    expect(error).toHaveBeenCalledTimes(2);
  });

  it('ALERTED, then the gate opens again: ARMED, still one alert, no "held" warning', async () => {
    const t = await armed();
    expect(warn).toHaveBeenCalledWith('bankfeed down: alert held until the top-up gate closes');
    warn.mockClear();
    t.world.topupGateOpen = false;
    t.advance(30_000);
    await expect(t.bankfeed.tick()).resolves.toBe('ALERTED');
    t.world.topupGateOpen = true;
    t.advance(30_000);
    await expect(t.bankfeed.tick()).resolves.toBe('ARMED');
    t.world.topupGateOpen = false;
    t.advance(30_000);
    await expect(t.bankfeed.tick()).resolves.toBe('ALERTED');
    expect(t.added).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });
});
