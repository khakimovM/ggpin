import { Logger } from '@nestjs/common';
import type { TgOutboxJob } from '@repo/shared';
import { DelayedError, UnrecoverableError, type Job } from 'bullmq';
import { GrammyError, HttpError } from 'grammy';
import { TEST_BOT_TOKEN } from '../../../config/__tests__/test-env';
import type { RedisService } from '../../../infra/redis/redis.service';
import type { UsersService } from '../../users/users.service';
import { maskChatId } from '../chat-id-mask';
import { TgOutboxConsumer } from '../tg-outbox.consumer';
import type { TgOutboxSender } from '../tg-outbox.sender';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const CHAT_ID = '1234567890';
const SECRET_TEXT = 'private order details for the customer';
const payload: TgOutboxJob = { chatId: CHAT_ID, text: SECRET_TEXT };

function grammyError(code: number, description: string, retryAfter?: number): GrammyError {
  return new GrammyError(
    `Call to 'sendMessage' failed! (${code}: ${description})`,
    {
      ok: false,
      error_code: code,
      description,
      parameters: retryAfter === undefined ? {} : { retry_after: retryAfter },
    },
    'sendMessage',
    {},
  );
}

function setup(gate: 'OK' | null = 'OK') {
  const send = jest.fn<Promise<void>, [TgOutboxJob]>().mockResolvedValue(undefined);
  const sender: TgOutboxSender = { send };
  const redisSet = jest.fn().mockResolvedValue(gate);
  const redis = { client: { set: redisSet } } as unknown as RedisService;
  const markBotBlocked = jest.fn().mockResolvedValue(undefined);
  const users = { markBotBlocked } as unknown as UsersService;
  const consumer = new TgOutboxConsumer(sender, { now: () => NOW }, redis, users);
  const moveToDelayed = jest.fn().mockResolvedValue(undefined);
  const job = (data: unknown): Job =>
    ({ id: 'order-abc-delivered', data, attemptsMade: 0, moveToDelayed }) as unknown as Job;
  return { consumer, send, redisSet, markBotBlocked, moveToDelayed, job };
}

