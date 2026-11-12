import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  FAKE,
  FRAGMENT_PAY_ADDRESS,
  OWNER_WALLET_RAW,
} from '../../adapters/fragment/__tests__/fragment-fakes';
import { runRecordingFlow } from '../fragment-record-flow';
import { NO_TON_SENT } from '../fragment-record-main';
import { DEVICE, fakeFragment } from './fake-fragment';
import { CONFIRM, expectClean, runRecorder, useTempFolder } from './record-harness';

const h = useTempFolder();

describe('fragment-record: the full money-free flow', () => {
  it('calls fragment.com only, with the allowed methods, and refreshes cookies', async () => {
    const { code, fake } = await runRecorder(h, CONFIRM);
    expect(code).toBe(0);
    expect(fake.apiMethods()).toEqual([
      'searchStarsRecipient',
      'initBuyStarsRequest',
      'getBuyStarsLink',
    ]);
    for (const call of fake.calls) {
      expect(new URL(call.url).origin).toBe('https://fragment.com');
      expect(call.redirect).toBe('manual');
    }
    const [page, search, init, link, loggedOut] = fake.calls;
    expect(page?.cookie).toContain(FAKE.ssid);
    expect(search?.form?.get('query')).toBe(FAKE.username);
    expect(init?.cookie).toContain(FAKE.refreshedSsid);
    expect(init?.cookie).not.toContain(FAKE.ssid);
    expect(init?.form?.get('recipient')).toBe(FAKE.recipient);
    expect(init?.form?.get('quantity')).toBe('50');
    expect(link?.form?.get('id')).toBe(FAKE.reqId);
    expect(link?.form?.get('transaction')).toBe('1');
    expect(loggedOut?.method).toBe('GET');
    expect(loggedOut?.cookie).toBeNull();
  });

  it('writes raw responses only to --out and clean copies only to the staging folder', async () => {
    await runRecorder(h, CONFIRM);
    const raw = readdirSync(h.rawDir()).sort();
    expect(raw).toEqual([
      '01-page-logged-in.json',
      '02-search-stars-recipient.json',
      '03-init-buy-stars.json',
      '04-get-buy-stars-link.json',
      '05-page-logged-out.json',
    ]);
    expect(readFileSync(path.join(h.rawDir(), raw[1] ?? ''), 'utf8')).toContain(FAKE.recipient);
    const staged = readdirSync(h.stagingDir()).sort();
    expect(staged).toEqual([
      'get-buy-stars-link.json',
      'init-buy-stars.json',
      'page-logged-in.json',
      'page-logged-out.json',
      'search-stars-recipient.json',
      'summary.json',
    ]);
    for (const name of staged) expectClean(h.staged(name), [FAKE.telegramId]);
    expect(h.staged('get-buy-stars-link.json')).toContain(FRAGMENT_PAY_ADDRESS);
    const summary = JSON.parse(h.staged('summary.json')) as Record<string, unknown>;
    expect(summary).toMatchObject({
      format: 3,
      tonSent: false,
      stoppedBy: null,
      payAddresses: [FRAGMENT_PAY_ADDRESS],
      apiHash: { found: true, length: FAKE.hash.length },
      pageMarkers: {
        loggedIn: { tgAccountMenu: true, loginButton: false },
        loggedOut: { tgAccountMenu: false, loginButton: true },
      },
      cookieNamesSupplied: ['stel_dt', 'stel_ssid', 'stel_token', 'stel_ton_token'],
      setCookieNames: ['stel_ssid'],
      linkPayloads: [{ bocMagic: true }],
    });
  });

  it('stages an html excerpt (title, apiUrl line, markers), never the whole page', async () => {
    await runRecorder(h, CONFIRM);
    const page = JSON.parse(h.staged('page-logged-in.json')) as {
      response: { bodyKind: string; body: Record<string, unknown> };
    };
    expect(page.response.bodyKind).toBe('html-excerpt');
    expect(page.response.body).toMatchObject({ pageTitle: 'Fragment' });
    expect(String(page.response.body['apiLine'])).toContain('<REDACTED:hash>');
    expect(Object.keys(page.response.body).sort()).toEqual([
      'apiLine',
      'length',
      'markers',
      'pageTitle',
      'snippets',
    ]);
  });

  it('prints only folder names, step names, statuses and file names', async () => {
    const { stdout, stderr } = await runRecorder(h, CONFIRM);
    expect(stderr).toEqual([]);
    for (const line of stdout) {
      expectClean(line, [FAKE.telegramId, h.base()]);
      expect(line).toMatch(/^fragment-record: /);
    }
    expect(stdout).toContain('fragment-record: raw folder: raw');
    expect(stdout).toContain('fragment-record: staging folder: staging');
    expect(stdout).toContain(
      'fragment-record: page-logged-in HTTP 200 -> raw 01-page-logged-in.json',
    );
    expect(stdout).toContain('fragment-record: staged -> summary.json');
    expect(stdout.at(-1)).toBe(`fragment-record: ${NO_TON_SENT}`);
  });

  it('without --confirm-no-payment it only searches, and never prepares a purchase', async () => {
    const { code, fake, stdout } = await runRecorder(h, []);
    expect(code).toBe(0);
    expect(fake.apiMethods()).toEqual(['searchStarsRecipient']);
    expect(readdirSync(h.stagingDir())).not.toContain('init-buy-stars.json');
    expect(stdout.at(-1)).toBe(`fragment-record: ${NO_TON_SENT}`);
  });

  it('--recipient-age-check waits 10 minutes and re-runs init with the same recipient', async () => {
    const { code, fake, sleeps } = await runRecorder(h, [...CONFIRM, '--recipient-age-check']);
    expect(code).toBe(0);
    expect(sleeps).toEqual([600_000]);
    const inits = fake.calls.filter((c) => c.form?.get('method') === 'initBuyStarsRequest');
    expect(inits.map((c) => c.form?.get('recipient'))).toEqual([FAKE.recipient, FAKE.recipient]);
    expect(readdirSync(h.stagingDir())).toContain('init-buy-stars-after-10min.json');
  });

  it('n2: the age check never runs without the no-payment confirmation', async () => {
    const fake = fakeFragment();
    const sleeps: number[] = [];
    await runRecordingFlow(
      {
        cookies: new Map([['stel_ssid', FAKE.ssid]]),
        username: FAKE.username,
        confirmNoPayment: false,
        recipientAgeCheck: true,
        tonConnect: null,
      },
      {
        fetch: fake.fetch,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
        note: () => undefined,
        onExchange: () => Promise.resolve(),
      },
    );
    expect(sleeps).toEqual([]);
    expect(fake.apiMethods()).toEqual(['searchStarsRecipient']);
  });

  it('sends the TON Connect account from --ton-connect and redacts the owner wallet', async () => {
    const account = {
      address: OWNER_WALLET_RAW,
      chain: '-239',
      publicKey: 'fakepublickey0000aaaa',
    };
    writeFileSync(path.join(h.base(), 'tc.json'), JSON.stringify({ account, device: DEVICE }));
    const { code, fake } = await runRecorder(h, [...CONFIRM, '--ton-connect', 'tc.json']);
    expect(code).toBe(0);
    const link = fake.calls.find((c) => c.form?.get('method') === 'getBuyStarsLink');
    expect(JSON.parse(link?.form?.get('account') ?? '{}')).toEqual(account);
    expect(JSON.parse(link?.form?.get('device') ?? '{}')).toEqual(DEVICE);
    const text = h.staged('get-buy-stars-link.json');
    expect(text).toContain('"account": "<REDACTED:wallet>"');
    expect(text).not.toContain('fakepublickey0000aaaa');
    expectClean(text);
  });
});
