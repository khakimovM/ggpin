import { Logger } from '@nestjs/common';
import { BRAND, tgOutboxJobSchema, type TgOutboxJob } from '@repo/shared';
import type { TgOutboxEnqueuer } from '../../notifications/tg-outbox.enqueuer';
import { newLoginJobId, NewLoginNoticeService } from '../new-login-notice.service';

const FAMILY = '123e4567-e89b-42d3-a456-426614174000';
const NOW = new Date('2026-11-02T17:30:00.000Z'); // 22:30 in Tashkent (UTC+5)
const USER = { telegramId: 777000111n, locale: 'ru', botBlockedAt: null } as const;

function setup(enqueue: jest.Mock = jest.fn().mockResolvedValue(undefined)) {
  const service = new NewLoginNoticeService({ enqueue } as unknown as TgOutboxEnqueuer);
  return { service, enqueue };
}

function sentJob(enqueue: jest.Mock): TgOutboxJob {
  const [, job] = enqueue.mock.calls[0] as [string, TgOutboxJob];
  return job;
}

describe('NewLoginNoticeService', () => {
  it('queues one message to the user chat, with a job id per session family', async () => {
    const { service, enqueue } = setup();
    await service.send({
      user: USER,
      familyId: FAMILY,
      meta: { userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130', ip: '203.0.113.45' },
      now: NOW,
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [jobId, job] = enqueue.mock.calls[0] as [string, TgOutboxJob];
    expect(jobId).toBe('newlogin-123e4567e89b42d3a456426614174000');
    expect(jobId).toBe(newLoginJobId(FAMILY));
    expect(job.chatId).toBe('777000111');
    expect(() => tgOutboxJobSchema.parse(job)).not.toThrow();
  });

  it('renders the Russian text with brand, device, masked IP and Tashkent time', async () => {
    const { service, enqueue } = setup();
    await service.send({
      user: USER,
      familyId: FAMILY,
      meta: { userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130', ip: '203.0.113.45' },
      now: NOW,
    });
    const { text } = sentJob(enqueue);
    expect(text).toContain(BRAND.name);
    expect(text).toContain('Chrome, Windows');
    expect(text).toContain('203.0.113.x');
    expect(text).not.toContain('203.0.113.45');
    expect(text).toContain('22:30');
    expect(text).toContain('Новый вход');
  });

  it('renders Uzbek for an Uzbek user', async () => {
    const { service, enqueue } = setup();
    await service.send({
      user: { ...USER, locale: 'uz' },
      familyId: FAMILY,
      meta: { userAgent: 'Chrome/130', ip: '2001:db8:85a3:1::7' },
      now: NOW,
    });
    const { text } = sentJob(enqueue);
    expect(text).toContain('saytiga yangi kirish');
    expect(text).toContain('2001:db8:85a3::x');
  });

  it('has one inline button whose callback_data is se:<familyId> within 64 bytes', async () => {
    const { service, enqueue } = setup();
    await service.send({ user: USER, familyId: FAMILY, meta: {}, now: NOW });
    const { replyMarkup } = sentJob(enqueue);
    expect(replyMarkup?.inline_keyboard).toHaveLength(1);
    expect(replyMarkup?.inline_keyboard[0]).toHaveLength(1);
    const button = replyMarkup?.inline_keyboard[0]?.[0];
    expect(button).toMatchObject({ callback_data: `se:${FAMILY}` });
    expect(new TextEncoder().encode(`se:${FAMILY}`).length).toBeLessThanOrEqual(64);
  });

  it('never echoes the raw user agent: URLs, mentions and markup in it do not reach the message', async () => {
    const { service, enqueue } = setup();
    await service.send({
      user: USER,
      familyId: FAMILY,
      meta: {
        userAgent: `<b>Chrome/130 (Linux) https://evil.example @fake_support ${'x'.repeat(200)}`,
      },
      now: NOW,
    });
    const { text } = sentJob(enqueue);
    expect(text).toContain('Chrome, Linux');
    for (const leaked of ['evil.example', 'fake_support', '<b>', '&lt;b&gt;', 'xxx']) {
      expect(text).not.toContain(leaked);
    }
  });

  it('an unrecognised user agent is shown as the localized "unknown device", not as text', async () => {
    const { service, enqueue } = setup();
    await service.send({
      user: USER,
      familyId: FAMILY,
      meta: { userAgent: 'https://evil.example @fake_support' },
      now: NOW,
    });
    const { text } = sentJob(enqueue);
    expect(text).toContain('неизвестное устройство');
    expect(text).not.toContain('evil.example');
    expect(text).not.toContain('fake_support');
  });

  it('says "unknown device" (localized) and a dash when the request carried nothing', async () => {
    const { service, enqueue } = setup();
    await service.send({ user: USER, familyId: FAMILY, meta: {}, now: NOW });
    const { text } = sentJob(enqueue);
    expect(text).toContain('неизвестное устройство');
    expect(text).toContain('IP: –');
  });

  it('never queues anything for a user who blocked the bot', async () => {
    const { service, enqueue } = setup();
    await service.send({
      user: { ...USER, botBlockedAt: new Date('2026-11-01T00:00:00Z') },
      familyId: FAMILY,
      meta: {},
      now: NOW,
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('swallows an enqueue failure and logs a warning without PII or the error text', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const failure = new Error('connect ECONNREFUSED redis://:secret@host chat 777000111');
      const { service } = setup(jest.fn().mockRejectedValue(failure));
      await expect(
        service.send({
          user: USER,
          familyId: FAMILY,
          meta: { ip: '203.0.113.45', userAgent: 'UA' },
          now: NOW,
        }),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0]?.[0]);
      expect(line).toBe('new-login notice not queued: Error');
      for (const pii of ['777000111', '203.0.113', 'secret', FAMILY]) {
        expect(line).not.toContain(pii);
      }
    } finally {
      warn.mockRestore();
    }
  });
});
