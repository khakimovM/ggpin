import { existsSync, readdirSync } from 'node:fs';
import {
  FAKE,
  OWNER_WALLET,
  STRANGER_WALLET,
  form,
  initResponse,
  searchResponse,
} from '../../adapters/fragment/__tests__/fragment-fakes';
import { CONFIRM, runRecorder, useTempFolder } from './record-harness';
import type { Override } from './fake-fragment';

// Fix round 3 through the whole CLI: a --name no answer shows (F-5), the name known only from
// the search answer (F-11), the npm warning (F-1), NODE_USE_SYSTEM_CA (F-8) and the KEEP1 guard.

const h = useTempFolder();
const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const isApi =
  (method: string) =>
  (form: URLSearchParams | null): boolean =>
    form?.get('method') === method;
const staging = (): string[] => (existsSync(h.stagingDir()) ? readdirSync(h.stagingDir()) : []);

describe('F-5: a --name that no answer shows', () => {
  it('stages nothing, exits 1 and never prints the name', async () => {
    const args = [
      '--phone',
      FAKE.phone,
      '--confirm-no-payment',
      '--wallet',
      OWNER_WALLET,
      '--name',
      'Rustam Aliyev',
    ];
    const { code, stdout, stderr } = await runRecorder(h, args);
    expect(code).toBe(1);
    expect(stdout).toContain(
      'fragment-record: nothing staged: name not found in responses (check --name)',
    );
    expect(staging()).toEqual([]);
    for (const line of [...stdout, ...stderr]) {
      expect(line).not.toMatch(/Rustam|Aliyev/);
    }
  });

  it('accepts a --name spelled with another apostrophe than the page (F-2)', async () => {
    const page = (call: Parameters<Override>[0]): Response | null =>
      call.method === 'GET' && call.cookie !== null
        ? new Response(
            `<b>G${String.fromCharCode(0x2018)}ayrat To${String.fromCharCode(0x2019)}lqinov</b>`,
            {
              headers: { 'content-type': 'text/html' },
            },
          )
        : null;
    const name = `G${String.fromCharCode(0x2bb)}ayrat To${String.fromCharCode(0x2bb)}lqinov`;
    const args = [...CONFIRM.slice(0, -2), '--name', name];
    const { stdout } = await runRecorder(h, args, { override: page });
    expect(stdout.some((l) => l.includes('nothing staged'))).toBe(false);
  });
});

describe('F-11: the name known only from the search answer', () => {
  it('redacts it where a later answer echoes it', async () => {
    const override: Override = (call) => {
      if (isApi('searchStarsRecipient')(call.form)) {
        return json({
          ...searchResponse(),
          found: { recipient: FAKE.recipient, name: 'Zarina Karimova' },
        });
      }
      return isApi('initBuyStarsRequest')(call.form)
        ? json({ ...initResponse(), note: 'for Zarina Karimova' })
        : null;
    };
    const { code } = await runRecorder(h, CONFIRM, { override });
    expect(code).toBe(0);
    const staged = h.staged('init-buy-stars.json');
    expect(staged).toContain('"note": "for <REDACTED:name>"');
    expect(staged).not.toMatch(/Zarina|Karimova/);
  });
});

describe('F-1, F-8: environment', () => {
  it('F-1: warns, without values, when npm started the tool', async () => {
    const { stderr } = await runRecorder(h, [], {
      env: { NODE_ENV: 'development', npm_lifecycle_event: 'fragment:record' },
    });
    expect(stderr[0]).toBe(
      'fragment-record: warning, started through npm: npm may print this command line and keep ' +
        'it in its log; run node apps/worker/dist/cli/fragment-record.js instead',
    );
    expect(stderr.join('\n')).not.toContain(FAKE.username);
  });

  it('F-8: refuses NODE_USE_SYSTEM_CA before any request', async () => {
    const { code, fake, stderr } = await runRecorder(h, CONFIRM, {
      env: { NODE_ENV: 'development', NODE_USE_SYSTEM_CA: '1' },
    });
    expect(code).toBe(2);
    expect(fake.calls).toEqual([]);
    expect(stderr).toEqual(['fragment-record: refused, NODE_USE_SYSTEM_CA is set']);
  });
});

describe('KEEP1 guard: the link names the sending wallet', () => {
  it('never keeps a pay-to that is the link’s own `from` wallet, even with a wrong --wallet', async () => {
    const ownerEq = form(0x07, 'bounceable');
    const args = [...CONFIRM.slice(0, 3), '--wallet', STRANGER_WALLET, ...CONFIRM.slice(5)];
    const override: Override = (call) =>
      isApi('getBuyStarsLink')(call.form)
        ? json({
            ok: true,
            transaction: {
              validUntil: 1,
              from: form(0x07, 'raw'),
              messages: [{ address: ownerEq, amount: '1' }],
            },
          })
        : null;
    const { code } = await runRecorder(h, args, { override });
    expect(code).toBe(0);
    expect(h.staged('get-buy-stars-link.json')).not.toContain(ownerEq);
    expect(h.staged('summary.json')).not.toContain(ownerEq);
  });
});
