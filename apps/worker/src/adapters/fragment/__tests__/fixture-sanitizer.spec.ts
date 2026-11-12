import { createFixtureSanitizer } from '../fixture-sanitizer';
import { pageExcerpt } from '../fragment-page';
import { createLeakCheck } from '../leak-check';
import { parseTonAddress, tonAddressForms } from '../ton-address-forms';
import {
  FAKE,
  FAKE_SECRETS as SECRETS,
  FRAGMENT_PAY_ADDRESS,
  OWNER_WALLET,
  OWNER_WALLET_NON_BOUNCEABLE,
  OWNER_WALLET_RAW,
  STRANGER_WALLET,
  allSecretForms,
  cookieLine,
  initResponse,
  linkResponse,
  loggedInPage,
  plainBase64,
  searchResponse,
} from './fragment-fakes';

const KEEP = [FRAGMENT_PAY_ADDRESS];
const sanitizer = createFixtureSanitizer({ secrets: SECRETS, keepAddresses: KEEP });
const leakCheck = createLeakCheck({ secrets: SECRETS, keepAddresses: KEEP });

function recorded(): Record<string, unknown> {
  return {
    step: 'all',
    request: {
      path: `/api?hash=${FAKE.hash}`,
      form: { query: FAKE.username, recipient: FAKE.recipient, quantity: '50' },
      cookie: cookieLine(),
    },
    search: searchResponse(),
    init: initResponse(),
    link: linkResponse(),
    page: loggedInPage(),
    excerpt: pageExcerpt(loggedInPage()),
    stranger: { address: STRANGER_WALLET, note: `sent to ${STRANGER_WALLET}` },
    profile: { user_id: Number(FAKE.telegramId), phone: FAKE.phone, verified: true, items: [] },
  };
}

/** The shape of a JSON value: same keys, same value types, same array lengths. */
function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shape);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v)]));
  }
  return value === null ? 'null' : typeof value;
}

function expectNoSecrets(text: string): void {
  const lower = text.toLowerCase();
  for (const secret of allSecretForms()) {
    expect({ leaked: lower.includes(secret.toLowerCase()), secret }).toEqual({
      leaked: false,
      secret,
    });
  }
}

