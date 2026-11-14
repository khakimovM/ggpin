import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { EnvValidationError, loadEnv, loadProcessEnv } from '../env';
import { SecretFileError, type SecretFileReader } from '../secret-file';
import { loadTonKeyEnv } from '../ton-cli-env';
import { TEST_ENV_SOURCE } from './test-env';
import { TEST_TON_API_KEY, tonLiveSource } from './ton-live-env';

// Plan §5 + D-52 D3 for the wallet key: WALLET_ENC_KEY_FILE (the only way in production) or the
// inline key outside production; a dry run reads no wallet secret at all (plan §8). The config
// never holds the pair as strings: a one-shot handle gives it to the wallet factory once (L2).

const PATH = '/run/secrets/wallet_enc_key';
const PROD = { ...TEST_ENV_SOURCE, NODE_ENV: 'production' };

function reader(content: string) {
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

describe('worker env: the TON hot wallet (plan §5)', () => {
  it('a dry run reads no wallet secret and keeps none, even when they are set', () => {
    const live = tonLiveSource();
    const r = reader(live.WALLET_ENC_KEY ?? '');
    const env = loadEnv({ ...TEST_ENV_SOURCE, ...live, WALLET_ENC_KEY: '' }, r.read);
    expect(env.FULFILLMENT_DRY_RUN).toBe(true);
    expect(env.TON_WALLET_SECRET).toBeUndefined();
    expect(env.TON_API_KEY).toBeUndefined();
    expect(Object.keys(env)).not.toContain('TON_MNEMONIC_ENC');
    expect(Object.keys(env)).not.toContain('WALLET_ENC_KEY');
    const withFile = { ...TEST_ENV_SOURCE, WALLET_ENC_KEY_FILE: PATH };
    expect(loadEnv(withFile, r.read).TON_WALLET_SECRET).toBeUndefined();
    expect(r.asked).toEqual([]);
  });

  it('DRY_RUN=false names every missing TON setting at once', () => {
    const message = problemsOf({ ...TEST_ENV_SOURCE, FULFILLMENT_DRY_RUN: 'false' });
    for (const name of [
      'TON_API_ENDPOINT',
      'TON_MNEMONIC_ENC',
      'WALLET_ENC_KEY_FILE',
      'TON_WALLET_ADDRESS',
      'TON_API_KEY',
      'TON_MAX_PER_ORDER_NANO',
      'TON_MAX_DAILY_NANO',
    ]) {
      expect(message).toContain(name);
    }
  });

  it('DRY_RUN=false: the key from its file opens the blob; the config keeps a one-shot handle', () => {
    const live = tonLiveSource();
    const { WALLET_ENC_KEY: key = '', ...rest } = live;
    const r = reader(key);
    const source = {
      ...TEST_ENV_SOURCE,
      ...rest,
      FULFILLMENT_DRY_RUN: 'false',
      WALLET_ENC_KEY_FILE: PATH,
    };
    const env = loadEnv(source, r.read);
    expect(r.asked).toEqual([PATH]);
    expect(env.TON_API_KEY?.headerValueForToncenter()).toBe(TEST_TON_API_KEY);
    // Neither a dump of the config nor its inspection shows the pair.
    const dumped = `${JSON.stringify(env, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v))} ${inspect(env, { depth: 5 })}`;
    expect(dumped).not.toContain(key);
    expect(dumped).not.toContain(live.TON_MNEMONIC_ENC);
    const handle = env.TON_WALLET_SECRET;
    expect(handle?.take()).toEqual({ mnemonicBlob: live.TON_MNEMONIC_ENC, keyText: key });
    // Taken once: nothing in the process can take it again.
    expect(handle?.taken).toBe(true);
    expect(handle?.take()).toBeNull();
  });

  it('a key that does not open the blob, or a bad key, is a boot error without any value', () => {
    const live = tonLiveSource();
    const other = randomBytes(32).toString('base64');
    const wrong = problemsOf({
      ...TEST_ENV_SOURCE,
      ...live,
      FULFILLMENT_DRY_RUN: 'false',
      WALLET_ENC_KEY: other,
    });
    expect(wrong).toContain('TON_MNEMONIC_ENC cannot be opened with WALLET_ENC_KEY');
    expect(wrong).not.toContain(other);
    expect(wrong).not.toContain(live.TON_MNEMONIC_ENC?.slice(0, 16));
    const bad = problemsOf({
      ...TEST_ENV_SOURCE,
      ...live,
      FULFILLMENT_DRY_RUN: 'false',
      WALLET_ENC_KEY: 'c2hvcnQ=',
    });
    expect(bad).toContain('WALLET_ENC_KEY must be 32 random bytes');
    expect(bad).not.toContain('c2hvcnQ=');
  });

  it('production refuses the inline key in any mode', () => {
    const live = tonLiveSource();
    const inline = problemsOf({
      ...PROD,
      FULFILLMENT_DRY_RUN: 'true',
      WALLET_ENC_KEY: live.WALLET_ENC_KEY ?? '',
    });
    expect(inline).toContain('WALLET_ENC_KEY: an inline key is refused in production');
  });

  it('both key forms at once are refused; a TON address must parse', () => {
    const both = problemsOf({ ...TEST_ENV_SOURCE, WALLET_ENC_KEY: 'x', WALLET_ENC_KEY_FILE: PATH });
    expect(both).toContain('WALLET_ENC_KEY and WALLET_ENC_KEY_FILE: set only one of them');
    expect(problemsOf({ ...TEST_ENV_SOURCE, TON_WALLET_ADDRESS: 'not-an-address' })).toContain(
      'TON_WALLET_ADDRESS',
    );
  });

  it('TON_CONFIRM_TIMEOUT_MS must outlast valid_until + the 60 s margin + the 30 s gap + the 90 s signing skew + two polls (D-60 (2), m2, RR2 #4)', () => {
    expect(
      problemsOf({
        ...TEST_ENV_SOURCE,
        TON_SEND_VALID_SEC: '60',
        TON_CONFIRM_TIMEOUT_MS: '246000',
      }),
    ).toContain(
      'TON_CONFIRM_TIMEOUT_MS: must be longer than TON_SEND_VALID_SEC + 60 s + 30 s + 90 s (clock skew at signing) + 6 s (two polls)',
    );
    expect(
      problemsOf({
        ...TEST_ENV_SOURCE,
        TON_SEND_VALID_SEC: '60',
        TON_CONFIRM_TIMEOUT_MS: '246001',
      }),
    ).toBe('');
    // The longest validity still fits the longest wait: 300 + 60 + 30 + 90 + 6 s < 600 s.
    expect(
      problemsOf({
        ...TEST_ENV_SOURCE,
        TON_SEND_VALID_SEC: '300',
        TON_CONFIRM_TIMEOUT_MS: '600000',
      }),
    ).toBe('');
    const env = loadEnv({ ...TEST_ENV_SOURCE });
    expect([env.TON_SEND_VALID_SEC, env.TON_CONFIRM_TIMEOUT_MS, env.TON_FEE_RESERVE_NANO]).toEqual([
      60,
      300_000,
      50_000_000n,
    ]);
  });

  it('loadProcessEnv drops the key, its path, the blob and the API key from the process env', () => {
    // loadProcessEnv sees the real entry point: JEST_WORKER_ID marks this run as a test run.
    const live = tonLiveSource();
    const source: NodeJS.ProcessEnv = {
      ...TEST_ENV_SOURCE,
      ...live,
      FULFILLMENT_DRY_RUN: 'false',
      JEST_WORKER_ID: '1',
    };
    const env = loadProcessEnv(source);
    expect(env.TON_WALLET_SECRET?.take()?.keyText).toBe(live.WALLET_ENC_KEY);
    expect(env.TON_API_KEY?.headerValueForToncenter()).toBe(TEST_TON_API_KEY);
    for (const name of ['WALLET_ENC_KEY', 'TON_MNEMONIC_ENC', 'TON_API_KEY']) {
      expect(source[name]).toBeUndefined();
    }
    const refused: NodeJS.ProcessEnv = {
      ...TEST_ENV_SOURCE,
      WALLET_ENC_KEY_FILE: PATH,
      WALLET_ENC_KEY: 'x',
      TON_API_KEY: TEST_TON_API_KEY,
      JEST_WORKER_ID: '1',
    };
    expect(() => loadProcessEnv(refused)).toThrow(EnvValidationError);
    expect(refused.WALLET_ENC_KEY_FILE).toBeUndefined();
    expect(refused.WALLET_ENC_KEY).toBeUndefined();
    expect(refused.TON_API_KEY).toBeUndefined();
  });
});

describe('ton:encrypt-mnemonic env (the key only)', () => {
  it('reads the key the worker way and forgets it; testnet by default', () => {
    const key = randomBytes(32).toString('base64');
    const source: NodeJS.ProcessEnv = { NODE_ENV: 'development', WALLET_ENC_KEY: key };
    expect(loadTonKeyEnv(source)).toEqual({ network: 'testnet', key });
    expect(source.WALLET_ENC_KEY).toBeUndefined();
    const prod: NodeJS.ProcessEnv = {
      NODE_ENV: 'production',
      TON_NETWORK: 'mainnet',
      WALLET_ENC_KEY_FILE: PATH,
    };
    expect(loadTonKeyEnv(prod, reader(key).read)).toEqual({ network: 'mainnet', key });
  });

  it('refuses a missing key, an inline key in production and an unknown network, without values', () => {
    const key = randomBytes(32).toString('base64');
    const messageOf = (source: NodeJS.ProcessEnv) => {
      try {
        loadTonKeyEnv(source);
      } catch (error) {
        if (error instanceof EnvValidationError) return error.message;
        throw error;
      }
      return '';
    };
    expect(messageOf({ NODE_ENV: 'development' })).toContain('is required but not set');
    const inline = messageOf({ NODE_ENV: 'production', WALLET_ENC_KEY: key });
    expect(inline).toContain('an inline key is refused in production');
    expect(inline).not.toContain(key);
    expect(
      messageOf({ NODE_ENV: 'development', WALLET_ENC_KEY: key, TON_NETWORK: 'devnet' }),
    ).toContain('TON_NETWORK');
  });
});
