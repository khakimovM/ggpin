import { describe, expect, it } from 'vitest';
import { TG_TEXT_MAX_LENGTH, tgOutboxJobId, tgOutboxJobSchema } from './tg-outbox';

const job = (replyMarkup: unknown) => ({ chatId: '1', text: 'x', replyMarkup });

describe('tgOutboxJobSchema', () => {
  it('accepts a minimal and a full job', () => {
    expect(tgOutboxJobSchema.safeParse({ chatId: '123456789', text: '<b>Hi</b>' }).success).toBe(
      true,
    );
    expect(
      tgOutboxJobSchema.safeParse({
        chatId: '123456789',
        text: 'x',
        replyMarkup: { inline_keyboard: [] },
        disableNotification: true,
      }).success,
    ).toBe(true);
  });

  it.each([
    ['empty text', { chatId: '1', text: '' }],
    ['text over the limit', { chatId: '1', text: 'x'.repeat(TG_TEXT_MAX_LENGTH + 1) }],
    ['non-digit chat id', { chatId: '-100123', text: 'x' }],
    ['numeric chat id', { chatId: 123, text: 'x' }],
    ['empty chat id', { chatId: '', text: 'x' }],
    ['replyMarkup is not an object', { chatId: '1', text: 'x', replyMarkup: 'kb' }],
    ['keyboard without inline_keyboard', job({})],
    ['keyboard with an unknown key', job({ inline_keyboard: [], remove_keyboard: true })],
    ['an empty row', job({ inline_keyboard: [[]] })],
    ['a button with neither callback_data nor url', job({ inline_keyboard: [[{ text: 'a' }]] })],
    [
      'a button with both callback_data and url',
      job({ inline_keyboard: [[{ text: 'a', callback_data: 'x', url: 'https://a.test' }]] }),
    ],
    [
      'callback_data over 64 bytes',
      job({ inline_keyboard: [[{ text: 'a', callback_data: 'x'.repeat(65) }]] }),
    ],
    ['non-ASCII callback_data', job({ inline_keyboard: [[{ text: 'a', callback_data: 'ё' }]] })],
    ['a javascript: url', job({ inline_keyboard: [[{ text: 'a', url: 'javascript:alert(1)' }]] })],
    [
      'an unknown button key',
      job({ inline_keyboard: [[{ text: 'a', callback_data: 'x', pay: true }]] }),
    ],
    ['unknown key', { chatId: '1', text: 'x', parseMode: 'HTML' }],
  ])('rejects %s', (_name, job) => {
    expect(tgOutboxJobSchema.safeParse(job).success).toBe(false);
  });

  it('accepts callback and url buttons, callback_data of exactly 64 bytes', () => {
    const markup = {
      inline_keyboard: [
        [{ text: 'End', callback_data: 'x'.repeat(64) }],
        [{ text: 'Open', url: 'https://example.test/a' }],
      ],
    };
    expect(tgOutboxJobSchema.safeParse(job(markup)).success).toBe(true);
  });

  it('accepts text of exactly the limit', () => {
    const text = 'x'.repeat(TG_TEXT_MAX_LENGTH);
    expect(tgOutboxJobSchema.safeParse({ chatId: '1', text }).success).toBe(true);
  });
});

describe('tgOutboxJobId', () => {
  it('joins segments with a dash and never contains a colon', () => {
    const id = tgOutboxJobId('order', 'cm0abc123', 'delivered');
    expect(id).toBe('order-cm0abc123-delivered');
    expect(id).not.toContain(':');
  });

  it('is never purely numeric (BullMQ rejects integer ids)', () => {
    expect(tgOutboxJobId('1', '2')).toBe('1-2');
  });

  it('needs two segments', () => {
    expect(() => tgOutboxJobId('order')).toThrow(/two segments/);
    expect(() => tgOutboxJobId()).toThrow(/two segments/);
  });

  it.each(['a:b', 'a-b', 'a b', '', 'ä', 'a'.repeat(65)])('rejects segment %j', (segment) => {
    expect(() => tgOutboxJobId('order', segment)).toThrow(/invalid characters/);
  });

  it('rejects an id over 200 characters', () => {
    const long = 'a'.repeat(64);
    expect(() => tgOutboxJobId(long, long, long, long)).toThrow(/too long/);
  });
});
