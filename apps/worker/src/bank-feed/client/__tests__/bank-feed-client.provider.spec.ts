import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { randomBytes } from 'node:crypto';
import { buildTestEnv } from '../../../config/__tests__/test-env';
import { createBankFeedClient } from '../bank-feed-client.provider';
import { FakeBankFeedClient } from '../fake-bank-feed.client';
import { MtcuteBankFeedClient } from '../mtcute-bank-feed.client';
import { createTelegram, MTCUTE_LOG_OFF, type MtcuteModule } from '../mtcute-loader';
import { encryptSession, parseSessionKey } from '../session-crypto';

const SRC = join(__dirname, '..', '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'coverage' ? [] : sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

// Jest loads the CJS build (production uses import(), the ESM build): mute only its deprecation note.
beforeEach(() => {
  const warn = console.warn.bind(console);
  jest.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].startsWith('[@mtcute/node]')) return;
    warn(...args);
  });
});
afterEach(() => jest.restoreAllMocks());

describe('createBankFeedClient (BANK_FEED_MODE)', () => {
  it('off: no client, and @mtcute/node is never loaded', async () => {
    const load = jest.fn<Promise<MtcuteModule>, []>();
    expect(await createBankFeedClient(buildTestEnv(), load)).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it('fake: the in-memory client, and @mtcute/node is never loaded (no native module needed)', async () => {
    const load = jest.fn<Promise<MtcuteModule>, []>();
    const client = await createBankFeedClient(buildTestEnv({ BANK_FEED_MODE: 'fake' }), load);
    expect(client).toBeInstanceOf(FakeBankFeedClient);
    expect(load).not.toHaveBeenCalled();
  });

  it('live: loads @mtcute/node once and builds the mtcute client', async () => {
    const key = randomBytes(32).toString('base64');
    const env = buildTestEnv({
      BANK_FEED_MODE: 'live',
      BANK_FEED_API_ID: '123456',
      BANK_FEED_API_HASH: 'ab'.repeat(16),
      BANK_FEED_ENC_KEY: key,
      BANK_FEED_SESSION_ENC: encryptSession('TESTSESSION', parseSessionKey(key)),
      BANK_FEED_HUMO_BOT_ID: '111000111',
      BANK_FEED_UZCARD_BOT_ID: '222000222',
    });
    const real = jest.requireActual<MtcuteModule>('@mtcute/node');
    const load = jest.fn(() => Promise.resolve(real));
    const client = await createBankFeedClient(env, load);
    expect(load).toHaveBeenCalledTimes(1);
    expect(client).toBeInstanceOf(MtcuteBankFeedClient);
    await client?.close();
  });

  it('only mtcute-loader.ts loads @mtcute/node at run time; every other file imports types only', () => {
    const offenders = sourceFiles(SRC)
      .filter((path) => !path.includes('__tests__'))
      .filter((path) => {
        const text = readFileSync(path, 'utf8');
        const valueImport = /^import (?!type )[^;]*from '@mtcute\/node'/m.test(text);
        const dynamic = /(import|require)\(\s*'@mtcute\/node'\s*\)/.test(text);
        return valueImport || (dynamic && !path.endsWith('mtcute-loader.ts'));
      })
      .map((path) => relative(SRC, path));
    expect(offenders).toEqual([]);
  });
});

describe('createTelegram (the real @mtcute/node 0.32.7, no network)', () => {
  it('always uses MemoryStorage (never the SQLite file) with mtcute logging off', async () => {
    const real = jest.requireActual<MtcuteModule>('@mtcute/node');
    const seen: { storage?: unknown; logLevel?: number }[] = [];
    class RecordingBase extends real.BaseTelegramClient {
      constructor(options: ConstructorParameters<typeof real.BaseTelegramClient>[0]) {
        seen.push({ storage: options.storage, logLevel: options.logLevel });
        super(options);
      }
    }
    const telegram = createTelegram(
      { ...real, BaseTelegramClient: RecordingBase },
      { apiId: 1, apiHash: '0'.repeat(32) },
    );
    await telegram.destroy();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.storage).toBeInstanceOf(real.MemoryStorage);
    expect(seen[0]?.logLevel).toBe(MTCUTE_LOG_OFF);
    expect(existsSync('client.session')).toBe(false);
  });
});
