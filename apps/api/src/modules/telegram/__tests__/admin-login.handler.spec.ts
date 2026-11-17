import { BotError } from 'grammy';
import type { AdminIssueCodeResult } from '../../admin/auth/admin-login.service';
import { safeErrorText } from '../safe-error';
import {
  adminDenyCallbackData,
  adminSessionEndCallbackData,
} from '../../admin/auth/admin-callbacks';
import { createHarness, makeUser } from './bot-harness';
import { callbackUpdate, textUpdate } from './updates';

const ID = 700_901;
const NONCE = 'a'.repeat(43);
const START = `/start admin_${NONCE}`;
const SESSION_ID = 'cmadminsession0000000001';
const CODE = '615243';
const issued: AdminIssueCodeResult = {
  ok: true,
  code: CODE,
  origin: { ip: '203.0.113.x', device: 'Chrome, Windows' },
};
const user = (locale: 'uz' | 'ru' = 'uz') => [makeUser(BigInt(ID), { locale })];

describe.each(['uz', 'ru'] as const)('admin login code in the bot (%s)', (locale) => {
  it('sends the code in <code>, protected, with where it was asked from and the deny button', async () => {
    const h = createHarness({
      users: user(locale),
      adminLogin: { issueCode: () => Promise.resolve(issued) },
    });
    await h.send(textUpdate({ id: ID }, START));
    expect(h.payloads()).toMatchSnapshot();
    const [call] = h.callsOf('sendMessage');
    expect(call?.payload['protect_content']).toBe(true);
    const text = String(call?.payload['text']);
    expect(text).toContain(`<code>${CODE}</code>`);
    // SA-L4: the admin host from ADMIN_URL, the masked address and the device of the start call.
    expect(text).toContain('admin.example.test');
    expect(text).toContain('203.0.113.x');
    expect(text).toContain('Chrome, Windows');
    expect(JSON.stringify(call?.payload['reply_markup'])).toContain(adminDenyCallbackData(NONCE));
  });

  it.each<[string, AdminIssueCodeResult]>([
    ['expired', { ok: false, reason: 'expired' }],
    ['usedByOther', { ok: false, reason: 'usedByOther' }],
    ['alreadySent', { ok: false, reason: 'alreadySent' }],
    ['rateLimited', { ok: false, reason: 'rateLimited' }],
  ])('answers the %s outcome without any code', async (_name, result) => {
    const h = createHarness({
      users: user(locale),
      adminLogin: { issueCode: () => Promise.resolve(result) },
    });
    await h.send(textUpdate({ id: ID }, START));
    expect(h.payloads()).toMatchSnapshot();
    const [call] = h.callsOf('sendMessage');
    expect(call?.payload['protect_content']).toBeUndefined();
    expect(String(call?.payload['text'])).not.toMatch(/<code>/);
  });
});

describe('admin login code: edge cases', () => {
  it('someone who may not use the panel gets the same text as a dead link (no oracle)', async () => {
    const h = createHarness({ users: user('uz') });
    await h.send(textUpdate({ id: ID }, START));
    const other = createHarness({
      users: user('uz'),
      adminLogin: { issueCode: () => Promise.resolve({ ok: false, reason: 'usedByOther' }) },
    });
    await other.send(textUpdate({ id: ID }, START));
    expect(h.payloads()).toEqual(other.payloads());
    const [sent] = h.payloads() as [{ sendMessage: { text: string } }];
    expect(h.payloads()).toHaveLength(1);
    expect(sent.sendMessage.text).toBe('⌛ Havola eskirgan. Qaytadan urinib ko‘ring.');
  });

  it('escapes the start-call facts and falls back to dashes when they are unknown', async () => {
    const h = createHarness({
      users: user('uz'),
      adminLogin: {
        issueCode: () =>
          Promise.resolve({ ok: true, code: CODE, origin: { ip: null, device: '<b>x</b>' } }),
      },
    });
    await h.send(textUpdate({ id: ID }, START));
    const text = String(h.callsOf('sendMessage')[0]?.payload['text']);
    expect(text).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(text).toContain('IP: –');
    const none = createHarness({
      users: user('ru'),
      adminLogin: { issueCode: () => Promise.resolve({ ok: true, code: CODE, origin: null }) },
    });
    await none.send(textUpdate({ id: ID }, START));
    expect(String(none.callsOf('sendMessage')[0]?.payload['text'])).toContain(
      'неизвестное устройство',
    );
  });

  it('a code message that cannot be sent releases the code and logs no code', async () => {
    const h = createHarness({
      users: user('uz'),
      adminLogin: { issueCode: () => Promise.resolve(issued) },
    });
    h.failMethod('sendMessage');
    const failure: unknown = await h.send(textUpdate({ id: ID }, START)).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(BotError);
    expect(h.adminCalls.map((c) => c.method)).toEqual(['issueCode', 'releaseCode']);
    const cause = failure instanceof BotError ? failure.error : failure;
    const logged = JSON.stringify(h.logs) + safeErrorText(cause);
    expect(logged).not.toContain(CODE);
    expect(logged).not.toContain(NONCE);
  });

  it('callback data stays within 64 bytes', () => {
    expect(Buffer.byteLength(adminDenyCallbackData(NONCE))).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(adminSessionEndCallbackData('c'.repeat(60)))).toBeLessThanOrEqual(64);
  });
});

