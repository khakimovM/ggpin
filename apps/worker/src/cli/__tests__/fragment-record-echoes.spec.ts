import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  BS,
  FAKE,
  FRAGMENT_PAY_ADDRESS,
  OWNER_WALLET,
  STRANGER_WALLET,
  initResponse,
} from '../../adapters/fragment/__tests__/fragment-fakes';
import { recoverable } from '../../adapters/fragment/__tests__/recovery-oracle';
import { CONFIRM, expectClean, runRecorder, useTempFolder, type Harness } from './record-harness';
import type { Override } from './fake-fragment';

// Fix round 2 (R-1, R-2, R-4, R-7, R-9, R-11, N4) through the whole CLI against the fake
// fragment.com: what an answer echoes back must be redacted (exit 0) or withheld (exit 1).

const h = useTempFolder();
const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const html = (body: string): Response =>
  new Response(body, { headers: { 'content-type': 'text/html' } });
const pad = (n: number): string => 'x'.repeat(Math.max(0, n));
const isApi =
  (method: string): ((form: URLSearchParams | null) => boolean) =>
  (form) =>
    form?.get('method') === method;
const onInit =
  (body: unknown): Override =>
  (call) =>
    isApi('initBuyStarsRequest')(call.form) ? json(body) : null;

/** A logged-in page whose `marker` snippet window (match + 120) ends `keep` chars into `secret`. */
function cutPage(marker: string, secret: string, keep: number): string {
  const prefix = `<!DOCTYPE html><html><body>${pad(100)}<div class="${marker}">`;
  const fill = prefix.indexOf(marker) + 120 - keep - prefix.length;
  const api = `<script>ajInit({"apiUrl":"${BS}/api?hash=${FAKE.hash}"});</script>`;
  return `${prefix}${pad(fill)}${secret} tail</div>${pad(400)}${api}</body></html>`;
}
const pageOverride =
  (page: string): Override =>
  (call) =>
    call.method === 'GET' && call.cookie !== null ? html(page) : null;

function expectNotRecoverable(harness: Harness, needles: string[]): void {
  for (const file of readdirSync(harness.stagingDir())) {
    const text = harness.staged(file);
    for (const needle of needles) {
      expect({ file, needle, found: recoverable(text, needle) }).toEqual({
        file,
        needle,
        found: false,
      });
    }
  }
}

describe('R-1, N1: the page is sanitized whole, then cut', () => {
  it.each([
    ['username cut after 11 chars', 'tm-menu-tg-account', `@${FAKE.username}`, 11, 'owner_test'],
    ['wallet cut at 30 chars', 'tm-wallet', OWNER_WALLET, 30, OWNER_WALLET.slice(0, 30)],
    [
      'tg://user?id= cut at 7 digits',
      'tm-menu-tg-account',
      `tg://user?id=${FAKE.telegramId}`,
      20,
      '7001002',
    ],
  ])('%s at the window edge never reaches staging', async (_l, marker, secret, keep, needle) => {
    const { code } = await runRecorder(h, CONFIRM, {
      override: pageOverride(cutPage(marker, secret, keep)),
    });
    expect(code).toBe(0);
    expectNotRecoverable(h, [needle]);
  });

  it('a username across the 2000-char cut of a text answer is redacted first', async () => {
    const text = `${pad(1989)}@${FAKE.username} more`;
    const { code } = await runRecorder(h, CONFIRM, {
      override: (call) =>
        isApi('initBuyStarsRequest')(call.form)
          ? new Response(text, { headers: { 'content-type': 'text/plain' } })
          : null,
    });
    expect(code).toBe(0);
    expectNotRecoverable(h, ['owner_test']);
  });
});

