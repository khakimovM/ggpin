import { createFixtureSanitizer, type SecretValue } from '../fixture-sanitizer';
import { createLeakCheck } from '../leak-check';
import { BS, FAKE, FRAGMENT_PAY_ADDRESS, htmlHexEntities, jsonEscaped } from './fragment-fakes';

// The spellings a secret can take in a page (fix round M1, m4, S-2, S-5, S-6): each must be
// redacted by the sanitizer, and the staged text must pass the independent leak check.

const ch = (...codes: number[]): string => String.fromCharCode(...codes);
const SECRETS: SecretValue[] = [
  { kind: 'name', value: FAKE.displayName },
  { kind: 'name', value: FAKE.accountName },
  { kind: 'name', value: `D${ch(39)}Artagnan Test` },
  { kind: 'username', value: FAKE.username },
  { kind: 'tg_id', value: FAKE.telegramId },
];
const KEEP = [FRAGMENT_PAY_ADDRESS];
const sanitizer = createFixtureSanitizer({ secrets: SECRETS, keepAddresses: KEEP });
const leakCheck = createLeakCheck({ secrets: SECRETS, keepAddresses: KEEP });

function expectClean(text: string, needles: string[]): void {
  const staged = `${JSON.stringify(sanitizer.sanitizeJson({ body: text }), null, 2)}\n`;
  for (const needle of needles) {
    expect({ needle, kept: staged.toLowerCase().includes(needle.toLowerCase()) }).toEqual({
      needle,
      kept: false,
    });
  }
  expect(leakCheck(staged)).toEqual([]);
}

describe('M1: characters outside the BMP and Cyrillic', () => {
  const emojiName = FAKE.displayName;
  it.each([
    ['JSON escapes, lower case', jsonEscaped(emojiName)],
    [
      'JSON escapes, upper case',
      jsonEscaped(emojiName).replace(/u([0-9a-f]{4})/g, (_m, h: string) => `u${h.toUpperCase()}`),
    ],
    ['decimal entities', [...emojiName].map((c) => `&#${c.codePointAt(0) ?? 0};`).join('')],
    ['hex entities', htmlHexEntities(emojiName)],
    ['literal', emojiName],
  ])('%s', (_label, text) => {
    expectClean(`<span>${text}</span>`, ['Ozodbek', 'Синов', `${BS}u0421`, '&#x421;', '&#1057;']);
  });

  it('removes the emoji surrogates and entities with the name', () => {
    const text = `"t":"Ozodbek ${BS}u0421${BS}u0438${BS}u043d${BS}u043e${BS}u0432 ${BS}uD83C${BS}uDFAE"`;
    const out = sanitizer.sanitizeText(text);
    expect(out).not.toMatch(/u0421|uD83C|udfae/i);
    expect(sanitizer.sanitizeText('&#127918; &#x1F3AE; &#x4F;zodbek &#x421;инов')).not.toMatch(
      /zodbek|инов/i,
    );
  });
});

describe('m4: each word of a name (3+ characters) is a secret on its own', () => {
  it('redacts single words, word-bounded', () => {
    expectClean('<b>Синов</b> and <i>Ozodbek</i> and Ggwork', ['Синов', 'Ozodbek', 'Ggwork']);
    expect(sanitizer.sanitizeText('Ozodbekov Co')).toBe('Ozodbekov Co');
  });
});

describe('S-2: word boundaries inside URL-encoded text', () => {
  it.each([
    ['%40user', `?text=%40${FAKE.username}`, FAKE.username],
    ['t.me%2Fuser', `?u=t.me%2F${FAKE.username}`, FAKE.username],
    ['user_id%3D id', `?q=user_id%3D${FAKE.telegramId}`, FAKE.telegramId],
  ])('%s', (_label, text, needle) => expectClean(text, [needle]));
});

describe('S-5: spaces and apostrophes in names', () => {
  it.each([
    ['form +', 'Ggwork+%26+Co'],
    ['%20', 'Ggwork%20%26%20Co'],
    ['&#039;', 'D&#039;Artagnan Test'],
    ['&#x27;', 'D&#x27;Artagnan Test'],
    ['&apos;', 'D&apos;Artagnan Test'],
    ['&nbsp;', 'D&#039;Artagnan&nbsp;Test'],
    ['&#160;', 'D&#039;Artagnan&#160;Test'],
  ])('%s', (_label, text) => expectClean(`<b>${text}</b>`, ['Ggwork', 'Artagnan']));
});

describe('S-6: unknown keys, e-mails, protocol-relative photos, random tokens', () => {
  it('redacts token/auth/session/email/kyc/verify keys', () => {
    const out = sanitizer.sanitizeJson({
      token: 'a',
      auth_key: 'b',
      session: 'c',
      email: 'd',
      kyc_status: 'e',
      verify_url: 'f',
      quantity: '50',
    });
    expect(out).toEqual({
      token: '<REDACTED:token>',
      auth_key: '<REDACTED:token>',
      session: '<REDACTED:token>',
      email: '<REDACTED:email>',
      kyc_status: '<REDACTED:kyc>',
      verify_url: '<REDACTED:kyc>',
      quantity: '50',
    });
  });

  it('redacts the same keys inside JSON embedded in a page', () => {
    const out = sanitizer.sanitizeText('ajInit({"auth_token":"zz9Q","kyc":"pending","n":1})');
    expect(out).toBe('ajInit({"auth_token":"<REDACTED:token>","kyc":"<REDACTED:kyc>","n":1})');
  });

  it('redacts an e-mail, a protocol-relative photo URL and a long random value', () => {
    expectClean('owner.mail@example.com', ['owner.mail']);
    expectClean(`<img src="${BS}/${BS}/cdn4.telesco.pe/file/x0.jpg">`, ['telesco.pe']);
    const random = 'Zx8Qp2Lm7Vb4Nc1Kd9Fg3Hj6Ts5Wr0Ya';
    expect(sanitizer.sanitizeText(`v: ${random}`)).toBe('v: <REDACTED:token>');
  });

  it('keeps ordinary long words and Fragment’s pay address', () => {
    const text = `${'z'.repeat(40)} ${FRAGMENT_PAY_ADDRESS}`;
    expect(sanitizer.sanitizeText(text)).toBe(text);
  });
});