describe('fixture sanitizer', () => {
  it('leaves no secret value in any form and passes the independent leak check', () => {
    const text = `${JSON.stringify(sanitizer.sanitizeJson(recorded()), null, 2)}\n`;
    expectNoSecrets(text);
    expect(text).not.toContain(OWNER_WALLET_RAW);
    expect(text).not.toContain(OWNER_WALLET_NON_BOUNCEABLE);
    expect(text).not.toMatch(/stel_[a-z_]+=(?!<REDACTED)/);
    expect(leakCheck(text)).toEqual([]);
  });

  it('is idempotent', () => {
    const once = sanitizer.sanitizeJson(recorded());
    expect(sanitizer.sanitizeJson(once)).toEqual(once);
    const page = sanitizer.sanitizeText(loggedInPage());
    expect(sanitizer.sanitizeText(page)).toBe(page);
  });

  it('keeps the structure, the keys and the value types', () => {
    const input = recorded();
    expect(shape(sanitizer.sanitizeJson(input))).toEqual(shape(input));
  });

  it('keeps Fragment’s pay address and the non-secret values', () => {
    const out = sanitizer.sanitizeJson(recorded()) as {
      link: { transaction: { messages: Array<{ address: string; amount: string }> } };
      init: Record<string, unknown>;
      search: { found: Record<string, unknown> };
      profile: Record<string, unknown>;
    };
    expect(out.link.transaction.messages[0]).toMatchObject({
      address: FRAGMENT_PAY_ADDRESS,
      amount: '251200000',
    });
    expect(out.init).toEqual(initResponse());
    expect(out.search.found).toEqual({
      myself: true,
      recipient: '<REDACTED:recipient>',
      name: '<REDACTED:name>',
      photo: '<REDACTED:photo>',
    });
    expect(out.profile).toEqual({
      user_id: 0,
      phone: '<REDACTED:phone>',
      verified: true,
      items: [],
    });
  });

  it('redacts a BOC payload (fail-closed), a long random value (S-6), keeps short base64', () => {
    const withName = sanitizer.sanitizeJson(linkResponse()) as {
      transaction: { messages: Array<{ payload: string }> };
    };
    expect(withName.transaction.messages[0]?.payload).toBe('<REDACTED:payload>');
    const clean = plainBase64();
    const without = sanitizer.sanitizeJson(linkResponse(clean)) as {
      transaction: { messages: Array<{ payload: string }> };
    };
    expect(without.transaction.messages[0]?.payload).toBe(clean);
    const random = Buffer.from('just an ordinary note with no secret inside at all').toString(
      'base64',
    );
    expect(sanitizer.sanitizeJson({ payload: random })).toEqual({ payload: '<REDACTED:token>' });
  });

  it('cleans an HTML page (Cyrillic, emoji, &amp; names) and keeps its markup', () => {
    const page = sanitizer.sanitizeText(loggedInPage());
    expectNoSecrets(page);
    expect(page).toContain('/api?hash=<REDACTED:hash>');
    expect(page).toContain('class="tm-menu-tg-account-name"><REDACTED:name></div>');
    expect(page).toContain('<img src="<REDACTED:photo-url>">');
    expect(page).toContain('"uid":0');
    expect(page).toContain('stel_dt=<REDACTED:cookie>');
    expect(page).toContain('"stel_token":"<REDACTED:cookie>"');
    expect(page).toContain('<a class="js-logout" href="#">Log out</a>');
    expect(page).toContain('https://tonviewer.com/<REDACTED:address>');
    expect(leakCheck(page)).toEqual([]);
  });

  it('cleans an unknown page with only pattern rules (no known secrets)', () => {
    const blind = createFixtureSanitizer({ secrets: [], keepAddresses: [] });
    const page = blind.sanitizeText(loggedInPage());
    for (const value of [FAKE.hash, FAKE.token, FAKE.telegramId, FAKE.phone, 'telesco.pe']) {
      expect(page).not.toContain(value);
    }
    expect(page).not.toContain(OWNER_WALLET_NON_BOUNCEABLE);
  });

  it('does not damage text around short cookie values', () => {
    const out = sanitizer.sanitizeText('offset -300 minutes; stel_dt=-300');
    expect(out).toBe('offset -300 minutes; stel_dt=<REDACTED:cookie>');
  });

  it('splits only on known placeholder kinds (audit P)', () => {
    const out = sanitizer.sanitizeText(`<REDACTED:${FAKE.username}> <REDACTED:name>`);
    expect(out).not.toContain(FAKE.username);
    expect(out).toContain('<REDACTED:name>');
  });
});

describe('page excerpt (html pages are never staged whole)', () => {
  it('keeps the title, the apiUrl line and the markers only', () => {
    const excerpt = pageExcerpt(loggedInPage());
    expect(excerpt.pageTitle).toBe('Fragment');
    expect(excerpt.markers).toMatchObject({
      apiHash: true,
      tgAccountMenu: true,
      logoutAction: true,
    });
    expect(excerpt.apiLine).toContain('/api?hash=');
    const text = JSON.stringify(excerpt);
    expect(text.length).toBeLessThan(loggedInPage().length * 2);
    const staged = JSON.stringify(sanitizer.sanitizeJson(excerpt));
    expectNoSecrets(staged);
    expect(leakCheck(staged)).toEqual([]);
  });
});

describe('TON address forms', () => {
  it('parses every form back to the same account and rejects a bad checksum', () => {
    const id = parseTonAddress(OWNER_WALLET);
    expect(id).not.toBeNull();
    if (id === null) return;
    const forms = tonAddressForms(id);
    expect(forms.length).toBeGreaterThanOrEqual(5);
    for (const f of forms) expect(parseTonAddress(f)?.hash.equals(id.hash)).toBe(true);
    const broken = `${OWNER_WALLET.slice(0, -1)}${OWNER_WALLET.endsWith('A') ? 'B' : 'A'}`;
    expect(parseTonAddress(broken)).toBeNull();
    expect(parseTonAddress('not an address')).toBeNull();
  });
});
