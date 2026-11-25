import { createFixtureSanitizer, type SecretValue } from '../fixture-sanitizer';
import { createLeakCheck } from '../leak-check';
import { OWNER, PAY, ownerHash, secrets, type BypassCase } from './bypass-cases';
import { recoverable } from './recovery-oracle';

// Fix round 3: the final audit's probe cases (scratchpad s0b-final-audit) as regression tests.
// Leak cases must end up withheld or clean; the harmless page constructs of its false-positive
// probe must be staged, while a real secret in the same shape is still withheld (fail-closed).
// FA-KEEPRAW2 is left out on purpose: a caller handing in the owner's raw address as "keep"
// while not knowing the wallet is a library-only case; the recorder requires --wallet (R-4).

const ch = (code: number): string => String.fromCharCode(code);
const ELL = ch(0x2026);
const [ASCII, OKINA, TURNED, LEFT] = [ch(0x27), ch(0x2bb), ch(0x2bc), ch(0x2018)];
const gayrat = (apos: string): string => `G${apos}ayrat To${apos}lqinov`;
const hex = ownerHash.toString('hex');
const nameOnly = (value: string): SecretValue[] => [{ kind: 'name', value }];

const CASES: BypassCase[] = [
  {
    id: 'FA-APOS1 U+02BB name, page U+2018',
    text: `<b>${gayrat(LEFT)}</b>`,
    needle: 'lqinov',
    v: 'noName',
    extra: nameOnly(gayrat(OKINA)),
  },
  {
    id: 'FA-APOS2 ASCII name, page U+02BB',
    text: `<b>${gayrat(OKINA)}</b>`,
    needle: 'lqinov',
    v: 'noName',
    extra: nameOnly(gayrat(ASCII)),
  },
  {
    id: 'FA-APOS3 U+2018 name, page ASCII',
    text: `<b>${gayrat(ASCII)}</b>`,
    needle: 'lqinov',
    v: 'noName',
    extra: nameOnly(gayrat(LEFT)),
  },
  {
    id: 'FA-APOS4 U+02BC name, page backtick',
    text: `<b>${gayrat('`')}</b>`,
    needle: 'lqinov',
    v: 'noName',
    extra: nameOnly(gayrat(TURNED)),
  },
  { id: 'FA-PHONE4 unknown 90-123-45-67', text: '<span>90-123-45-67</span>', needle: '901234567' },
  {
    id: 'FA-PHONE5 known, shown 90-123-45-67',
    text: '<span>90-123-45-67</span>',
    needle: '901234567',
    extra: [{ kind: 'phone', value: '+998 90 123 45 67' }],
  },
  {
    id: 'FA-PHONE6 unknown bare 901234567 after tel',
    text: '<span>tel 901234567</span>',
    needle: '901234567',
  },
  {
    id: 'FA-PHONE7 known bare 901234567',
    text: '<span>tel 901234567</span>',
    needle: '901234567',
    extra: [{ kind: 'phone', value: '+998 90 123 45 67' }],
  },
  {
    id: 'FA-PART8 unknown first4 … last4 with spaces',
    text: `<div class="tm-wallet">${OWNER.slice(0, 4)} ${ELL} ${OWNER.slice(-4)}</div>`,
    needle: OWNER.slice(-4),
    v: 'noWallet',
  },
  {
    id: 'FA-PART9 known first4 … last4 with spaces',
    text: `<div class="tm-wallet">${OWNER.slice(0, 4)} ${ELL} ${OWNER.slice(-4)}</div>`,
    needle: OWNER.slice(-4),
  },
  {
    id: 'FA-PART10 unknown first6***last6',
    text: `<div class="tm-wallet">${OWNER.slice(0, 6)}***${OWNER.slice(-6)}</div>`,
    needle: OWNER.slice(-6),
    v: 'noWallet',
  },
  { id: 'FA-TGID-PFX u700100200', text: 'peer u700100200 x', needle: '700100200' },
  {
    id: 'FA-KEEPRAW1 keep = owner raw, wallet known',
    json: { messages: [{ address: `0:${hex}` }] },
    needle: hex,
    keep: [`0:${hex}`],
  },
  {
    id: 'FA-USER-SPACED spaced username',
    text: 'o w n e r _ t e s t _ a c c',
    needle: 'owner_test_acc',
  },
  {
    id: 'FA-NAME-UPPER-ENT upper-case hex entities',
    text: [...'OZODBEK'].map((c) => `&#x${(c.codePointAt(0) ?? 0).toString(16)};`).join(''),
    needle: 'Ozodbek',
  },
  {
    id: 'FA-HEX-UPPER unknown upper hex',
    json: { v: hex.toUpperCase() },
    needle: hex,
    v: 'noWallet',
  },
  { id: 'FA-HEX-0x unknown 0x hex', text: `acct 0x${hex} end`, needle: hex, v: 'noWallet' },
];

