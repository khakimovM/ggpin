import { describe, expect, it } from 'vitest';
import {
  OWNER_ALERT_CHAT_IDS_MAX,
  TG_TEXT_MAX_LENGTH,
  ownerAlertChatIds,
  parseOwnerAlertChatIds,
  tgOutboxJobId,
  tgOutboxJobSchema,
} from './tg-outbox';

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
    ['group chat id', { chatId: '-100123', text: 'x' }],
    ['zero chat id', { chatId: '0', text: 'x' }],
    ['leading zero', { chatId: '012', text: 'x' }],
    ['21 digits', { chatId: '1'.repeat(21), text: 'x' }],
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
    ['a plain http url', job({ inline_keyboard: [[{ text: 'a', url: 'http://a.test' }]] })],
    [
      'a web_app button with an http url',
      job({ inline_keyboard: [[{ text: 'a', web_app: { url: 'http://a.test/tg' } }]] }),
    ],
    [
      'a web_app button with an extra key',
      job({ inline_keyboard: [[{ text: 'a', web_app: { url: 'https://a.test', x: 1 } }]] }),
    ],
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
        [{ text: 'App', web_app: { url: 'https://example.test/tg/topup' } }],
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

describe('parseOwnerAlertChatIds (D-53)', () => {
  const idsOf = (raw: string) => {
    const parsed = parseOwnerAlertChatIds(raw);
    if (!parsed.ok) throw new Error(parsed.problem);
    return parsed.ids;
  };

  it('one id is the primary of a list of one', () => {
    expect(idsOf('111111111')).toEqual(['111111111']);
  });

  it('keeps the order (the first id is the primary), trims spaces, drops blanks', () => {
    expect(idsOf(' 222222222 , 111111111,, ')).toEqual(['222222222', '111111111']);
  });

  it('drops repeats and keeps the first place of each id', () => {
    expect(idsOf('111111111,222222222,111111111')).toEqual(['111111111', '222222222']);
  });

  it('accepts exactly the maximum and refuses one more distinct id', () => {
    const five = ['1', '2', '3', '4', '5'];
    expect(idsOf(five.join(','))).toHaveLength(OWNER_ALERT_CHAT_IDS_MAX);
    expect(parseOwnerAlertChatIds([...five, '6'].join(',')).ok).toBe(false);
    // Repeats do not count towards the cap.
    expect(idsOf([...five, ...five].join(','))).toHaveLength(5);
  });

  it.each(['', ',', ' , ', '-100123', 'abc', '12 3', '+5', '1.5', '0', '012', '1'.repeat(21)])(
    'refuses %j',
    (raw) => {
      expect(parseOwnerAlertChatIds(raw).ok).toBe(false);
    },
  );

  it('one bad id spoils the list, and the problem never echoes the value', () => {
    const parsed = parseOwnerAlertChatIds('111111111,-100987654321');
    expect(parsed.ok).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain('100987654321');
  });

  it('ownerAlertChatIds is empty when unset or unusable', () => {
    expect(ownerAlertChatIds(undefined)).toEqual([]);
    expect(ownerAlertChatIds('-1')).toEqual([]);
    expect(ownerAlertChatIds('111111111,222222222')).toEqual(['111111111', '222222222']);
  });
});
