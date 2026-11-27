import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  FAKE,
  OWNER_WALLET,
  initResponse,
  loggedInPage,
  slashAccountFill,
  form,
} from '../../adapters/fragment/__tests__/fragment-fakes';
import { NO_TON_SENT } from '../fragment-record-main';
import { CONFIRM, expectClean, runRecorder, useTempFolder } from './record-harness';

const h = useTempFolder();
const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const isInit = (form: URLSearchParams | null): boolean =>
  form?.get('method') === 'initBuyStarsRequest';

describe('fragment-record: secrets echoed back by fragment.com', () => {
  it('m1: a redirect’s Set-Cookie echoed in the page never reaches staging', async () => {
    const { code } = await runRecorder(h, CONFIRM, {
      override: (call) => {
        if (call.method !== 'GET' || call.cookie === null) return null;
        if (call.url.endsWith('/stars/buy')) {
          return new Response(null, {
            status: 302,
            headers: [
              ['location', '/stars'],
              ['set-cookie', `stel_ssid=${FAKE.refreshedSsid}; path=/; secure`],
            ],
          });
        }
        const page = loggedInPage().replace('</body>', `<i>${FAKE.refreshedSsid}</i></body>`);
        return new Response(page, { headers: { 'content-type': 'text/html' } });
      },
    });
    expect(code).toBe(0);
    for (const name of readdirSync(h.stagingDir())) expectClean(h.staged(name));
  });

  it('m3: the refreshed stel_ssid echoed in a later API answer is cleaned', async () => {
    const { code } = await runRecorder(h, CONFIRM, {
      override: (call) =>
        isInit(call.form) ? json({ ...initResponse(), note: `ssid ${FAKE.refreshedSsid}` }) : null,
    });
    expect(code).toBe(0);
    expect(h.staged('init-buy-stars.json')).toContain('"note": "ssid <REDACTED:cookie>"');
    expectClean(h.staged('init-buy-stars.json'));
  });

  it('S-3: --wallet removes the owner wallet in a %2F-encoded std-base64 form', async () => {
    const wallet = form(slashAccountFill(), 'std');
    const { code } = await runRecorder(h, [...CONFIRM, '--wallet', wallet], {
      override: (call) =>
        isInit(call.form) ? json({ ...initResponse(), from: encodeURIComponent(wallet) }) : null,
    });
    expect(code).toBe(0);
    const longest = wallet.split(/[+/]/).sort((a, b) => b.length - a.length)[0] ?? wallet;
    expect(h.staged('init-buy-stars.json')).not.toContain(longest);
  });

  it('S-1: a wallet tail echoed alone is withheld by the independent leak check', async () => {
    writeFileSync(path.join(h.base(), 'redact.txt'), `Ggwork Co\n${OWNER_WALLET}\n`);
    const { code, stdout } = await runRecorder(h, [...CONFIRM, '--redact', 'redact.txt'], {
      override: (call) =>
        isInit(call.form) ? json({ ...initResponse(), tail: `…${OWNER_WALLET.slice(-8)}` }) : null,
    });
    expect(code).toBe(1);
    expect(readdirSync(h.stagingDir())).not.toContain('init-buy-stars.json');
    expect(stdout).toContain(
      'fragment-record: withheld: init-buy-stars.json (leak check: address)',
    );
    for (const line of stdout) expect(line).not.toContain(OWNER_WALLET.slice(-8));
  });
});

