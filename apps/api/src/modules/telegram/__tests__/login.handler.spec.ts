import { BotError } from 'grammy';
import { AppError } from '../../../common/exceptions/app-error';
import type { IssueCodeResult } from '../../auth/otp-login.service';
import { safeErrorText } from '../safe-error';
import { denyCallbackData } from '../login-keyboards';
import { createHarness, makeUser } from './bot-harness';
import { callbackUpdate, contactUpdate, textUpdate } from './updates';

const ID = 700_301;
const NONCE = 'n'.repeat(43);
const START = `/start login_${NONCE}`;
const withPhone = (locale: 'uz' | 'ru'): ReturnType<typeof makeUser>[] => [
  makeUser(BigInt(ID), { locale, phone: '+998901234567' }),
];
const noPhone = (locale: 'uz' | 'ru' = 'uz'): ReturnType<typeof makeUser>[] => [
  makeUser(BigInt(ID), { locale }),
];

describe.each(['uz', 'ru'] as const)('web login via the bot, user with a phone (%s)', (locale) => {
  it('sends the code in <code>, protected, with the deny button', async () => {
    const h = createHarness({ users: withPhone(locale) });
    await h.send(textUpdate({ id: ID }, START));
    expect(h.payloads()).toMatchSnapshot();
    const [call] = h.callsOf('sendMessage');
    expect(call?.payload['protect_content']).toBe(true);
    expect(String(call?.payload['text'])).toContain('<code>482913</code>');
  });

  it.each<[string, IssueCodeResult]>([
    ['expired', { ok: false, reason: 'expired' }],
    ['alreadySent', { ok: false, reason: 'alreadySent' }],
    ['usedByOther', { ok: false, reason: 'usedByOther' }],
    ['rateLimited', { ok: false, reason: 'rateLimited' }],
  ])('answers the %s outcome', async (_name, result) => {
    const h = createHarness({
      users: withPhone(locale),
      login: { issueCode: () => Promise.resolve(result) },
    });
    await h.send(textUpdate({ id: ID }, START));
    expect(h.payloads()).toMatchSnapshot();
    expect(h.callsOf('sendMessage')[0]?.payload['protect_content']).toBeUndefined();
  });
});

describe('web login via the bot, user without a phone', () => {
  it.each(['uz', 'ru'] as const)(
    'asks for the contact with a request_contact button (%s)',
    async (locale) => {
      const h = createHarness({ users: noPhone(locale) });
      await h.send(textUpdate({ id: ID }, START));
      expect(h.payloads()).toMatchSnapshot();
      expect(h.pendingContacts.get(BigInt(ID))).toBe(NONCE);
      expect(h.loginCalls.map((c) => c.method)).toEqual(['status']);
    },
  );

  it('a brand-new account is asked for the phone too', async () => {
    const h = createHarness();
    await h.send(textUpdate({ id: ID }, START));
    expect(JSON.stringify(h.callsOf('sendMessage')[0]?.payload['reply_markup'])).toContain(
      'request_contact',
    );
  });

  it.each([
    ['EXPIRED', () => Promise.resolve({ status: 'EXPIRED' as const })],
    ['DENIED', () => Promise.resolve({ status: 'DENIED' as const })],
    ['NOT_FOUND', () => Promise.reject(new AppError('NOT_FOUND'))],
  ])('a %s link is "expired" and no phone is asked for', async (_name, status) => {
    const h = createHarness({ users: noPhone(), login: { status } });
    await h.send(textUpdate({ id: ID }, START));
    expect(h.payloads()).toMatchSnapshot();
    expect(h.pendingContacts.size).toBe(0);
  });

  it('a CODE_SENT link belongs to someone else', async () => {
    const h = createHarness({
      users: noPhone(),
      login: { status: () => Promise.resolve({ status: 'CODE_SENT' }) },
    });
    await h.send(textUpdate({ id: ID }, START));
    expect(String(h.callsOf('sendMessage')[0]?.payload['text'])).toContain('boshqa hisob');
    expect(h.pendingContacts.size).toBe(0);
  });

  it('clears botBlockedAt before the login flow', async () => {
    const h = createHarness({
      users: [makeUser(BigInt(ID), { botBlockedAt: new Date(), phone: '+998901234567' })],
    });
    await h.send(textUpdate({ id: ID }, START));
    expect(h.store.get(BigInt(ID))?.botBlockedAt).toBeNull();
  });
});

