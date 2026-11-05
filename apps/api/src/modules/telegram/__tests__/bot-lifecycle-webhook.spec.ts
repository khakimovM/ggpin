import { Logger } from '@nestjs/common';
import { HttpError } from 'grammy';
import { TEST_BOT_TOKEN, TEST_WEBHOOK_SECRET } from '../../../config/__tests__/test-env';
import { WEBHOOK_RETRY_FIRST_DELAY_MS, webhookRetryDelayMs } from '../bot-lifecycle.service';
import {
  TOKEN_SECRET_PART,
  WEBHOOK_CONFIG,
  bootstrap,
  printed,
  setup,
} from './bot-lifecycle-webhook-helpers';

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

describe('BotLifecycleService webhook mode', () => {
  it('sets the webhook with the secret and the allowed updates, then sets the bot up', async () => {
    const { fake, enqueue, service } = setup();
    await bootstrap(service);
    expect(fake.callsOf('setWebhook')[0]?.payload).toMatchObject({
      url: 'https://api.example.test/api/v1/telegram/webhook',
      secret_token: TEST_WEBHOOK_SECRET,
      allowed_updates: ['message', 'callback_query', 'my_chat_member'],
    });
    expect(fake.callsOf('setMyCommands').length).toBeGreaterThan(0);
    expect(enqueue).not.toHaveBeenCalled();
    await service.beforeApplicationShutdown();
  });

  it('still refuses to boot without the webhook URL or secret (a config error, not an outage)', async () => {
    const { service } = setup({ ...WEBHOOK_CONFIG, TELEGRAM_WEBHOOK_URL: undefined });
    await expect(service.onApplicationBootstrap()).rejects.toThrow(/WEBHOOK_URL/);
  });

  // D-29.5
  it('a Bot API error from setWebhook does not stop boot; it is logged without the secret', async () => {
    const { fake, service } = setup();
    fake.failMethod('setWebhook');
    await expect(bootstrap(service)).resolves.toBeUndefined();
    expect(printed(logged.mock.calls)).toContain('webhook setup failed');
    expect(printed(logged.mock.calls)).not.toContain(TEST_WEBHOOK_SECRET);
    expect(fake.callsOf('setMyCommands')).toHaveLength(0);
    await service.beforeApplicationShutdown();
  });

  it('a network error from setWebhook does not stop boot, and the log does not carry the bot token', async () => {
    const { fake, service } = setup();
    // grammY's own shape: a safe message, the underlying error (with the token URL) as .error.
    const network = new HttpError(
      "Network request for 'setWebhook' failed!",
      new Error(`request to http://telegram.invalid/bot${TEST_BOT_TOKEN}/setWebhook failed`),
    );
    expect(printed(network)).toContain(TOKEN_SECRET_PART); // control: the raw error leaks it
    fake.bot.api.config.use((prev, method, payload, signal) =>
      method === 'setWebhook' ? Promise.reject(network) : prev(method, payload, signal),
    );
    await expect(bootstrap(service)).resolves.toBeUndefined();
    expect(printed(logged.mock.calls)).toContain('webhook setup failed');
    expect(printed(logged.mock.calls)).not.toContain(TOKEN_SECRET_PART);
    await service.beforeApplicationShutdown();
  });

  it('retries with exponential backoff, alerts the owner on the third failure, then recovers', async () => {
    const { fake, enqueue, service } = setup();
    fake.failMethod('setWebhook');
    await bootstrap(service); // failure 1
    expect(fake.callsOf('setWebhook')).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(WEBHOOK_RETRY_FIRST_DELAY_MS - 1);
    expect(fake.callsOf('setWebhook')).toHaveLength(1); // not yet
    await jest.advanceTimersByTimeAsync(1); // failure 2 at 30 s
    expect(fake.callsOf('setWebhook')).toHaveLength(2);
    expect(enqueue).not.toHaveBeenCalled(); // a short blip stays quiet

    await jest.advanceTimersByTimeAsync(2 * WEBHOOK_RETRY_FIRST_DELAY_MS); // failure 3 after 60 s more
    expect(fake.callsOf('setWebhook')).toHaveLength(3);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [jobId, job] = enqueue.mock.calls[0] as [string, { chatId: string; text: string }];
    expect(jobId).toMatch(/^alert-webhookFailed-[a-z0-9]+x3$/);
    expect(job.chatId).toBe('555000');
    expect(job.text).toContain('3'); // the attempt number
    expect(job.text).toContain('webhook');
    expect(job.text).not.toContain(TEST_WEBHOOK_SECRET);

    fake.restoreMethod('setWebhook');
    expect(fake.callsOf('setMyCommands')).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(4 * WEBHOOK_RETRY_FIRST_DELAY_MS); // success after 120 s more
    expect(fake.callsOf('setWebhook')).toHaveLength(4);
    expect(fake.callsOf('setMyCommands').length).toBeGreaterThan(0);

    await jest.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(fake.callsOf('setWebhook')).toHaveLength(4); // no more retries once registered
    await service.beforeApplicationShutdown();
  });

  it('keeps alerting about once an hour while the webhook keeps failing', async () => {
    const { fake, enqueue, service } = setup();
    fake.failMethod('setWebhook');
    await bootstrap(service);
    // Delays: 30 s, 60 s, 120 s, 240 s, 480 s, then 10 minutes: failure 9 is at about 45 minutes.
    await jest.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
    const ids = enqueue.mock.calls.map((call: [string]) => call[0]);
    expect(ids.slice(0, 3).map((id) => /x(\d+)$/.exec(id)?.[1])).toEqual(['3', '9', '15']);
    await service.beforeApplicationShutdown();
  });

  it('does not alert when there is no usable owner chat, and survives a queue failure', async () => {
    for (const OWNER_ALERT_CHAT_ID of [undefined, '-100123']) {
      const { fake, enqueue, service } = setup({
        ...WEBHOOK_CONFIG,
        OWNER_ALERT_CHAT_ID,
      });
      fake.failMethod('setWebhook');
      await bootstrap(service);
      await jest.advanceTimersByTimeAsync(4 * WEBHOOK_RETRY_FIRST_DELAY_MS);
      expect(enqueue).not.toHaveBeenCalled();
      await service.beforeApplicationShutdown();
    }

    const { fake, enqueue, service } = setup();
    enqueue.mockRejectedValue(new Error('redis down'));
    fake.failMethod('setWebhook');
    await bootstrap(service);
    await jest.advanceTimersByTimeAsync(4 * WEBHOOK_RETRY_FIRST_DELAY_MS);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(printed(logged.mock.calls)).toContain('could not queue the webhook alert');
    await service.beforeApplicationShutdown();
  });
});

describe('webhookRetryDelayMs', () => {
  it('doubles from 30 s and is capped at 10 minutes', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 50].map(webhookRetryDelayMs)).toEqual([
      30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000, 600_000,
    ]);
  });
});
