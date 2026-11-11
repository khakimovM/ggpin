import { Logger } from '@nestjs/common';
import {
  WEBHOOK_CALL_TIMEOUT_MS,
  WEBHOOK_RETRY_FIRST_DELAY_MS,
  WEBHOOK_RETRY_MAX_DELAY_MS,
  WEBHOOK_SETUP_TIMEOUT_MS,
} from '../bot-lifecycle.service';
import { WEBHOOK_CONFIG, bootstrap, flush, printed, setup } from './bot-lifecycle-webhook-helpers';

let logged: jest.SpyInstance;
beforeEach(() => {
  jest.useFakeTimers();
  logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('BotLifecycleService webhook mode: timeouts, alerts and shutdown', () => {
  // D-29.5 / review #1: the first attempt is in the background too.
  it('a setWebhook that never answers does not block boot; the attempt times out and is retried', async () => {
    const { fake, service } = setup();
    fake.bot.api.config.use((prev, method, payload, signal) =>
      method === 'setWebhook' ? new Promise(() => undefined) : prev(method, payload, signal),
    );
    // resolves at once although the Telegram call never returns (a hang here fails the test)
    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    await flush();
    expect(fake.callsOf('setMyCommands')).toHaveLength(0);

    await jest.advanceTimersByTimeAsync(WEBHOOK_CALL_TIMEOUT_MS);
    expect(printed(logged.mock.calls)).toContain('setWebhook timed out');

    await jest.advanceTimersByTimeAsync(WEBHOOK_RETRY_FIRST_DELAY_MS); // second attempt starts
    await service.beforeApplicationShutdown();
  });

  // review m5: once the webhook is set only the SETUP is retried, its failures keep counting
  // until it succeeds, and a setup timeout alerts the owner like a webhook failure does.
  it('a setup that keeps hanging retries only the setup, counts failures and alerts the owner', async () => {
    const { fake, enqueue, service } = setup();
    let hang = true;
    fake.bot.api.config.use((prev, method, payload, signal) =>
      method === 'setMyCommands' && hang
        ? new Promise(() => undefined)
        : prev(method, payload, signal),
    );
    await bootstrap(service);
    expect(fake.callsOf('setWebhook')).toHaveLength(1);

    // failure 1 at 30 s (setup timeout), retry after 30 s, failure 2, retry after 60 s, failure 3
    await jest.advanceTimersByTimeAsync(WEBHOOK_SETUP_TIMEOUT_MS);
    expect(printed(logged.mock.calls)).toContain('bot setup timed out');
    expect(enqueue).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(
      WEBHOOK_RETRY_FIRST_DELAY_MS + WEBHOOK_SETUP_TIMEOUT_MS + 2 * WEBHOOK_RETRY_FIRST_DELAY_MS,
    );
    await jest.advanceTimersByTimeAsync(WEBHOOK_SETUP_TIMEOUT_MS);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [jobId, job] = enqueue.mock.calls[0] as [string, { chatId: string; text: string }];
    expect(jobId).toMatch(/^alert-setupFailed-[a-z0-9]+x3-555000$/);
    expect(job.text).toContain('3');
    // never re-registered the webhook
    expect(fake.callsOf('setWebhook')).toHaveLength(1);

    // the setup recovers: counters reset and retries stop
    hang = false;
    await jest.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(fake.callsOf('setMyCommands').length).toBeGreaterThan(0); // the hung ones were never recorded
    const calls = fake.calls.length;
    await jest.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(fake.calls.length).toBe(calls);
    expect(fake.callsOf('setWebhook')).toHaveLength(1);
    await service.beforeApplicationShutdown();
  });

  it('the alert job id carries the boot id, so a restarted API alerts again', async () => {
    const ids: string[] = [];
    for (const bootAt of [1_000_000_000_000, 1_000_000_900_000]) {
      jest.setSystemTime(bootAt);
      const { fake, enqueue, service } = setup();
      fake.failMethod('setWebhook');
      await bootstrap(service);
      await jest.advanceTimersByTimeAsync(4 * WEBHOOK_RETRY_FIRST_DELAY_MS);
      ids.push((enqueue.mock.calls[0] as [string])[0]);
      await service.beforeApplicationShutdown();
    }
    expect(ids[0]).toMatch(/^alert-webhookFailed-[a-z0-9]+x3-555000$/);
    expect(ids[1]).toMatch(/^alert-webhookFailed-[a-z0-9]+x3-555000$/);
    expect(ids[0]).not.toBe(ids[1]);
  });

  // review nit: neither the first attempt nor a timer-driven retry may leave an unhandled
  // rejection (Node would end the process). A bug inside the failure handling is the case.
  it('a crash inside an attempt is logged, never an unhandled rejection (first attempt and retry)', async () => {
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      // first attempt: the failure handler's own log line throws
      const first = setup();
      first.fake.failMethod('setWebhook');
      logged.mockImplementationOnce(() => {
        throw new Error('logger broke');
      });
      await bootstrap(first.service);
      expect(printed(logged.mock.calls)).toContain('bot registration crashed');

      // retry: attempt 1 fails normally and schedules the retry; the retry's log line throws
      const retry = setup();
      retry.fake.failMethod('setWebhook');
      await bootstrap(retry.service);
      logged.mockClear();
      logged.mockImplementationOnce(() => {
        throw new Error('logger broke again');
      });
      await jest.advanceTimersByTimeAsync(WEBHOOK_RETRY_FIRST_DELAY_MS);
      await flush();
      expect(printed(logged.mock.calls)).toContain('bot registration crashed');
      expect(unhandled).not.toHaveBeenCalled();
      await first.service.beforeApplicationShutdown();
      await retry.service.beforeApplicationShutdown();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('the owner-alert warning names the alert that keeps repeating', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { fake, service } = setup({ ...WEBHOOK_CONFIG, OWNER_ALERT_CHAT_ID: undefined });
    fake.failMethod('setWebhook');
    await bootstrap(service);
    await jest.advanceTimersByTimeAsync(4 * WEBHOOK_RETRY_FIRST_DELAY_MS);
    expect(printed(warn.mock.calls)).toContain('webhookFailed keeps repeating');

    const setupCase = setup({ ...WEBHOOK_CONFIG, OWNER_ALERT_CHAT_ID: undefined });
    setupCase.fake.bot.api.config.use((prev, method, payload, signal) =>
      method === 'setMyCommands' ? new Promise(() => undefined) : prev(method, payload, signal),
    );
    await bootstrap(setupCase.service);
    await jest.advanceTimersByTimeAsync(10 * WEBHOOK_SETUP_TIMEOUT_MS);
    expect(printed(warn.mock.calls)).toContain('setupFailed keeps repeating');
    await service.beforeApplicationShutdown();
    await setupCase.service.beforeApplicationShutdown();
  });

  it('shutdown cancels a pending retry', async () => {
    const { fake, service } = setup();
    fake.failMethod('setWebhook');
    await bootstrap(service);
    await service.beforeApplicationShutdown();
    await jest.advanceTimersByTimeAsync(WEBHOOK_RETRY_MAX_DELAY_MS);
    expect(fake.callsOf('setWebhook')).toHaveLength(1);
  });

  it('shutdown while an attempt is in flight does not schedule another', async () => {
    const { fake, service } = setup();
    fake.failMethod('setWebhook');
    const boot = service.onApplicationBootstrap();
    await service.beforeApplicationShutdown();
    await boot;
    await flush();
    await jest.advanceTimersByTimeAsync(WEBHOOK_RETRY_MAX_DELAY_MS);
    expect(fake.callsOf('setWebhook')).toHaveLength(1);
  });
});
