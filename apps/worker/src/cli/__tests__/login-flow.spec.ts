import { randomBytes } from 'node:crypto';
import { FakeRpcError } from '../../bank-feed/client/__tests__/fake-mtcute';
import type { MtLoginTelegram } from '../../bank-feed/client/mtcute-types';
import { decryptSession } from '../../bank-feed/client/session-crypto';
import {
  LoginError,
  MAX_CODE_TRIES,
  MAX_PASSWORD_TRIES,
  runLogin,
  type LoginIo,
} from '../login-flow';

// Synthetic values only: a made-up number, code, password and session.
const PHONE = '+998000000001';
const CODE = '54321';
const PASSWORD = 'test-2fa-password';
const SESSION = 'TESTSESSION_plain';
const KEY = randomBytes(32);

class MtcuteUnsupported extends Error {}
Object.defineProperty(MtcuteUnsupported, 'name', { value: 'MtUnsupportedError' });

function io(answers: string[], hidden: string[] = []) {
  const said: string[] = [];
  const prompts: string[] = [];
  const terminal: LoginIo = {
    ask: (prompt) => {
      prompts.push(prompt);
      return Promise.resolve(answers.shift() ?? '');
    },
    askHidden: (prompt) => {
      prompts.push(prompt);
      return Promise.resolve(hidden.shift() ?? '');
    },
    say: (line) => {
      said.push(line);
    },
  };
  return { terminal, said, prompts };
}

function telegram(overrides: Partial<MtLoginTelegram> = {}) {
  const calls = { signIn: 0, checkPassword: 0, exportSession: 0 };
  const tg: MtLoginTelegram = {
    sendCode: () => Promise.resolve({ phoneCodeHash: 'hash' }),
    signIn: (_p, _h, code) => {
      calls.signIn += 1;
      return code === CODE
        ? Promise.resolve()
        : Promise.reject(new FakeRpcError('PHONE_CODE_INVALID', 400));
    },
    checkPassword: (password) => {
      calls.checkPassword += 1;
      return password === PASSWORD
        ? Promise.resolve()
        : Promise.reject(new FakeRpcError('PASSWORD_HASH_INVALID', 400));
    },
    exportSession: () => {
      calls.exportSession += 1;
      return Promise.resolve(SESSION);
    },
    destroy: () => Promise.resolve(),
    ...overrides,
  };
  return { tg, calls };
}

describe('runLogin (bank-feed login CLI)', () => {
  it('phone -> code: returns ONLY the encrypted blob of the session', async () => {
    const { tg } = telegram();
    const t = io([PHONE], [CODE]);
    const blob = await runLogin(tg, t.terminal, KEY);
    expect(blob).not.toContain(SESSION);
    expect(decryptSession(blob, KEY)).toBe(SESSION);
  });

  it('2FA: SESSION_PASSWORD_NEEDED asks the password through the hidden prompt', async () => {
    const { tg, calls } = telegram({
      signIn: () => Promise.reject(new FakeRpcError('SESSION_PASSWORD_NEEDED')),
    });
    const t = io([PHONE], [CODE, 'wrong', PASSWORD]);
    const blob = await runLogin(tg, t.terminal, KEY);
    expect(decryptSession(blob, KEY)).toBe(SESSION);
    expect(calls.checkPassword).toBe(2);
  });

  it('a wrong code is asked again at most MAX_CODE_TRIES times (never forever), nothing exported', async () => {
    const { tg, calls } = telegram();
    const t = io([PHONE], ['11111', '22222', 'abc', CODE]);
    await expect(runLogin(tg, t.terminal, KEY)).rejects.toEqual(new LoginError('CODE_TRIES'));
    expect(MAX_CODE_TRIES).toBe(3);
    expect(calls.signIn).toBe(2); // 'abc' is not a code and still uses up a try
    expect(calls.exportSession).toBe(0);
  });

  it('a wrong 2FA password at most MAX_PASSWORD_TRIES times', async () => {
    const { tg, calls } = telegram({
      signIn: () => Promise.reject(new FakeRpcError('SESSION_PASSWORD_NEEDED')),
    });
    const t = io([PHONE], [CODE, 'a', 'b', 'c', PASSWORD]);
    await expect(runLogin(tg, t.terminal, KEY)).rejects.toEqual(new LoginError('PASSWORD_TRIES'));
    expect(calls.checkPassword).toBe(MAX_PASSWORD_TRIES);
    expect(calls.exportSession).toBe(0);
  });

  it('sign-up is not supported: a clear error (create the account in the official app)', async () => {
    const { tg } = telegram({ signIn: () => Promise.reject(new MtcuteUnsupported('signup')) });
    const error = await runLogin(tg, io([PHONE], [CODE]).terminal, KEY).catch((e: unknown) => e);
    expect(error).toEqual(new LoginError('SIGN_UP_REQUIRED'));
    expect(error instanceof Error ? error.message : '').toContain('official app');
  });

  it('expired code, flood wait, bad phone and an already authorized client end with a code', async () => {
    const expired = telegram({
      signIn: () => Promise.reject(new FakeRpcError('PHONE_CODE_EXPIRED', 400)),
    });
    await expect(runLogin(expired.tg, io([PHONE], [CODE]).terminal, KEY)).rejects.toEqual(
      new LoginError('CODE_EXPIRED'),
    );
    const flood = telegram({
      sendCode: () => Promise.reject(new FakeRpcError('FLOOD_WAIT_300', 420)),
    });
    await expect(runLogin(flood.tg, io([PHONE]).terminal, KEY)).rejects.toEqual(
      new LoginError('FLOOD_WAIT'),
    );
    await expect(runLogin(telegram().tg, io(['12ab']).terminal, KEY)).rejects.toEqual(
      new LoginError('BAD_PHONE'),
    );
    const authorized = telegram({ sendCode: () => Promise.resolve(null) });
    await expect(runLogin(authorized.tg, io([PHONE]).terminal, KEY)).rejects.toEqual(
      new LoginError('ALREADY_AUTHORIZED'),
    );
  });

  it('never prints the phone, the code, the password or the session', async () => {
    const { tg } = telegram({
      signIn: (_p, _h, code) =>
        code === CODE
          ? Promise.reject(new FakeRpcError('SESSION_PASSWORD_NEEDED'))
          : Promise.reject(new FakeRpcError('PHONE_CODE_INVALID', 400)),
    });
    const t = io([PHONE], ['99999', CODE, 'nope', PASSWORD]);
    await runLogin(tg, t.terminal, KEY);
    const printed = [...t.said, ...t.prompts].join('\n');
    for (const secret of [PHONE, '998000000001', CODE, '99999', PASSWORD, 'nope', SESSION]) {
      expect(printed).not.toContain(secret);
    }
    expect(t.said).toEqual(['wrong code (attempt 1 of 3)', 'wrong password (attempt 1 of 3)']);
  });
});
