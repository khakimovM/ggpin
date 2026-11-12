import { createFixtureSanitizer, type SecretValue } from '../fixture-sanitizer';
import { createLeakCheck } from '../leak-check';
import { recoverable } from './recovery-oracle';

// Round 4 (L-2, L-3): a short Uzbek first name with an apostrophe shown alone, and phone numbers
// in shapes the recorder was not told about. Each must be withheld or clean. Ids and amounts
// that look like a 9-digit number must stay as they are.

const ch = (c: number): string => String.fromCharCode(c);
const BASE: SecretValue[] = [
  { kind: 'cookie', value: ['fake', 'ssid', '0000aaaa1111bbbb'].join('') },
  { kind: 'username', value: 'owner_test_acc' },
  { kind: 'tg_id', value: '700100200' },
];

function verdict(secrets: SecretValue[], page: string, needle: string): string {
  const s = createFixtureSanitizer({ secrets, keepAddresses: [] });
  const leak = createLeakCheck({ secrets, keepAddresses: [] });
  const full = s.sanitizeText(page);
  const staged = `${JSON.stringify(s.sanitizeJson({ response: { body: full } }), null, 2)}\n`;
  if ([...leak(staged), ...leak(full)].length > 0) return 'withheld';
  return recoverable(staged, needle) ? 'LEAK' : 'clean';
}

describe('L-2: a short first name with an apostrophe, shown alone', () => {
  const marks: Array<[string, string]> = [
    ['U+02BB', ch(0x2bb)],
    ['U+2018', ch(0x2018)],
    ['ASCII', ch(0x27)],
  ];
  const cases: Array<[string, string, string]> = [];
  for (const first of ['Ro*zi', 'Bo*ri', 'To*ra', 'So*fi', 'Do*st']) {
    for (const [label, mark] of marks) {
      const shown = first.replace('*', mark);
      cases.push([`${shown} (${label})`, `${shown} Karimov`, shown]);
    }
  }
  it.each(cases)('%s: --name is the full name only', (_id, name, shown) => {
    const secrets = [...BASE, { kind: 'name' as const, value: name }];
    const page = `<div class="tm-popup-title">${shown}</div>`;
    expect(['withheld', 'clean']).toContain(verdict(secrets, page, shown));
  });

  it.each([
    ['U+02B9 prime', ch(0x2b9)],
    ['U+A78C saltillo', ch(0xa78c)],
  ])('the page spells the apostrophe as %s', (_id, mark) => {
    const secrets = [
      ...BASE,
      { kind: 'name' as const, value: `G${ch(0x2bb)}ayrat To${ch(0x2bb)}lqinov` },
    ];
    const first = `<div class="x">Ro${mark}zi</div>`;
    const named = [...BASE, { kind: 'name' as const, value: `Ro${ch(0x2bb)}zi Karimov` }];
    expect(['withheld', 'clean']).toContain(verdict(named, first, `Ro${mark}zi`));
    const full = `<div class="x">G${mark}ayrat To${mark}lqinov</div>`;
    expect(['withheld', 'clean']).toContain(verdict(secrets, full, 'lqinov'));
  });
});

describe('L-3: phone shapes of a number the recorder does not know', () => {
  const secrets = [...BASE, { kind: 'name' as const, value: 'Ozodbek Sinovov' }];
  it.each([
    ['(90) 123-45-67', '<span>(90) 123-45-67</span>', '901234567'],
    ['(90) 123 45 67', '<span>(90) 123 45 67</span>', '901234567'],
    ['90 1234567', '<span>90 1234567</span>', '901234567'],
    ['90.123.45.67', '<span>90.123.45.67</span>', '901234567'],
    ['alone in an element', '<span>901234567</span>', '901234567'],
    ['tel 88…', '<span>tel 881234567</span>', '881234567'],
    ['tel 33…', '<span>tel 331234567</span>', '331234567'],
    ['tel 77…', '<span>tel 771234567</span>', '771234567'],
    ['998 (90) 123 45 67', '<span>998 (90) 123 45 67</span>', '901234567'],
    ['8 916 123 45 67', '<span>8 916 123 45 67</span>', '9161234567'],
    ['Telefon raqami: 50…', '<span>Telefon raqami: 501234567</span>', '501234567'],
    ['номер 20…', '<span>Номер: 201234567</span>', '201234567'],
  ])('%s', (_id, page, needle) => {
    expect(['withheld', 'clean']).toContain(verdict(secrets, page, needle));
  });

  it('ids and amounts are not phones (no collision)', () => {
    const s = createFixtureSanitizer({ secrets, keepAddresses: [] });
    const leak = createLeakCheck({ secrets, keepAddresses: [] });
    for (const text of [
      '{"req_id":"901234567"}',
      '<span>amount 901234567 nanoton</span>',
      '<span>Telegram Stars 900000000</span>',
      '<span>Stars: 901234567</span>',
    ]) {
      expect(s.sanitizeText(text)).toBe(text);
      expect(leak(text)).toEqual([]);
    }
    // A JSON number under "id" is a number field, not a phone: the text rules keep it.
    expect(s.sanitizeText('{"id": 901234567}')).not.toContain('REDACTED:phone');
  });
});
