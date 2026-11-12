import { readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  FAKE,
  OWNER_WALLET,
  STRANGER_WALLET,
  initResponse,
} from '../../adapters/fragment/__tests__/fragment-fakes';
import { CONFIRM, runRecorder, useTempFolder } from './record-harness';
import type { Override } from './fake-fragment';

// N2 (fix round 2): one test per secret source. Each secret is known ONLY through that one path
// and is echoed in a form no pattern rule catches, so the test fails when that path stops
// feeding the sanitizer and the leak check (the reviewer's mutants redirCookie, tgArg, walletArg
// and tonConnectSecrets must be killed by these tests).

const h = useTempFolder();
const json = (body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', ...headers },
  });
const method = (call: { form: URLSearchParams | null }): string | null =>
  call.form?.get('method') ?? null;
const onInit =
  (body: unknown): Override =>
  (call) =>
    method(call) === 'initBuyStarsRequest' ? json(body) : null;
const stagedText = (): string =>
  readdirSync(h.stagingDir())
    .map((f) => h.staged(f))
    .join('\n');

describe('N2: every secret source is used on its own', () => {
  it('redirCookie: a Set-Cookie seen only on a redirect is redacted where echoed', async () => {
    const onlyOnRedirect = `fakeredir${'only'}8888abab`;
    const { code } = await runRecorder(h, CONFIRM, {
      override: (call) => {
        if (call.method === 'GET' && call.cookie !== null && call.url.endsWith('/stars/buy')) {
          return new Response(null, {
            status: 302,
            headers: [
              ['location', '/stars'],
              ['set-cookie', `stel_ssid=${onlyOnRedirect}; path=/; secure`],
            ],
          });
        }
        // No Set-Cookie anywhere else: the redirect is the only source of the value.
        if (method(call) === 'searchStarsRecipient') {
          return json({ ok: true, found: { recipient: FAKE.recipient, name: FAKE.displayName } });
        }
        return onInit({ ...initResponse(), note: `ssid ${onlyOnRedirect}` })(call);
      },
    });
    expect(code).toBe(0);
    expect(h.staged('init-buy-stars.json')).toContain('"note": "ssid <REDACTED:cookie>"');
    expect(stagedText()).not.toContain(onlyOnRedirect);
  });

  it('tgArg: the id known only from --telegram-id is redacted where echoed', async () => {
    const { code } = await runRecorder(h, CONFIRM, {
      override: onInit({ ...initResponse(), note: `peer ${FAKE.telegramId}` }),
    });
    expect(code).toBe(0);
    expect(h.staged('init-buy-stars.json')).toContain('"note": "peer <REDACTED:tg_id>"');
    expect(stagedText()).not.toContain(FAKE.telegramId);
  });

  it('walletArg: a wallet tail known only from --wallet is withheld', async () => {
    const tail = OWNER_WALLET.slice(-8);
    const { code, stdout } = await runRecorder(h, CONFIRM, {
      override: onInit({ ...initResponse(), tail: `wallet …${tail}` }),
    });
    expect(code).toBe(1);
    expect(stdout).toContain(
      'fragment-record: withheld: init-buy-stars.json (leak check: address)',
    );
    expect(stagedText()).not.toContain(tail);
  });

  it('tonConnectSecrets: the TON Connect address alone (other --wallet) is withheld', async () => {
    writeFileSync(
      path.join(h.base(), 'tc.json'),
      JSON.stringify({ account: { address: OWNER_WALLET } }),
    );
    const args = [
      '--confirm-no-payment',
      '--wallet',
      STRANGER_WALLET,
      '--name',
      FAKE.displayName,
      '--ton-connect',
      'tc.json',
      '--phone',
      FAKE.phone,
    ];
    const tail = OWNER_WALLET.slice(-8);
    const { code, stdout } = await runRecorder(h, args, {
      override: onInit({ ...initResponse(), tail: `wallet …${tail}` }),
    });
    expect(code).toBe(1);
    expect(stdout).toContain(
      'fragment-record: withheld: init-buy-stars.json (leak check: address)',
    );
    expect(stagedText()).not.toContain(tail);
  });
});
