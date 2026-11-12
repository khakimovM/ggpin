import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FAKE } from '../../adapters/fragment/__tests__/fragment-fakes';
import { ForeignHostError, assertFragmentUrl } from '../../adapters/fragment/fragment-page';
import { fragmentRecordEnvRefusal } from '../../config/fragment-record-env';
import {
  FragmentRecorderClient,
  RECORDER_API_METHODS,
  RecorderCookieJar,
  type RecorderApiMethod,
} from '../fragment-record-client';
import { writeFixture } from '../fragment-record-output';
import { fakeFragment } from './fake-fragment';

const SRC = path.resolve(__dirname, '../..');
const ENTRY = path.join(SRC, 'cli', 'fragment-record.ts');

/** Every file the tool loads (relative imports, followed) and every package it imports. */
function importGraph(entry: string): { files: string[]; packages: string[] } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() ?? '';
    if (files.has(file)) continue;
    files.add(file);
    const source = readFileSync(file, 'utf8');
    const specifiers = [
      ...source.matchAll(/\bfrom\s+'([^']+)'/g),
      ...source.matchAll(/\bimport\s*\(\s*'([^']+)'\s*\)/g),
      ...source.matchAll(/\brequire\s*\(\s*'([^']+)'\s*\)/g),
      ...source.matchAll(/^\s*import\s+'([^']+)'/gm),
    ].map((m) => m[1] ?? '');
    for (const spec of specifiers) {
      if (spec.startsWith('.')) {
        const target = path.resolve(path.dirname(file), `${spec}.ts`);
        expect({ spec, exists: existsSync(target) }).toEqual({ spec, exists: true });
        queue.push(target);
      } else {
        packages.add(spec);
      }
    }
  }
  return { files: [...files].sort(), packages: [...packages].sort() };
}