describe('TgOutboxConsumer', () => {
  let logged: string[];

  beforeEach(() => {
    logged = [];
    const capture = (message: unknown): void => {
      logged.push(String(message));
    };
    jest.spyOn(Logger.prototype, 'log').mockImplementation(capture);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(capture);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends the validated payload once and takes the per-chat slot with NX PX 1000', async () => {
    const t = setup();
    await t.consumer.handle(t.job(payload), 'tok');
    expect(t.send).toHaveBeenCalledTimes(1);
    expect(t.send).toHaveBeenCalledWith(payload);
    expect(t.redisSet).toHaveBeenCalledWith(`tg-outbox:chat:${CHAT_ID}`, '1', 'PX', 1000, 'NX');
  });

  it.each([
    ['unknown key', { ...payload, extra: 1 }],
    ['non-digit chat id', { ...payload, chatId: '@channel' }],
    ['empty text', { ...payload, text: '' }],
    ['not an object', 'hello'],
  ])('rejects an invalid payload (%s) as unrecoverable without sending', async (_name, data) => {
    const t = setup();
    await expect(t.consumer.handle(t.job(data), 'tok')).rejects.toBeInstanceOf(UnrecoverableError);
    expect(t.send).not.toHaveBeenCalled();
  });

  it('delays a second message to the same chat by about 1 s and does not send it', async () => {
    const t = setup(null);
    const before = Date.now();
    await expect(t.consumer.handle(t.job(payload), 'tok')).rejects.toBeInstanceOf(DelayedError);
    expect(t.send).not.toHaveBeenCalled();
    expect(t.moveToDelayed).toHaveBeenCalledTimes(1);
    const [until, token] = t.moveToDelayed.mock.calls[0] as [number, string];
    expect(token).toBe('tok');
    expect(until - before).toBeGreaterThanOrEqual(1000);
    expect(until - before).toBeLessThan(1500);
  });

  it('429 delays by retry_after (not an attempt) and does not mark the user', async () => {
    const t = setup();
    t.send.mockRejectedValueOnce(grammyError(429, 'Too Many Requests: retry after 7', 7));
    const before = Date.now();
    await expect(t.consumer.handle(t.job(payload), 'tok')).rejects.toBeInstanceOf(DelayedError);
    const [until] = t.moveToDelayed.mock.calls[0] as [number];
    expect(until - before).toBeGreaterThanOrEqual(7000);
    expect(until - before).toBeLessThan(7500);
    expect(t.markBotBlocked).not.toHaveBeenCalled();
  });

  it.each(['Forbidden: bot was blocked by the user', 'Forbidden: user is deactivated'])(
    '403 "%s" marks the user and fails without retries',
    async (description) => {
      const t = setup();
      t.send.mockRejectedValueOnce(grammyError(403, description));
      await expect(t.consumer.handle(t.job(payload), 'tok')).rejects.toBeInstanceOf(
        UnrecoverableError,
      );
      expect(t.markBotBlocked).toHaveBeenCalledWith(BigInt(CHAT_ID), NOW);
    },
  );

  it('403 for another reason is unrecoverable but does not mark the user', async () => {
    const t = setup();
    t.send.mockRejectedValueOnce(grammyError(403, "Forbidden: bot can't initiate conversation"));
    await expect(t.consumer.handle(t.job(payload), 'tok')).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(t.markBotBlocked).not.toHaveBeenCalled();
  });

  it('400 chat not found is unrecoverable', async () => {
    const t = setup();
    t.send.mockRejectedValueOnce(grammyError(400, 'Bad Request: chat not found'));
    await expect(t.consumer.handle(t.job(payload), 'tok')).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(t.markBotBlocked).not.toHaveBeenCalled();
  });

  it("400 can't parse entities is unrecoverable, logs Telegram's description, no retry", async () => {
    const t = setup();
    t.send.mockRejectedValueOnce(grammyError(400, "Bad Request: can't parse entities"));
    await expect(t.consumer.handle(t.job(payload), 'tok')).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(t.moveToDelayed).not.toHaveBeenCalled();
    const output = logged.join('\n');
    expect(output).toContain('outcome=bad-request');
    expect(output).toContain("can't parse entities");
    expect(output).not.toContain(SECRET_TEXT);
    expect(output).not.toContain(CHAT_ID);
  });

  it.each([
    ['500 from Telegram', grammyError(500, 'Internal Server Error')],
    ['network failure', new HttpError('Network request failed', new Error('ECONNRESET'))],
  ])('rethrows %s unchanged so the queue backoff retries it', async (_name, error) => {
    const t = setup();
    t.send.mockRejectedValueOnce(error);
    await expect(t.consumer.handle(t.job(payload), 'tok')).rejects.toBe(error);
    expect(t.moveToDelayed).not.toHaveBeenCalled();
  });

  describe('logging', () => {
    it('masks the chat id and never logs the text', async () => {
      const t = setup();
      await t.consumer.handle(t.job({ ...payload, replyMarkup: { inline_keyboard: [] } }), 'tok');
      const output = logged.join('\n');
      expect(output).toContain('job=order-abc-delivered');
      expect(output).toContain('outcome=sent');
      expect(output).toContain(`chat=${maskChatId(CHAT_ID)}`);
      expect(output).not.toContain(CHAT_ID);
      expect(output).not.toContain(SECRET_TEXT);
      expect(output).not.toContain('inline_keyboard');
    });

    it('scrubs a bot token quoted inside a network error message', async () => {
      const t = setup();
      const url = `https://api.telegram.org/bot${TEST_BOT_TOKEN}/sendMessage`;
      t.send.mockRejectedValueOnce(new HttpError(`request to ${url} failed`, new Error('x')));
      await expect(t.consumer.handle(t.job(payload), 'tok')).rejects.toBeInstanceOf(HttpError);
      const output = logged.join('\n');
      expect(output).toContain('outcome=retry');
      expect(output).not.toContain(TEST_BOT_TOKEN);
      expect(output).not.toContain(CHAT_ID);
    });
  });
});

describe('maskChatId', () => {
  it('keeps only the last 4 digits', () => {
    expect(maskChatId('1234567890')).toBe('***7890');
    expect(maskChatId('42')).toBe('***42');
  });
});