describe('contact message', () => {
  const pending = async (): Promise<ReturnType<typeof createHarness>> => {
    const h = createHarness({ users: noPhone('ru') });
    await h.send(textUpdate({ id: ID }, START));
    h.calls.length = 0;
    h.loginCalls.length = 0;
    return h;
  };

  it("rejects somebody else's contact: not stored, nonce kept, keyboard stays", async () => {
    const h = await pending();
    await h.send(contactUpdate({ id: ID }, { phone_number: '998907654321', user_id: ID + 1 }));
    await h.send(contactUpdate({ id: ID }, { phone_number: '998907654321' }));
    expect(h.payloads()).toMatchSnapshot();
    expect(h.store.get(BigInt(ID))?.phone).toBeNull();
    expect(h.pendingContacts.get(BigInt(ID))).toBe(NONCE);
    expect(JSON.stringify(h.payloads())).not.toContain('remove_keyboard');
    expect(h.loginCalls).toHaveLength(0);
  });

  it('stores an own contact as +digits, drops the keyboard, then issues the code', async () => {
    const h = await pending();
    await h.send(contactUpdate({ id: ID }, { phone_number: '998901234567', user_id: ID }));
    expect(h.payloads()).toMatchSnapshot();
    expect(h.store.get(BigInt(ID))?.phone).toBe('+998901234567');
    expect(h.pendingContacts.size).toBe(0);
    const sent = h.callsOf('sendMessage');
    expect(sent[0]?.payload['reply_markup']).toEqual({ remove_keyboard: true });
    expect(sent[1]?.payload['protect_content']).toBe(true);
    expect(h.loginCalls.map((c) => c.method)).toEqual(['issueCode']);
  });

  it('rejects too short or non-phone text and keeps the nonce for another try', async () => {
    const h = await pending();
    await h.send(contactUpdate({ id: ID }, { phone_number: '12345', user_id: ID }));
    await h.send(contactUpdate({ id: ID }, { phone_number: 'abc', user_id: ID }));
    expect(h.store.get(BigInt(ID))?.phone).toBeNull();
    expect(h.pendingContacts.get(BigInt(ID))).toBe(NONCE);
    expect(h.callsOf('sendMessage')).toHaveLength(2);
  });

  it('without a pending login the phone is not stored', async () => {
    const h = createHarness({ users: noPhone() });
    await h.send(contactUpdate({ id: ID }, { phone_number: '+998901234567', user_id: ID }));
    expect(h.store.get(BigInt(ID))?.phone).toBeNull();
    expect(h.payloads()).toMatchSnapshot();
    expect(h.loginCalls).toHaveLength(0);
  });

  it('a second contact message after the first finds no pending login', async () => {
    const h = await pending();
    const own = { phone_number: '+998901234567', user_id: ID };
    await h.send(contactUpdate({ id: ID }, own));
    await h.send(contactUpdate({ id: ID }, own));
    expect(h.loginCalls.filter((c) => c.method === 'issueCode')).toHaveLength(1);
  });
});

describe('contact message when the login cannot start', () => {
  it.each<[string, IssueCodeResult]>([
    ['the link died meanwhile', { ok: false, reason: 'expired' }],
    ['another account claimed the link', { ok: false, reason: 'usedByOther' }],
  ])('%s: nothing is stored and the keyboard goes away', async (_name, result) => {
    const h = createHarness({
      users: noPhone(),
      login: { issueCode: () => Promise.resolve(result) },
    });
    await h.send(textUpdate({ id: ID }, START));
    h.calls.length = 0;
    await h.send(contactUpdate({ id: ID }, { phone_number: '998901234567', user_id: ID }));
    expect(h.store.get(BigInt(ID))?.phone).toBeNull();
    const sent = h.callsOf('sendMessage');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload['reply_markup']).toEqual({ remove_keyboard: true });
    expect(String(sent[0]?.payload['text'])).not.toContain('482913');
  });
});