describe('fragment-record: refusals and stops', () => {
  it('stops at a redirect to another host and never follows it', async () => {
    const { code, fake, stdout } = await runRecorder(h, CONFIRM, {
      override: (call) =>
        call.method === 'GET'
          ? new Response(null, { status: 302, headers: { location: 'https://example.org/x' } })
          : null,
    });
    expect(code).toBe(1);
    expect(fake.calls).toHaveLength(1);
    expect(stdout.some((l) => l.includes('stopped early: refused'))).toBe(true);
    expect(stdout.at(-1)).toBe(`fragment-record: ${NO_TON_SENT}`);
  });

  it('m3: an endless same-host redirect makes exactly 4 calls and exits 1', async () => {
    const { code, fake, stdout } = await runRecorder(h, CONFIRM, {
      override: (call) =>
        call.method === 'GET'
          ? new Response(null, { status: 302, headers: { location: '/stars/buy' } })
          : null,
    });
    expect(code).toBe(1);
    expect(fake.calls).toHaveLength(4);
    expect(fake.apiMethods()).toEqual([]);
    expect(stdout).toContain('fragment-record: stopped early: no api hash on the page');
  });

  it('stops when an API answer redirects to another host', async () => {
    const { code, fake } = await runRecorder(h, CONFIRM, {
      override: (call) =>
        call.form?.get('method') === 'searchStarsRecipient'
          ? new Response(null, { status: 307, headers: { location: '//example.org/api' } })
          : null,
    });
    expect(code).toBe(1);
    expect(fake.apiMethods()).toEqual(['searchStarsRecipient']);
    for (const call of fake.calls) expect(new URL(call.url).hostname).toBe('fragment.com');
  });

  it.each([
    [{ NODE_ENV: 'production' }, 'NODE_ENV is production'],
    [{ NODE_TLS_REJECT_UNAUTHORIZED: '0' }, 'NODE_TLS_REJECT_UNAUTHORIZED=0 turns TLS checks off'],
    [{ NODE_OPTIONS: '--require ./x.js' }, 'NODE_OPTIONS is set'],
  ])('S-8: refuses %j before reading anything', async (env, reason) => {
    const { code, fake, stderr, stdout } = await runRecorder(h, CONFIRM, { env });
    expect(code).toBe(2);
    expect(fake.calls).toEqual([]);
    expect(stderr).toEqual([`fragment-record: refused, ${reason}`]);
    expect(stdout).toEqual([`fragment-record: ${NO_TON_SENT}`]);
  });

  it('m2, N10: without --telegram-id it exits 2 before any request', async () => {
    for (const extra of [[], CONFIRM]) {
      const { code, fake, stderr } = await runRecorder(h, extra, { idArgs: [] });
      expect(code).toBe(2);
      expect(fake.calls).toEqual([]);
      expect(stderr[0]).toContain('--telegram-id is required');
    }
  });

  it.each([
    ['--out', (b: string) => ['--out', 'repo/raw', '--fixtures', path.join(b, 'staging')]],
    ['--fixtures', (b: string) => ['--out', path.join(b, 'raw'), '--fixtures', 'repo/staging']],
  ])('S-7: refuses %s inside a git repository', async (option, dirs) => {
    mkdirSync(path.join(h.base(), 'repo', '.git'), { recursive: true });
    const { code, fake, stderr } = await runRecorder(h, [], { dirs: dirs(h.base()) });
    expect(code).toBe(2);
    expect(fake.calls).toEqual([]);
    expect(stderr[0]).toContain(`${option} is inside a git repository`);
    expect(existsSync(path.join(h.base(), 'repo', 'staging'))).toBe(false);
  });

  it('refuses a staging folder inside --out, and the reverse', async () => {
    const nested = await runRecorder(h, [], {
      dirs: ['--out', h.rawDir(), '--fixtures', path.join(h.rawDir(), 'staging')],
    });
    expect(nested.code).toBe(2);
    expect(nested.stderr[0]).toContain('two separate folders');
    const same = await runRecorder(h, [], {
      dirs: ['--out', h.rawDir(), '--fixtures', h.rawDir()],
    });
    expect(same.code).toBe(2);
    expect(same.fake.calls).toEqual([]);
  });

  it.each(['raw', 'staging'])('refuses a non-empty %s folder', async (folder) => {
    mkdirSync(path.join(h.base(), folder));
    writeFileSync(path.join(h.base(), folder, 'old.json'), '{}');
    const { code, fake, stderr } = await runRecorder(h, []);
    expect(code).toBe(2);
    expect(fake.calls).toEqual([]);
    expect(stderr[0]).toContain('folder is not empty');
  });

  it('refuses a bad cookies file without echoing it', async () => {
    rmSync(path.join(h.base(), 'cookies.txt'));
    writeFileSync(path.join(h.base(), 'cookies.txt'), `stel_ssid ${FAKE.ssid}`);
    const { code, stderr } = await runRecorder(h, []);
    expect(code).toBe(2);
    expect(stderr.join('\n')).not.toContain(FAKE.ssid);
  });
});