describe('admin "this was not me" buttons', () => {
  it.each([
    ['denied', 'bot.admin.denied', '🚫 Admin paneliga kirish bekor qilindi. Kod endi ishlamaydi.'],
    [
      'sessionEnded',
      'bot.admin.sessionEnded',
      '🚫 Admin sessiyasi yopildi. Bu qurilma paneldan chiqarildi.',
    ],
  ] as const)('ad:<nonce> %s edits the code away', async (result, _key, text) => {
    const h = createHarness({
      users: user('uz'),
      adminLogin: { deny: () => Promise.resolve(result) },
    });
    await h.send(callbackUpdate({ id: ID }, adminDenyCallbackData(NONCE)));
    expect(h.adminCalls).toEqual([{ method: 'deny', ref: NONCE }]);
    const [edit] = h.callsOf('editMessageText');
    expect(edit?.payload['text']).toBe(text);
    expect(edit?.payload['reply_markup']).toEqual({ inline_keyboard: [] });
  });

  it('ad:<nonce> on a dead link only answers the button', async () => {
    const h = createHarness({ users: user('ru') });
    await h.send(callbackUpdate({ id: ID }, adminDenyCallbackData(NONCE)));
    expect(h.callsOf('editMessageText')).toHaveLength(0);
    expect(h.callsOf('answerCallbackQuery')[0]?.payload['text']).toBe(
      '⌛ Ссылка устарела. Попробуйте ещё раз.',
    );
  });

  it('ae:<sessionId> ends the admin session and says so', async () => {
    const h = createHarness({
      users: user('ru'),
      adminSessions: { endFromBot: () => Promise.resolve('ended') },
    });
    await h.send(callbackUpdate({ id: ID }, adminSessionEndCallbackData(SESSION_ID)));
    expect(h.adminCalls).toEqual([{ method: 'endFromBot', ref: SESSION_ID }]);
    expect(h.payloads()).toMatchSnapshot();
  });

  it('ae:<sessionId> of an ended or foreign session removes the button', async () => {
    const h = createHarness({ users: user('uz') });
    await h.send(callbackUpdate({ id: ID }, adminSessionEndCallbackData(SESSION_ID)));
    expect(h.callsOf('editMessageText')).toHaveLength(0);
    expect(h.callsOf('editMessageReplyMarkup')[0]?.payload['reply_markup']).toEqual({
      inline_keyboard: [],
    });
    expect(h.callsOf('answerCallbackQuery')[0]?.payload['text']).toBe(
      'ℹ️ Bu sessiya allaqachon tugatilgan.',
    );
  });

  it('malformed button data never reaches the services', async () => {
    const h = createHarness({ users: user('uz') });
    await h.send(callbackUpdate({ id: ID }, `ad:${'a'.repeat(42)}`));
    await h.send(callbackUpdate({ id: ID }, 'ae:bad-id!'));
    expect(h.adminCalls).toEqual([]);
  });
});
