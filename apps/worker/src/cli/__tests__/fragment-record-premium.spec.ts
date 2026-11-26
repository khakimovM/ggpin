import { readdirSync } from 'node:fs';
import {
  BS,
  FAKE,
  FRAGMENT_PAY_ADDRESS,
  OWNER_WALLET_RAW,
} from '../../adapters/fragment/__tests__/fragment-fakes';
import {
  PREMIUM_PAY_ADDRESS,
  PREMIUM_REQ_ID,
  plainPremiumPayload,
  premiumLinkResponse,
} from '../../adapters/fragment/__tests__/premium-fakes';
import {
  FragmentRecorderClient,
  PURCHASE_PREP_METHODS,
  type RecorderApiMethod,
} from '../fragment-record-client';
import { NO_TON_SENT } from '../fragment-record-main';
import { fakeFragment, type FakeCall, type Override } from './fake-fragment';
import { CONFIRM, expectClean, runRecorder, useTempFolder } from './record-harness';

// P6-S0a: the Premium steps of `fragment:record` against the fake fragment.com. Money-free only:
// the gift page, the searches, and the gift request + link description behind
// --confirm-no-payment. No TON is signed or sent; no socket is opened.

const h = useTempFolder();
const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const html = (body: string): Response =>
  new Response(body, { headers: { 'content-type': 'text/html' } });
const method = (call: FakeCall): string | null => call.form?.get('method') ?? null;
const premiumPage =
  (body: string): Override =>
  (call) =>
    call.method === 'GET' && call.url.endsWith('/premium/gift') ? html(body) : null;
const summaryOf = (): Record<string, unknown> =>
  JSON.parse(h.staged('summary.json')) as Record<string, unknown>;

