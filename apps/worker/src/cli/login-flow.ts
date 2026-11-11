import { encryptSession } from '../bank-feed/client/session-crypto';
import { errorCode, rpcErrorText, type MtLoginTelegram } from '../bank-feed/client/mtcute-types';

export const MAX_CODE_TRIES = 3;
export const MAX_PASSWORD_TRIES = 3;

/** The operator's terminal: prompts and notes go to stderr, never to stdout (the blob's). */
export interface LoginIo {
  ask(prompt: string): Promise<string>;
  /** Not echoed (the 2FA password). */
  askHidden(prompt: string): Promise<string>;
  say(line: string): void;
}

export type LoginFailure =
  | 'BAD_PHONE'
  | 'ALREADY_AUTHORIZED'
  | 'SIGN_UP_REQUIRED'
  | 'CODE_EXPIRED'
  | 'CODE_TRIES'
  | 'PASSWORD_TRIES'
  | 'FLOOD_WAIT';

const MESSAGES: Readonly<Record<LoginFailure, string>> = {
  BAD_PHONE: 'the phone number is not valid (international format, digits only)',
  ALREADY_AUTHORIZED: 'the client says it is already authorized; nothing was exported',
  SIGN_UP_REQUIRED:
    'this number has no Telegram account; create the working account in the official app first (E-19)',
  CODE_EXPIRED: 'the login code expired; run the command again',
  CODE_TRIES: `wrong login code ${String(MAX_CODE_TRIES)} times; run the command again later`,
  PASSWORD_TRIES: `wrong 2FA password ${String(MAX_PASSWORD_TRIES)} times; run the command again later`,
  FLOOD_WAIT: 'Telegram asks to wait before the next attempt (FLOOD_WAIT); try later',
};

/** A login that ended without a session. The message has no phone, code or password in it. */
export class LoginError extends Error {
  constructor(readonly failure: LoginFailure) {
    super(MESSAGES[failure]);
    this.name = 'LoginError';
  }
}

const PHONE = /^\+?[1-9]\d{6,14}$/;
const CODE = /^\d{4,8}$/;

function isSignUpRequired(error: unknown): boolean {
  // mtcute 0.32.7 throws MtUnsupportedError on auth.authorizationSignUpRequired (S0 spike).
  return (
    errorCode(error) === 'MtUnsupportedError' || rpcErrorText(error) === 'PHONE_NUMBER_UNOCCUPIED'
  );
}

function mapCommon(error: unknown): never {
  const text = rpcErrorText(error);
  if (text?.startsWith('FLOOD_WAIT') === true) throw new LoginError('FLOOD_WAIT');
  if (text === 'PHONE_NUMBER_INVALID' || text === 'PHONE_NUMBER_BANNED') {
    throw new LoginError('BAD_PHONE');
  }
  if (isSignUpRequired(error)) throw new LoginError('SIGN_UP_REQUIRED');
  throw error;
}

/** true: signed in; false: the account has 2FA, the password is next. */
async function enterCode(tg: MtLoginTelegram, io: LoginIo, phone: string, hash: string) {
  for (let attempt = 1; attempt <= MAX_CODE_TRIES; attempt += 1) {
    // Hidden like the password (D-52): a login code on screen or in a terminal log is a session.
    const code = (await io.askHidden('Login code from Telegram (not shown): ')).trim();
    if (!CODE.test(code)) {
      io.say(`not a login code (attempt ${String(attempt)} of ${String(MAX_CODE_TRIES)})`);
      continue;
    }
    try {
      await tg.signIn(phone, hash, code);
      return true;
    } catch (error) {
      const text = rpcErrorText(error);
      if (text === 'SESSION_PASSWORD_NEEDED') return false;
      if (text === 'PHONE_CODE_EXPIRED') throw new LoginError('CODE_EXPIRED');
      if (text !== 'PHONE_CODE_INVALID' && text !== 'PHONE_CODE_EMPTY') mapCommon(error);
      io.say(`wrong code (attempt ${String(attempt)} of ${String(MAX_CODE_TRIES)})`);
    }
  }
  throw new LoginError('CODE_TRIES');
}

async function enterPassword(tg: MtLoginTelegram, io: LoginIo): Promise<void> {
  for (let attempt = 1; attempt <= MAX_PASSWORD_TRIES; attempt += 1) {
    const password = await io.askHidden('2FA password (not shown): ');
    try {
      await tg.checkPassword(password);
      return;
    } catch (error) {
      if (rpcErrorText(error) !== 'PASSWORD_HASH_INVALID') mapCommon(error);
      io.say(`wrong password (attempt ${String(attempt)} of ${String(MAX_PASSWORD_TRIES)})`);
    }
  }
  throw new LoginError('PASSWORD_TRIES');
}

/**
 * The interactive login of the bank-feed working account (docs/05 §4 runbook): phone -> code ->
 * 2FA password, each with a capped number of tries (mtcute's `start()` would re-ask a wrong code
 * forever). Sign-up is not supported: the account is created in the official app. Returns ONLY
 * the AES-256-GCM blob of the session; the plaintext session never leaves this function and is
 * written nowhere.
 */
export async function runLogin(tg: MtLoginTelegram, io: LoginIo, key: Buffer): Promise<string> {
  const phone = (await io.ask('Phone number of the working account (+998...): ')).replace(
    /[\s-]/g,
    '',
  );
  if (!PHONE.test(phone)) throw new LoginError('BAD_PHONE');
  let sent: { readonly phoneCodeHash: string } | null;
  try {
    sent = await tg.sendCode(phone);
  } catch (error) {
    mapCommon(error);
  }
  if (sent === null) throw new LoginError('ALREADY_AUTHORIZED');
  const signedIn = await enterCode(tg, io, phone, sent.phoneCodeHash);
  if (!signedIn) await enterPassword(tg, io);
  return encryptSession(await tg.exportSession(), key);
}