function verdictOf(c: BypassCase): 'withheld' | 'clean' | 'LEAK' {
  const sec = secrets(c.v ?? 'full', c.extra ?? []);
  const keep = c.keep ?? [PAY];
  const sanitizer = createFixtureSanitizer({ secrets: sec, keepAddresses: keep });
  const value = c.json ?? { response: { bodyKind: 'html-excerpt', body: c.text ?? '' } };
  const staged = `${JSON.stringify(sanitizer.sanitizeJson(value), null, 2)}\n`;
  if (createLeakCheck({ secrets: sec, keepAddresses: keep })(staged).length > 0) return 'withheld';
  return recoverable(staged, c.needle) ? 'LEAK' : 'clean';
}

describe('final audit leak cases (fix round 3)', () => {
  it.each(CASES.map((c) => [c.id, c] as const))('%s: withheld or clean', (_id, c) => {
    expect(['withheld', 'clean']).toContain(verdictOf(c));
  });

  it('F-3: a bare 9-digit number is a phone only after a phone word', () => {
    const sanitizer = createFixtureSanitizer({ secrets: [], keepAddresses: [PAY] });
    expect(sanitizer.sanitizeText('Tel: 901234567')).toBe('Tel: <REDACTED:phone>');
    expect(sanitizer.sanitizeJson({ amount: '901234567' })).toEqual({ amount: '901234567' });
  });
});

describe('final audit false positives (F-7)', () => {
  const harmless = [
    '<div style="background-image:url(&quot;data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27/%3E&quot;)"></div>',
    "<script>document.cookie='stel_dt='+encodeURIComponent(-(new Date).getTimezoneOffset()*60)+';path=/';</script>",
    "<script>if(document.cookie.indexOf('stel_ssid=')<0){}</script>",
    '<a href="/x?infohash=abcdef1234567">x</a>',
    '<p>Loading…</p><p>Please wait...</p>',
  ];
  const check = (text: string): string[] => {
    const sec = secrets('full');
    const sanitizer = createFixtureSanitizer({ secrets: sec, keepAddresses: [PAY] });
    const leak = createLeakCheck({ secrets: sec, keepAddresses: [PAY] });
    return leak(JSON.stringify(sanitizer.sanitizeJson({ response: { body: text } }), null, 2));
  };

  it.each(harmless)('stages %s', (text) => {
    expect(check(text)).toEqual([]);
  });

  it('still withholds the same shapes when they carry a secret (fail-closed)', () => {
    const leak = createLeakCheck({ secrets: [], keepAddresses: [PAY] });
    expect(leak('x stel_ssid=Zq3xV9mK2pL8 y')).toContain('cookie-pair');
    expect(leak('{"stel_token": "aaaabbbbcccc"}')).toContain('cookie-pair');
    expect(leak('/api?hash=abcdef1234567')).toContain('api-hash');
    expect(leak('<img src="data:image/png;base64,iVBORw0KGgo=">')).toContain('photo-url');
    expect(leak(`<i>${OWNER.slice(0, 4)} ${ELL} ${OWNER.slice(-4)}</i>`)).toContain(
      'short-address',
    );
  });
});