describe('R-2: names', () => {
  it('an unknown name under an unguessed class is redacted when given with --name', async () => {
    const page = cutPage('tm-menu-tg-account', '<div class="peer">Zarina Karimova</div>', 10);
    const { code } = await runRecorder(h, [...CONFIRM, '--name', 'Zarina Karimova'], {
      override: (call) =>
        pageOverride(page)(call) ??
        (isApi('searchStarsRecipient')(call.form)
          ? json({ ok: true, found: { recipient: FAKE.recipient, title: 'Zarina Karimova' } })
          : null),
    });
    expect(code).toBe(0);
    expectNotRecoverable(h, ['Zarina', 'Karimova']);
  });

  it('with no name known at the end, nothing is staged and it exits 1', async () => {
    const page = cutPage('tm-menu-tg-account', 'nobody', 3);
    const { code, stdout } = await runRecorder(h, [], {
      override: (call) =>
        pageOverride(page)(call) ??
        (isApi('searchStarsRecipient')(call.form)
          ? json({ ok: true, found: { recipient: FAKE.recipient } })
          : null),
    });
    expect(code).toBe(1);
    expect(stdout).toContain(
      'fragment-record: nothing staged: no display name is known (give --name)',
    );
    expect(existsSync(h.stagingDir()) ? readdirSync(h.stagingDir()) : []).toEqual([]);
  });
});

describe('R-4: the link must hold exactly one message', () => {
  it('a second message stops the run (exit 1) and keeps no address', async () => {
    const messages = [
      { address: FRAGMENT_PAY_ADDRESS, amount: '1' },
      { address: STRANGER_WALLET, amount: '1' },
    ];
    const { code, stdout } = await runRecorder(h, CONFIRM, {
      override: (call) =>
        isApi('getBuyStarsLink')(call.form)
          ? json({ ok: true, transaction: { validUntil: 1, messages } })
          : null,
    });
    expect(code).toBe(1);
    expect(stdout).toContain(
      'fragment-record: stopped early: the link response does not hold exactly one message',
    );
    for (const file of readdirSync(h.stagingDir()))
      expectClean(h.staged(file), [FRAGMENT_PAY_ADDRESS]);
  });
});

describe('R-7, R-9, N4: hex, phones and decoded cookies', () => {
  it('R-7: long hex outside the kept address is always a token', async () => {
    const hex64 = 'c3'.repeat(32);
    const hex40 = '9f'.repeat(20);
    const { code } = await runRecorder(h, CONFIRM, {
      override: onInit({ ...initResponse(), account_id: hex64, note: `ref ${hex40}` }),
    });
    expect(code).toBe(0);
    const staged = h.staged('init-buy-stars.json');
    expect(staged).not.toContain(hex64);
    expect(staged).not.toContain(hex40);
    expect(staged).toContain('"note": "ref <REDACTED:token>"');
  });

  it('R-9: phones from --phone and --redact match whatever the separators', async () => {
    writeFileSync(path.join(h.base(), 'redact.txt'), '998 90 765 43 21\n');
    const args = [...CONFIRM, '--phone', '8 (916) 123-45-67', '--redact', 'redact.txt'];
    const { code } = await runRecorder(h, args, {
      override: onInit({ ...initResponse(), a: 'tel 9161234567', b: 'tel 90-765-43-21' }),
    });
    expect(code).toBe(0);
    const staged = h.staged('init-buy-stars.json');
    expect(staged).toContain('"a": "tel <REDACTED:phone>"');
    expect(staged).toContain('"b": "tel <REDACTED:phone>"');
  });

  it('N4: a cookie echoed URL-decoded is redacted', async () => {
    const encoded = `fakeTon%2Fslash${'9999'}zzzz`;
    writeFileSync(
      path.join(h.base(), 'cookies.txt'),
      `stel_ssid=${FAKE.ssid}\nstel_ton_token=${encoded}\n`,
    );
    const { code } = await runRecorder(h, CONFIRM, {
      override: onInit({ ...initResponse(), note: `t ${decodeURIComponent(encoded)}` }),
    });
    expect(code).toBe(0);
    const staged = h.staged('init-buy-stars.json');
    expect(staged).toContain('"note": "t <REDACTED:cookie>"');
    expect(staged).not.toContain('slash9999');
  });
});

describe('R-11, N8: proxies, certificates and debug output', () => {
  it.each([
    'HTTPS_PROXY',
    'https_proxy',
    'NODE_EXTRA_CA_CERTS',
    'NODE_DEBUG',
    'NODE_USE_ENV_PROXY',
  ])('refuses %s before reading anything', async (key) => {
    const { code, fake, stderr } = await runRecorder(h, CONFIRM, {
      env: { NODE_ENV: 'development', [key]: 'x' },
    });
    expect(code).toBe(2);
    expect(fake.calls).toEqual([]);
    expect(stderr).toEqual([`fragment-record: refused, ${key} is set`]);
  });
});