describe('the code message cannot be sent', () => {
  it('releases the code, rethrows, and no log line holds the code', async () => {
    const h = createHarness({ users: withPhone('uz') });
    h.failMethod('sendMessage');
    const failure: unknown = await h.send(textUpdate({ id: ID }, START)).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(BotError);
    expect(h.releaseCalls).toEqual([{ nonce: NONCE, telegramId: BigInt(ID), code: '482913' }]);
    const cause = failure instanceof BotError ? failure.error : failure;
    expect(JSON.stringify(h.logs) + safeErrorText(cause)).not.toContain('482913');
  });

  it('a failing release does not hide the send error and is logged without details', async () => {
    const h = createHarness({
      users: withPhone('uz'),
      login: { releaseCode: () => Promise.reject(new Error('redis down 482913')) },
    });
    h.failMethod('sendMessage');
    await expect(h.send(textUpdate({ id: ID }, START))).rejects.toBeInstanceOf(BotError);
    expect(h.logs.warn).toEqual(['login code release failed: Error']);
  });
});

describe.each(['uz', 'ru'] as const)('deny button (%s)', (locale) => {
  const data = denyCallbackData(NONCE);

  it('callback_data stays within 64 bytes', () => {
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
  });

  it('deny true edits the message (code gone, keyboard gone) and answers', async () => {
    const h = createHarness({ users: withPhone(locale) });
    await h.send(callbackUpdate({ id: ID }, data));
    expect(h.payloads()).toMatchSnapshot();
    expect(h.loginCalls).toEqual([{ method: 'deny', nonce: NONCE }]);
  });

  it('deny false only answers the callback with the expired text', async () => {
    const h = createHarness({
      users: withPhone(locale),
      login: { deny: () => Promise.resolve('expired' as const) },
    });
    await h.send(callbackUpdate({ id: ID }, data));
    expect(h.payloads()).toMatchSnapshot();
    expect(h.callsOf('editMessageText')).toHaveLength(0);
  });

  it('sessionEnded edits to its own text and removes the keyboard', async () => {
    const h = createHarness({
      users: withPhone(locale),
      login: { deny: () => Promise.resolve('sessionEnded' as const) },
    });
    await h.send(callbackUpdate({ id: ID }, data));
    expect(h.payloads()).toMatchSnapshot();
    const [edit] = h.callsOf('editMessageText');
    expect(edit?.payload['reply_markup']).toEqual({ inline_keyboard: [] });
  });

  it('never throws when deny fails, and the logs hold no nonce', async () => {
    const h = createHarness({
      users: withPhone(locale),
      login: { deny: () => Promise.reject(new Error('db down')) },
    });
    await expect(h.send(callbackUpdate({ id: ID }, data))).resolves.toBeUndefined();
    expect(h.callsOf('answerCallbackQuery')).toHaveLength(1);
    expect(JSON.stringify(h.logs)).not.toContain(NONCE);
  });

  it('ignores malformed callback data', async () => {
    const h = createHarness({ users: withPhone(locale) });
    await h.send(callbackUpdate({ id: ID }, 'ld:short'));
    expect(h.loginCalls).toHaveLength(0);
  });
});

describe('secrets in logs', () => {
  it('neither the code, the nonce nor the phone reaches a log line, even on failures', async () => {
    const h = createHarness({
      users: noPhone(),
      login: { issueCode: () => Promise.reject(new Error('boom')) },
    });
    await h.send(textUpdate({ id: ID }, START));
    // handleUpdate rethrows handler errors (the webhook/poll runner is what logs them).
    await expect(
      h.send(contactUpdate({ id: ID }, { phone_number: '+998901234567', user_id: ID })),
    ).rejects.toThrow('boom');
    const logs = JSON.stringify(h.logs);
    expect(logs).not.toContain('482913');
    expect(logs).not.toContain(NONCE);
    expect(logs).not.toContain('998901234567');
  });
});
