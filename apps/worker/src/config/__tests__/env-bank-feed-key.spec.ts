import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encryptSession, parseSessionKey } from '../../bank-feed/client/session-crypto';
import { loadLoginEnv } from '../bank-feed-login-env';
import { EnvValidationError, loadEnv, loadProcessEnv } from '../env';
import { SecretFileError, readSecretFile, tooOpen, type SecretFileReader } from '../secret-file';
import { TEST_ENV_SOURCE } from './test-env';

// D-52 D3: the session key from a Docker-secret file, inline only outside production.
const KEY = randomBytes(32).toString('base64');
const BLOB = encryptSession('TESTSESSION', parseSessionKey(KEY));
const PATH = '/run/secrets/bank_feed_enc_key';
const LIVE = {
  BANK_FEED_HUMO_BOT_ID: '111000111',
  BANK_FEED_UZCARD_BOT_ID: '222000222',
  BANK_FEED_MODE: 'live',
  BANK_FEED_API_ID: '123456',
  BANK_FEED_API_HASH: 'ab'.repeat(16),
  BANK_FEED_SESSION_ENC: BLOB,
};
const PROD = { ...TEST_ENV_SOURCE, NODE_ENV: 'production', FULFILLMENT_DRY_RUN: 'true' };

/** A reader that serves the key for PATH only, and records what it was asked for. */
function reader(content = KEY) {
  const asked: string[] = [];
  const read: SecretFileReader = (path) => {
    asked.push(path);
    if (path !== PATH) throw new SecretFileError('cannot be read');
    return content;
  };
  return { asked, read };
}

function problemsOf(source: Record<string, string>, read?: SecretFileReader): string {
  try {
    loadEnv(source, read);
    return '';
  } catch (error) {
    if (error instanceof EnvValidationError) return error.message;
    throw error;
  }
}

describe('worker env: BANK_FEED_ENC_KEY_FILE (D-52 D3)', () => {
  it('the key comes from the file, read once, in live mode too', () => {
    const r = reader();
    const env = loadEnv({ ...TEST_ENV_SOURCE, ...LIVE, BANK_FEED_ENC_KEY_FILE: PATH }, r.read);
    expect(env.BANK_FEED_ENC_KEY).toBe(KEY);
    expect(r.asked).toEqual([PATH]);
  });

  it('production refuses the inline key, even when it is correct', () => {
    const message = problemsOf({ ...PROD, ...LIVE, BANK_FEED_ENC_KEY: KEY });
    expect(message).toContain('BANK_FEED_ENC_KEY: an inline key is refused in production');
    expect(message).not.toContain(KEY.slice(0, 16));
    const r = reader();
    expect(problemsOf({ ...PROD, ...LIVE, BANK_FEED_ENC_KEY_FILE: PATH }, r.read)).not.toContain(
      'BANK_FEED_ENC_KEY',
    );
  });

  it('dev/test may use the inline key; both at once is refused everywhere', () => {
    expect(problemsOf({ ...TEST_ENV_SOURCE, ...LIVE, BANK_FEED_ENC_KEY: KEY })).toBe('');
    const both = { ...LIVE, BANK_FEED_ENC_KEY: KEY, BANK_FEED_ENC_KEY_FILE: PATH };
    expect(problemsOf({ ...TEST_ENV_SOURCE, ...both }, reader().read)).toContain(
      'set only one of them',
    );
  });

  it('a file that cannot be read, or holds a bad key, is a boot error without path or value', () => {
    const missing = problemsOf(
      { ...TEST_ENV_SOURCE, ...LIVE, BANK_FEED_ENC_KEY_FILE: '/run/secrets/other' },
      reader().read,
    );
    expect(missing).toContain('BANK_FEED_ENC_KEY_FILE: cannot be read');
    expect(missing).not.toContain('/run/secrets/other');
    const bad = problemsOf(
      { ...TEST_ENV_SOURCE, ...LIVE, BANK_FEED_ENC_KEY_FILE: PATH },
      reader('c2hvcnQ=').read,
    );
    expect(bad).toContain('BANK_FEED_ENC_KEY must be 32 random bytes');
    expect(bad).not.toContain('c2hvcnQ=');
  });

  it('loadProcessEnv removes the key and its path from the process env, also on a refusal', () => {
    // loadProcessEnv sees the real entry point: JEST_WORKER_ID marks this run as a test run.
    const ok: NodeJS.ProcessEnv = {
      ...TEST_ENV_SOURCE,
      JEST_WORKER_ID: '1',
      BANK_FEED_ENC_KEY: KEY,
    };
    expect(loadProcessEnv(ok).BANK_FEED_ENC_KEY).toBe(KEY);
    expect(ok.BANK_FEED_ENC_KEY).toBeUndefined();
    const refused: NodeJS.ProcessEnv = {
      ...TEST_ENV_SOURCE,
      JEST_WORKER_ID: '1',
      BANK_FEED_ENC_KEY: KEY,
      BANK_FEED_ENC_KEY_FILE: PATH,
    };
    expect(() => loadProcessEnv(refused)).toThrow(EnvValidationError);
    expect(refused.BANK_FEED_ENC_KEY).toBeUndefined();
    expect(refused.BANK_FEED_ENC_KEY_FILE).toBeUndefined();
  });

  it('the login CLI takes the key the same way and forgets it', () => {
    const source: NodeJS.ProcessEnv = {
      BANK_FEED_API_ID: '123456',
      BANK_FEED_API_HASH: 'ab'.repeat(16),
      BANK_FEED_ENC_KEY_FILE: PATH,
    };
    expect(loadLoginEnv(source, reader().read).BANK_FEED_ENC_KEY).toBe(KEY);
    expect(source.BANK_FEED_ENC_KEY_FILE).toBeUndefined();
    expect(() =>
      loadLoginEnv({
        NODE_ENV: 'production',
        BANK_FEED_API_ID: '123456',
        BANK_FEED_API_HASH: 'ab'.repeat(16),
        BANK_FEED_ENC_KEY: KEY,
      }),
    ).toThrow(/an inline key is refused in production/);
  });

  it('N1: the poll interval is 5..60 s; a bot id above 2^53 - 1 is a boot error', () => {
    expect(problemsOf({ ...TEST_ENV_SOURCE, BANK_FEED_POLL_SEC: '60' })).toBe('');
    expect(problemsOf({ ...TEST_ENV_SOURCE, BANK_FEED_POLL_SEC: '61' })).toContain(
      'BANK_FEED_POLL_SEC',
    );
    expect(problemsOf({ ...TEST_ENV_SOURCE, BANK_FEED_HUMO_BOT_ID: '9007199254740993' })).toContain(
      'BANK_FEED_HUMO_BOT_ID: must not exceed 2^53 - 1',
    );
  });
});