describe('P6-S0a: the Premium steps', () => {
  it('opens /premium/gift and asks for 3 months, from the gift page, with the refreshed jar', async () => {
    const { code, fake } = await runRecorder(h, CONFIRM);
    expect(code).toBe(0);
    const page = fake.calls.find((c) => c.method === 'GET' && c.url.endsWith('/premium/gift'));
    expect(page?.url).toBe('https://fragment.com/premium/gift');
    expect(page?.cookie).toContain(FAKE.refreshedSsid);
    const premium = fake.calls.filter((c) => /Premium/.test(method(c) ?? ''));
    expect(premium.map(method)).toEqual([
      'searchPremiumGiftRecipient',
      'initGiftPremiumRequest',
      'getGiftPremiumLink',
    ]);
    const [search, init, link] = premium;
    expect(Object.fromEntries(search?.form ?? [])).toEqual({
      query: FAKE.username,
      months: '3',
      method: 'searchPremiumGiftRecipient',
    });
    expect(Object.fromEntries(init?.form ?? [])).toEqual({
      recipient: FAKE.recipient,
      months: '3',
      method: 'initGiftPremiumRequest',
    });
    expect(Object.fromEntries(link?.form ?? [])).toEqual({
      id: PREMIUM_REQ_ID,
      transaction: '1',
      show_sender: '0',
      method: 'getGiftPremiumLink',
    });
    for (const call of premium) expect(call.referer).toBe('https://fragment.com/premium/gift');
    const stars = fake.calls.filter((c) => method(c) === 'searchStarsRecipient');
    expect(stars[0]?.referer).toBe('https://fragment.com/stars/buy');
  });

  it('stages the Premium link with the payload redacted and its pay address kept apart', async () => {
    await runRecorder(h, CONFIRM);
    const link = h.staged('get-gift-premium-link.json');
    expectClean(link, [FAKE.telegramId, OWNER_WALLET_RAW]);
    expect(link).toContain('"payload": "<REDACTED:payload>"');
    expect(link).toContain(PREMIUM_PAY_ADDRESS);
    expect(summaryOf()).toMatchObject({
      payAddresses: { stars: [FRAGMENT_PAY_ADDRESS], premium: [PREMIUM_PAY_ADDRESS] },
    });
    for (const file of ['page-premium-gift.json', 'search-premium-recipient.json']) {
      expectClean(h.staged(file), [FAKE.telegramId]);
    }
    expect(h.staged('init-gift-premium.json')).toContain('"months": 3');
  });

  it('redacts a payload that is not a BOC and names nobody (always, fail-closed)', async () => {
    const plain = plainPremiumPayload();
    const { code } = await runRecorder(h, CONFIRM, {
      override: (call) =>
        method(call) === 'getGiftPremiumLink' ? json(premiumLinkResponse(plain)) : null,
    });
    expect(code).toBe(0);
    const link = h.staged('get-gift-premium-link.json');
    expect(link).not.toContain(plain);
    expect(link).toContain('"payload": "<REDACTED:payload>"');
    expect(summaryOf()).toMatchObject({ linkPayloads: { premium: [{ bocMagic: false }] } });
  });

  it('without --confirm-no-payment: searches only, init and link never called', async () => {
    const { code, fake, stdout } = await runRecorder(h, []);
    expect(code).toBe(1);
    // Fix round rule (a): no --name covers the read found.name, so every file is strict (exit 1).
    expect(stdout.some((l) => l.includes('owner name not covered by --name; strict'))).toBe(true);
    expect(fake.apiMethods()).toEqual(['searchStarsRecipient', 'searchPremiumGiftRecipient']);
    expect(stdout).toContain(
      'fragment-record: init-gift-premium, get-gift-premium-link skipped: --confirm-no-payment not given',
    );
    expect(summaryOf()).toMatchObject({
      stoppedBy: null,
      skipped: [
        'init-buy-stars',
        'get-buy-stars-link',
        'search-premium-holder',
        'init-gift-premium',
        'get-gift-premium-link',
      ],
      payAddresses: { stars: [], premium: [] },
    });
    expect(stdout.at(-1)).toBe(`fragment-record: ${NO_TON_SENT}`);
  });

  it('a second Premium message stops the run (exit 1) and keeps no Premium address', async () => {
    const two = premiumLinkResponse();
    const tx = two['transaction'] as { messages: unknown[] };
    tx.messages.push({ address: PREMIUM_PAY_ADDRESS, amount: '1', payload: '' });
    const { code, stdout } = await runRecorder(h, CONFIRM, {
      override: (call) => (method(call) === 'getGiftPremiumLink' ? json(two) : null),
    });
    expect(code).toBe(1);
    expect(stdout).toContain(
      'fragment-record: stopped early: the premium link response does not hold exactly one message',
    );
    expect(summaryOf()).toMatchObject({ payAddresses: { premium: [] } });
  });

  it('no api hash on the gift page: Premium API skipped, the page withheld, Stars staged', async () => {
    const page = '<!DOCTYPE html><html><body><a class="js-logout">Log out</a></body></html>';
    const { code, fake, stdout } = await runRecorder(h, CONFIRM, { override: premiumPage(page) });
    expect(code).toBe(1);
    expect(fake.apiMethods()).toEqual([
      'searchStarsRecipient',
      'initBuyStarsRequest',
      'getBuyStarsLink',
    ]);
    expect(stdout).toContain('fragment-record: withheld: page-premium-gift.json (no api hash)');
    expect(readdirSync(h.stagingDir())).not.toContain('page-premium-gift.json');
    expect(readdirSync(h.stagingDir())).toContain('get-buy-stars-link.json');
    expect(summaryOf()).toMatchObject({ premiumApiHash: { found: false, sameAsStars: null } });
  });

  it('another api hash on the gift page is used there and redacted everywhere', async () => {
    const other = ['beef', '00be', 'ef00', 'cafe'].join('');
    const page = `<html><body><script>ajInit({"apiUrl":"${BS}/api?hash=${other}"});</script></body></html>`;
    const { fake } = await runRecorder(h, CONFIRM, { override: premiumPage(page) });
    const search = fake.calls.find((c) => method(c) === 'searchPremiumGiftRecipient');
    expect(new URL(search?.url ?? 'https://x.invalid').searchParams.get('hash')).toBe(other);
    expect(summaryOf()).toMatchObject({ premiumApiHash: { found: true, sameAsStars: false } });
    for (const file of readdirSync(h.stagingDir())) expectClean(h.staged(file), [other]);
  });
});

describe('P6-S0a: the client gate under the flow (--confirm-no-payment)', () => {
  it('refuses every purchase step without the confirmation, before any request', async () => {
    const fake = fakeFragment();
    const client = new FragmentRecorderClient(fake.fetch, null, 1000);
    expect([...PURCHASE_PREP_METHODS]).toEqual([
      'initBuyStarsRequest',
      'getBuyStarsLink',
      'initGiftPremiumRequest',
      'getGiftPremiumLink',
    ]);
    for (const m of PURCHASE_PREP_METHODS) {
      await expect(client.api(FAKE.hash, m, {})).rejects.toThrow('need --confirm-no-payment');
    }
    expect(fake.calls).toEqual([]);
    await client.api(FAKE.hash, 'searchPremiumGiftRecipient', { query: 'x', months: '3' });
    expect(fake.apiMethods()).toEqual(['searchPremiumGiftRecipient']);
  });

  it('allows them with the confirmation; updatePremiumState is never allowed', async () => {
    const fake = fakeFragment();
    const client = new FragmentRecorderClient(fake.fetch, null, 1000, true);
    await client.api(FAKE.hash, 'initGiftPremiumRequest', { recipient: 'r', months: '3' });
    const other = ['update', 'Premium', 'State'].join('');
    await expect(client.api(FAKE.hash, other as RecorderApiMethod, {})).rejects.toThrow(
      'method not allowed',
    );
    expect(fake.apiMethods()).toEqual(['initGiftPremiumRequest']);
  });
});