describe('fragment-record: no TON, no signing, no other process code', () => {
  const graph = importGraph(ENTRY);

  it('imports only allowed Node built-ins and zod (no @ton/*, no app module, no database)', () => {
    const allowed = [
      'node:fs',
      'node:fs/promises',
      'node:os',
      'node:path',
      'node:timers/promises',
      'node:util',
      'zod',
    ];
    for (const pkg of graph.packages) {
      expect({ pkg, allowed: allowed.includes(pkg) }).toEqual({ pkg, allowed: true });
    }
  });

  it('S-12: loads no process, socket or raw network module', () => {
    const banned =
      /^(node:)?(child_process|net|http|https|http2|tls|dgram|dns|cluster|worker_threads|vm)$/;
    for (const pkg of graph.packages) {
      expect({ pkg, banned: banned.test(pkg) }).toEqual({ pkg, banned: false });
    }
  });

  it('S-12: calls fetch( in exactly one file, the entry point that injects it', () => {
    const callers = graph.files.filter((f) => /(?<![.\w])fetch\(/.test(readFileSync(f, 'utf8')));
    expect(callers.map((f) => path.relative(SRC, f))).toEqual([
      path.join('cli', 'fragment-record.ts'),
    ]);
  });

  it('carries no signing, sending or key code in any loaded file', () => {
    for (const file of graph.files) {
      const source = readFileSync(file, 'utf8');
      for (const banned of [
        /@ton\//,
        /tonweb/i,
        /sendBoc/i,
        /confirmReq/,
        /mnemonic/i,
        /secretKey|keyPair|privateKey/,
      ]) {
        expect({ file: path.relative(SRC, file), banned: banned.test(source) }).toEqual({
          file: path.relative(SRC, file),
          banned: false,
        });
      }
    }
  });

  it('reads the environment in one config file, and only the guarded keys there', () => {
    const readers = graph.files.filter((f) => /process\.env/.test(readFileSync(f, 'utf8')));
    expect(readers.map((f) => path.relative(SRC, f))).toEqual([
      path.join('config', 'fragment-record-env.ts'),
    ]);
    const source = readFileSync(readers[0] ?? '', 'utf8');
    expect([...source.matchAll(/source\[\s*'([A-Za-z_]+)'\s*\]/g)].map((m) => m[1])).toEqual([
      'NODE_ENV',
      'NODE_TLS_REJECT_UNAUTHORIZED',
      'NODE_OPTIONS',
      'OneDrive',
      'OneDriveConsumer',
      'OneDriveCommercial',
      'npm_lifecycle_event',
    ]);
    // The only computed read walks the refused names (and their lower-case forms).
    expect([...source.matchAll(/source\[\s*[a-z]+\s*\]/g)].map((m) => m[0])).toEqual([
      'source[key]',
    ]);
    expect(source).not.toMatch(/source\.[A-Za-z_]/);
  });

  it('allows exactly the three money-free API methods', () => {
    expect([...RECORDER_API_METHODS]).toEqual([
      'searchStarsRecipient',
      'initBuyStarsRequest',
      'getBuyStarsLink',
    ]);
  });

  it('refuses any other method at run time', async () => {
    const fake = fakeFragment();
    const client = new FragmentRecorderClient(fake.fetch, null, 1000);
    const other = 'confirm' + 'Req';
    await expect(client.api(FAKE.hash, other as RecorderApiMethod, {})).rejects.toThrow(
      'method not allowed',
    );
    await expect(client.api('not-hex!', 'searchStarsRecipient', {})).rejects.toThrow(
      'malformed api hash',
    );
    expect(fake.calls).toEqual([]);
  });
});

describe('fragment-record: host guard and cookie jar', () => {
  it.each([
    'http://fragment.com/stars',
    'https://fragment.com.example.org/',
    'https://example.org/',
    '//example.org/x',
    'https://fragment.com:8443/',
    'https://user:pw@fragment.com/',
    'https://evilfragment.com/',
    'https://www.fragment.com/',
  ])('refuses %s', (url) => {
    expect(() => assertFragmentUrl(url)).toThrow(ForeignHostError);
  });

  it('accepts fragment.com paths', () => {
    expect(assertFragmentUrl('/api?hash=00ff00ff').toString()).toBe(
      'https://fragment.com/api?hash=00ff00ff',
    );
  });

  it('follows a same-host redirect and keeps its Set-Cookie', async () => {
    const fake = fakeFragment((call) =>
      call.url.endsWith('/stars/buy')
        ? new Response(null, {
            status: 302,
            headers: [
              ['location', '/stars'],
              ['set-cookie', 'stel_dt=-180; path=/'],
            ],
          })
        : null,
    );
    const jar = new RecorderCookieJar(new Map([['stel_dt', '-300']]));
    const exchange = await new FragmentRecorderClient(fake.fetch, jar, 1000).page();
    expect(exchange.redirects).toEqual([{ status: 302, path: '/stars/buy' }]);
    expect(fake.calls.map((c) => c.url)).toEqual([
      'https://fragment.com/stars/buy',
      'https://fragment.com/stars',
    ]);
    expect(fake.calls[1]?.cookie).toBe('stel_dt=-180');
  });

  it('ignores cookies for other domains and drops expired ones', () => {
    const jar = new RecorderCookieJar(new Map([['a', '1']]));
    expect(jar.apply('b=2; Domain=example.org')).toBeNull();
    expect(jar.apply('c=3; Domain=.fragment.com')).toBe('c');
    expect(jar.apply('a=1; Max-Age=0')).toBe('a');
    expect(jar.header()).toBe('c=3');
  });
});

describe('fragment-record: production and leak gate', () => {
  it('refuses NODE_ENV=production, TLS checks off and NODE_OPTIONS (S-8)', () => {
    expect(fragmentRecordEnvRefusal({ NODE_ENV: 'production' })).toBe('NODE_ENV is production');
    expect(fragmentRecordEnvRefusal({ NODE_ENV: ' Production ' })).toBe('NODE_ENV is production');
    expect(fragmentRecordEnvRefusal({ NODE_ENV: 'development' })).toBeNull();
    expect(fragmentRecordEnvRefusal({})).toBeNull();
    expect(fragmentRecordEnvRefusal({ NODE_TLS_REJECT_UNAUTHORIZED: '0' })).toContain('TLS');
    expect(fragmentRecordEnvRefusal({ NODE_TLS_REJECT_UNAUTHORIZED: '1' })).toBeNull();
    expect(fragmentRecordEnvRefusal({ NODE_OPTIONS: '--inspect' })).toBe('NODE_OPTIONS is set');
    expect(fragmentRecordEnvRefusal({ NODE_OPTIONS: ' ' })).toBeNull();
    // R-11, N8: certificates, debug output and proxies, upper and lower case.
    for (const name of [
      'NODE_EXTRA_CA_CERTS',
      'NODE_DEBUG',
      'NODE_USE_ENV_PROXY',
      'NODE_USE_SYSTEM_CA',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
    ]) {
      for (const key of [name, name.toLowerCase()]) {
        expect(fragmentRecordEnvRefusal({ [key]: 'x' })).toBe(`${key} is set`);
        expect(fragmentRecordEnvRefusal({ [key]: '' })).toBeNull();
      }
    }
  });

  it('withholds a fixture that still fails the leak check', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'fragment-leak-'));
    try {
      const sanitizer = { sanitizeJson: (v: unknown) => v, sanitizeText: (t: string) => t };
      const outcome = await writeFixture(
        dir,
        'x.json',
        { value: { a: 1 }, fullBodies: [] },
        sanitizer,
        () => ['cookie'],
      );
      expect(outcome).toEqual({ written: false, file: 'x.json', leaks: ['cookie'] });
      // R-1: a clean excerpt is still withheld when the whole page it came from leaks.
      const whole = await writeFixture(
        dir,
        'y.json',
        { value: { a: 1 }, fullBodies: ['whole page'] },
        sanitizer,
        (text) => (text === 'whole page' ? ['name'] : []),
      );
      expect(whole).toEqual({ written: false, file: 'y.json', leaks: ['name'] });
      expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