// The real platform for plain reads: on a Windows dev box every file looks 0666 to node.
const HOST = process.platform;

describe('readSecretFile (D-52 D3)', () => {
  let dir = '';
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ggpin-secret-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function file(name: string, content: string, mode: number): string {
    const path = join(dir, name);
    writeFileSync(path, content);
    chmodSync(path, mode);
    return path;
  }

  it('reads and trims a private file; refuses an empty one', () => {
    expect(readSecretFile(file('ok', `${KEY}\n`, 0o600), HOST)).toBe(KEY);
    expect(() => readSecretFile(file('empty', ' \n', 0o600), HOST)).toThrow('the file is empty');
  });

  it('a missing path or a directory is refused without naming the path', () => {
    expect(() => readSecretFile(join(dir, 'nope'), HOST)).toThrow('cannot be read');
    expect(() => readSecretFile(dir, HOST)).toThrow('is not a regular file');
  });

  it('on POSIX only 0400/0600 pass; group/other bits or the execute bit are refused', () => {
    for (const mode of [0o100400, 0o100600]) expect(tooOpen(mode, 'linux')).toBe(false);
    for (const mode of [0o100644, 0o100640, 0o100604, 0o100700, 0o100444]) {
      expect(tooOpen(mode, 'linux')).toBe(true);
    }
    // A file as Windows reports it (0666) is refused with a POSIX platform: the check is on.
    expect(() => readSecretFile(file('wide', KEY, 0o644), 'linux')).toThrow(
      'file permissions are wider than 0600',
    );
  });

  it('Windows has no such mode bits: the check is off there, for dev only (r2 I-1: production on win32 is refused)', () => {
    expect(readSecretFile(file('win', KEY, 0o644), 'win32')).toBe(KEY);
    expect(() => readSecretFile(file('win-prod', KEY, 0o600), 'win32', true)).toThrow(
      'a production worker on Windows cannot check the file mode',
    );
  });
});
