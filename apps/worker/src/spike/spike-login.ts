// Phase 4 S0 spike: test-DC client factory and test-number login. Never merged to main.
import { BaseTelegramClient, MemoryStorage, TelegramClient } from '@mtcute/node';
import type { tl } from '@mtcute/node';
import { errCode, out, randomDigits, type TestCredentials } from './spike-util';

const LOG_OFF = 0; // LogManager.OFF: mtcute INFO logs print the display name and username.

const bases = new WeakMap<TelegramClient, BaseTelegramClient>();

// storage MUST be passed: without it @mtcute/node opens SqliteStorage("client.session") on disk.
export function makeTestClient(creds: TestCredentials): TelegramClient {
  const base = new BaseTelegramClient({
    apiId: creds.apiId,
    apiHash: creds.apiHash,
    storage: new MemoryStorage(),
    testMode: true,
    logLevel: LOG_OFF,
  });
  const tg = new TelegramClient({ client: base });
  tg.onError.add((e) => out('client.onError', `const:${errCode(e)}`));
  bases.set(tg, base);
  return tg;
}

/**
 * Proves the client talks to the TEST network before any login code is requested:
 * the server's own help.getConfig must say testMode=true, and the configured default DC
 * must carry the testMode flag. Returns the DC id to build the test phone number from.
 */
export async function assertTestNetwork(tg: TelegramClient, label: string): Promise<number> {
  const cfg = await tg.call({ _: 'help.getConfig' });
  const base = bases.get(tg);
  if (!base) throw new Error('ABORT: unknown client');
  const defaultMain = base.mt._defaultDcs.main;
  out(`${label}.config.testMode`, cfg.testMode);
  out(`${label}.config.thisDc`, cfg.thisDc);
  out(`${label}.defaultDc.main.testMode`, defaultMain.testMode === true);
  out(`${label}.defaultDc.main.isKnownTestIp`, defaultMain.ipAddress === '149.154.167.40');
  if (cfg.testMode !== true || defaultMain.testMode !== true) {
    throw new Error('ABORT: client is not on the Telegram test network');
  }
  return cfg.thisDc;
}

export interface LoginResult {
  phone: string; // kept in memory only, never printed
  newlyRegistered: boolean;
}

/**
 * Logs in with a test number 99966XYYYY (X = DC id); the code is X repeated `length` times
 * (core.telegram.org/api/auth#test-phone-numbers, mirrored by mtcute's own startTest()).
 * mtcute 0.32.7 refuses sign-up (notifyLoggedIn throws MtUnsupportedError on
 * authorizationSignUpRequired), so an unregistered number is signed up with a raw auth.signUp.
 */
export async function loginTestNumber(
  tg: TelegramClient,
  dcId: number,
  label: string,
): Promise<LoginResult> {
  for (let attempt = 1; attempt <= 8; attempt++) {
    const phone = `99966${dcId}${randomDigits(4)}`;
    try {
      const sent = await tg.sendCode({ phone });
      if (!('phoneCodeHash' in sent)) {
        throw new Error('unexpected: sendCode returned a user on a fresh MemoryStorage');
      }
      out(`${label}.login.codeType`, `const:${sent.type}`);
      out(`${label}.login.codeLength`, sent.length);
      const phoneCode = String(dcId).repeat(sent.length);
      let auth: tl.auth.TypeAuthorization = await tg.call({
        _: 'auth.signIn',
        phoneNumber: phone,
        phoneCodeHash: sent.phoneCodeHash,
        phoneCode,
      });
      let newlyRegistered = false;
      if (auth._ === 'auth.authorizationSignUpRequired') {
        newlyRegistered = true;
        auth = await tg.call({
          _: 'auth.signUp',
          phoneNumber: phone,
          phoneCodeHash: sent.phoneCodeHash,
          firstName: 'Spike',
          lastName: label,
        });
      }
      await tg.notifyLoggedIn(auth);
      out(`${label}.login.attempts`, attempt);
      out(`${label}.login.newlyRegistered`, newlyRegistered);
      return { phone, newlyRegistered };
    } catch (e) {
      const code = errCode(e);
      out(`${label}.login.attempt${attempt}.error`, `const:${code}`);
      if (code.startsWith('rpc:FLOOD_WAIT') || code.startsWith('class:Error')) throw e;
      // SESSION_PASSWORD_NEEDED (someone else's shared test number with 2FA) etc.: try another number.
    }
  }
  throw new Error(`${label}: no usable test number after 8 attempts`);
}
