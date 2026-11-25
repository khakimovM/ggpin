import { createHmac, randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { EnvValidationError, loadEnv, loadProcessEnv } from '../env';
import { loadFragmentImportEnv } from '../fragment-import-env';
import {
  FINGERPRINT_LABEL,
  FRAGMENT_KEEPALIVE_DEFAULT_MS,
  FragmentSessionKey,
  fragmentKeySource,
  liveFragmentProblems,
} from '../fragment-session-env';
import { SecretFileError, type SecretFileReader } from '../secret-file';
import { TEST_ENV_SOURCE } from './test-env';
import { tonLiveSource } from './ton-live-env';

// Plan §5 for the Fragment session (phase 5 S7): FRAGMENT_SESSION_ENC_KEY_FILE (the only way in
// production) or the inline key in dev/test; a dry run never reads it (plan §8); the config holds
// it only inside a holder that prints as a placeholder. Keys are random per run.

const PATH = '/run/secrets/fragment_session_key';
const newKey = (): string => randomBytes(32).toString('base64');

function reader(content: string) {
  const asked: string[] = [];
  const read: SecretFileReader = (path) => {
    asked.push(path);
    if (path !== PATH) throw new SecretFileError('cannot be read');
    return content;
  };
  return { asked, read };
}

/** A live source WITHOUT a Fragment session key (tonLiveSource brings an inline one). */
function live(extra: Record<string, string>): Record<string, string> {
  const ton: Record<string, string> = { ...tonLiveSource() };
  delete ton['FRAGMENT_SESSION_ENC_KEY'];
  return { ...TEST_ENV_SOURCE, ...ton, FULFILLMENT_DRY_RUN: 'false', ...extra };
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

describe('worker env: the Fragment session key and keep-alive period (S7)', () => {
  it('the keep-alive period: 20 minutes by default, one minute to one hour', () => {
    expect(loadEnv({ ...TEST_ENV_SOURCE }).FRAGMENT_KEEPALIVE_EVERY_MS).toBe(
      FRAGMENT_KEEPALIVE_DEFAULT_MS,
    );
    expect(FRAGMENT_KEEPALIVE_DEFAULT_MS).toBe(1_200_000);
    const set = (value: string) => ({ ...TEST_ENV_SOURCE, FRAGMENT_KEEPALIVE_EVERY_MS: value });
    expect(loadEnv(set('60000')).FRAGMENT_KEEPALIVE_EVERY_MS).toBe(60_000);
    expect(problemsOf(set('59999'))).toContain('FRAGMENT_KEEPALIVE_EVERY_MS');
    expect(problemsOf(set('3600001'))).toContain('FRAGMENT_KEEPALIVE_EVERY_MS');
  });

  it('a dry run reads no key, from the file or inline, and keeps none', () => {
    const r = reader(newKey());
    const fromFile = loadEnv({ ...TEST_ENV_SOURCE, FRAGMENT_SESSION_ENC_KEY_FILE: PATH }, r.read);
    expect(fromFile.FRAGMENT_SESSION_ENC_KEY).toBeUndefined();
    const inline = loadEnv({ ...TEST_ENV_SOURCE, FRAGMENT_SESSION_ENC_KEY: newKey() });
    expect(inline.FRAGMENT_SESSION_ENC_KEY).toBeUndefined();
    expect(r.asked).toEqual([]);
  });

  it('DRY_RUN=false: the key from the file, held so that it never prints', () => {
    const key = newKey();
    const r = reader(key);
    const env = loadEnv(live({ FRAGMENT_SESSION_ENC_KEY_FILE: PATH }), r.read);
    expect(r.asked).toEqual([PATH]);
    expect(env.FRAGMENT_SESSION_ENC_KEY?.bytesForSessionStore().toString('base64')).toBe(key);
    expect(JSON.stringify({ key: env.FRAGMENT_SESSION_ENC_KEY })).toBe('{"key":"[redacted]"}');
    expect(inspect(env, { depth: 5 })).not.toContain(key);
    expect(String(env.FRAGMENT_SESSION_ENC_KEY)).toBe('[redacted]');
  });

  it('DRY_RUN=false: an inline key in dev; a bad key names the variable, never the value', () => {
    const key = newKey();
    const env = loadEnv(live({ FRAGMENT_SESSION_ENC_KEY: key }));
    expect(env.FRAGMENT_SESSION_ENC_KEY?.bytesForSessionStore().toString('base64')).toBe(key);
    const short = randomBytes(16).toString('base64');
    const message = problemsOf(live({ FRAGMENT_SESSION_ENC_KEY: short }));
    expect(message).toContain('FRAGMENT_SESSION_ENC_KEY');
    expect(message).not.toContain(short);
    const unreadable = problemsOf(
      live({ FRAGMENT_SESSION_ENC_KEY_FILE: '/elsewhere' }),
      reader('').read,
    );
    expect(unreadable).toContain('FRAGMENT_SESSION_ENC_KEY_FILE');
    expect(unreadable).not.toContain('/elsewhere');
  });

  it('both at once is refused; inline in production is refused (dry run or not)', () => {
    const both = { FRAGMENT_SESSION_ENC_KEY: newKey(), FRAGMENT_SESSION_ENC_KEY_FILE: PATH };
    expect(problemsOf({ ...TEST_ENV_SOURCE, ...both })).toContain('set only one of them');
    const prod = fragmentKeySource({ FRAGMENT_SESSION_ENC_KEY: newKey() }, true, false);
    expect(prod.key).toBeUndefined();
    expect(prod.problems.join(' ')).toContain('refused in production');
    const prodFile = fragmentKeySource(
      { FRAGMENT_SESSION_ENC_KEY_FILE: PATH },
      true,
      true,
      reader(newKey()).read,
    );
    expect(prodFile.problems).toEqual([]);
    expect(prodFile.key).toBeDefined();
  });

  it('L-4: a live worker without any session key does not boot; a dry run needs none', () => {
    expect(problemsOf(live({}))).toContain(
      'FRAGMENT_SESSION_ENC_KEY_FILE (or FRAGMENT_SESSION_ENC_KEY outside production): is required with FULFILLMENT_DRY_RUN=false',
    );
    expect(problemsOf({ ...TEST_ENV_SOURCE })).toBe('');
  });

  it.each([
    ['NODE_TLS_REJECT_UNAUTHORIZED', '0'],
    ['NODE_EXTRA_CA_CERTS', 'C:/certs/extra-ca.pem'],
    ['NODE_USE_SYSTEM_CA', '1'],
    ['NODE_USE_ENV_PROXY', '1'],
    ['HTTPS_PROXY', 'http://proxy.invalid:8080'],
    ['https_proxy', 'http://proxy.invalid:8080'],
    ['HTTP_PROXY', 'http://proxy.invalid:8080'],
    ['ALL_PROXY', 'socks5://proxy.invalid:1080'],
    ['SSL_CERT_FILE', 'C:/certs/ca.pem'],
    ['SSL_CERT_DIR', 'C:/certs'],
    ['OPENSSL_CONF', 'C:/certs/openssl.cnf'],
    ['NODE_OPTIONS', '--use-system-ca'],
    ['NODE_OPTIONS', '--max-old-space-size=512 --use-openssl-ca'],
    ['NODE_OPTIONS', '--use_env_proxy'],
  ])(
    'L-2: a live worker refuses %s (named, never its value); a dry run allows it',
    (name, value) => {
      const message = problemsOf(live({ FRAGMENT_SESSION_ENC_KEY: newKey(), [name]: value }));
      expect(message).toContain(`${name}`);
      expect(message).toContain('refused with FULFILLMENT_DRY_RUN=false');
      if (value.length > 1 && name !== 'NODE_OPTIONS') expect(message).not.toContain(value);
      expect(problemsOf({ ...TEST_ENV_SOURCE, [name]: value })).toBe('');
    },
  );

  it('L-2: TLS checks on (NODE_TLS_REJECT_UNAUTHORIZED=1) and a blank proxy are fine', () => {
    const ok = live({
      FRAGMENT_SESSION_ENC_KEY: newKey(),
      NODE_TLS_REJECT_UNAUTHORIZED: '1',
      HTTPS_PROXY: '  ',
    });
    expect(problemsOf(ok)).toBe('');
  });

  it('N-3: other NODE_OPTIONS (a heap size) are fine; refused flags on the command line too', () => {
    const heap = live({
      FRAGMENT_SESSION_ENC_KEY: newKey(),
      NODE_OPTIONS: '--max-old-space-size=512',
    });
    expect(problemsOf(heap)).toBe('');
    const key = fragmentKeySource({ FRAGMENT_SESSION_ENC_KEY: newKey() }, false, true);
    for (const flag of ['--use-system-ca', '--use-openssl-ca', '--use-env-proxy']) {
      expect(liveFragmentProblems({}, key, undefined, ['--inspect=0', flag])).toEqual([
        `node option ${flag} is set: refused with FULFILLMENT_DRY_RUN=false`,
      ]);
    }
    expect(liveFragmentProblems({}, key, undefined, ['--max-old-space-size=512'])).toEqual([]);
  });

  it('I-11: the session key may not be the wallet key (named, never the value)', () => {
    const same = newKey();
    const message = problemsOf(live({ FRAGMENT_SESSION_ENC_KEY: same, WALLET_ENC_KEY: same }));
    expect(message).toContain(
      'FRAGMENT_SESSION_ENC_KEY and WALLET_ENC_KEY: must be two different keys',
    );
    expect(message).not.toContain(same);
    expect(problemsOf(live({ FRAGMENT_SESSION_ENC_KEY: newKey() }))).toBe('');
    const holder = new FragmentSessionKey(same);
    expect(holder.sameAs(`${same}\n`)).toBe(true);
    expect(holder.sameAs('not a key')).toBe(false);
  });

  it('L-4 / I-8: an 8-hex keyed fingerprint; the store gets a copy it may wipe', () => {
    const text = newKey();
    const key = new FragmentSessionKey(text);
    const expected = createHmac('sha256', Buffer.from(text, 'base64'))
      .update(FINGERPRINT_LABEL)
      .digest('hex')
      .slice(0, 8);
    expect(key.fingerprint()).toBe(expected);
    expect(new FragmentSessionKey(newKey()).fingerprint()).not.toBe(expected);
    key.bytesForSessionStore().fill(0);
    expect(key.bytesForSessionStore().toString('base64')).toBe(text);
    expect(key.fingerprint()).toBe(expected);
  });

  it('loadProcessEnv drops the key and its path from the process env', () => {
    const source: NodeJS.ProcessEnv = {
      ...live({ FRAGMENT_SESSION_ENC_KEY: newKey() }),
      JEST_WORKER_ID: '1',
    };
    expect(loadProcessEnv(source).FRAGMENT_SESSION_ENC_KEY).toBeDefined();
    expect(source['FRAGMENT_SESSION_ENC_KEY']).toBeUndefined();
    expect(source['FRAGMENT_SESSION_ENC_KEY_FILE']).toBeUndefined();
  });
});

describe('fragment:session-import env', () => {
  const DB = 'postgresql://u:p@localhost:5433/ggpin_dev';

  it('DATABASE_URL and the key (always read, inline outside production), then forgotten', () => {
    const key = newKey();
    const source: NodeJS.ProcessEnv = { DATABASE_URL: DB, FRAGMENT_SESSION_ENC_KEY: key };
    const env = loadFragmentImportEnv(source);
    expect(env.DATABASE_URL).toBe(DB);
    expect(env.key.bytesForSessionStore().toString('base64')).toBe(key);
    expect(source['FRAGMENT_SESSION_ENC_KEY']).toBeUndefined();
    const r = reader(newKey());
    const prod = loadFragmentImportEnv(
      { NODE_ENV: 'production', DATABASE_URL: DB, FRAGMENT_SESSION_ENC_KEY_FILE: PATH },
      r.read,
    );
    expect(prod.key).toBeDefined();
    expect(r.asked).toEqual([PATH]);
  });

  it('refuses no key, a bad URL, or an inline key in production, naming variables only', () => {
    const key = newKey();
    const message = (source: NodeJS.ProcessEnv) => {
      try {
        loadFragmentImportEnv(source);
        return '';
      } catch (error) {
        if (error instanceof EnvValidationError) return error.message;
        throw error;
      }
    };
    expect(message({ DATABASE_URL: DB })).toContain('FRAGMENT_SESSION_ENC_KEY_FILE');
    expect(message({ DATABASE_URL: 'mysql://x/y', FRAGMENT_SESSION_ENC_KEY: key })).toContain(
      'DATABASE_URL',
    );
    const prod = message({
      NODE_ENV: 'production',
      DATABASE_URL: DB,
      FRAGMENT_SESSION_ENC_KEY: key,
    });
    expect(prod).toContain('refused in production');
    expect(prod).not.toContain(key);
  });
});
