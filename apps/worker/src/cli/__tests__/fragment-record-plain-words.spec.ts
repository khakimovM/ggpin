import { PLAIN_WORDS, SHORT_WORDS, nameWordSet, plainText } from '../fragment-record-plain';
import { strictJson } from '../fragment-record-strict';

// P6-S0a fix rounds 1-2, rule (b): the word lists are small and fixed. Adding a word (above all a
// capitalised name) must be a deliberate change of this test.

const OPTS = { keep: new Set<string>(), digits: false };
const plain = (text: string): boolean => plainText(text, false);
const APOS = String.fromCharCode(39);

describe('strict text: the word lists', () => {
  it('PLAIN_WORDS is exactly this list, all lower case', () => {
    expect([...PLAIN_WORDS].sort()).toEqual(
      [
        'account',
        'already',
        'and',
        'can',
        'cannot',
        'error',
        'for',
        'found',
        'gift',
        'has',
        'have',
        'invalid',
        'month',
        'months',
        'not',
        'premium',
        'recipient',
        'stars',
        'subscription',
        'telegram',
        'the',
        'this',
        'user',
        'username',
        'users',
        'with',
        'you',
      ].sort(),
    );
    for (const word of PLAIN_WORDS) expect(word).toBe(word.toLowerCase());
  });

  it('SHORT_WORDS is exactly the 1-2 letter English allowlist', () => {
    expect([...SHORT_WORDS].sort()).toEqual(
      ['a', 'an', 'is', 'in', 'of', 'to', 'on', 'no', 'or', 'by', 'at', 'it', 'ok'].sort(),
    );
  });
});

describe('strict text: plain or not', () => {
  it('keeps plain words, short allowed words, placeholders, digits and punctuation', () => {
    expect(plain('<REDACTED:name> (@<REDACTED:username>) already has Telegram Premium')).toBe(true);
    expect(plain('USER NOT FOUND: 3 months, ok? It is a gift to <REDACTED:key#2>')).toBe(true);
    expect(plain('')).toBe(true);
  });

  it('withholds any other letter token, in any script and of any length', () => {
    for (const text of ['Qosimova already has Premium', 'Дилноза', 'has Ali premium', 'xyz']) {
      expect(plain(text)).toBe(false);
    }
  });

  it.each([
    ['M5: a 2-letter surname', 'Anna Li already has Premium'],
    ['N8: 2-letter pieces', 'Bo Li already has Telegram Premium'],
    ['N3: CJK', '王伟 already has Telegram Premium'],
    ['N10: letters and digits', 'Q0s1m0va'],
    [`M4: apostrophe inside a word`, `Ro${APOS}za already has Premium`],
    ['M4b: U+2018 inside a word', 'Ro‘za already has Premium'],
    ['M8 / N6: a made-up placeholder', '<REDACTED:Qosimova> already has Premium'],
    ['N1: entities', '&#81;&#111;&#115; already has Telegram Premium'],
    ['N1: hex entity', '&#x51;osimova has premium'],
    ['N2: percent encoding', 'https://t.me/share?text=%D0%94%D0%B8'],
    ['N7: \\u escapes', String.raw`has Qosimova`],
    ['N4: NFD letters', 'Lèa already has Telegram Premium'],
    ['N5: zero-width split', 'Q​o​s​i already has Telegram Premium'],
  ])('%s: not plain', (_what, text) => {
    expect(plain(text)).toBe(false);
  });

  it('an apostrophe word is one token: a plain word in quotes stays plain', () => {
    expect(plain(`${APOS}premium${APOS} not found`)).toBe(true);
    expect(plain(`user${APOS}s gift`)).toBe(false);
  });

  it('a third person: 5+ digits, also split by spaces, dots, commas or dashes (M3)', () => {
    for (const text of ['user 712-345-6789 has premium', '712 345 6789', '7.123.4', '71234']) {
      expect(plainText(text, true)).toBe(false);
      expect(plainText(text, false)).toBe(true);
    }
    expect(plainText('3 months for 3.75', true)).toBe(true);
    expect(strictJson({ n: 7123456789, m: 3 }, { ...OPTS, digits: true }).value).toEqual({
      n: 0,
      m: 3,
    });
  });

  it('keeps an exact keep value (a pay address) and counts what it withholds', () => {
    const keep = new Set(['EQ-keep-me']);
    const out = strictJson(
      { a: 'EQ-keep-me', b: 'Someone', 'Some Key': 'ok' },
      { keep, digits: false },
    );
    expect(out.value).toEqual({
      a: 'EQ-keep-me',
      b: '<REDACTED:secret>',
      '<REDACTED:key#1>': 'ok',
    });
    expect(out.withheld).toBe(2);
  });
});

describe('strict text: name words', () => {
  it('every token with a letter or digit, canonical, apostrophes unified', () => {
    expect([...nameWordSet(['Dilnoza Qosimova', 'O‘g‘il Al', 'Lèa Z​o'])].sort()).toEqual(
      ['al', 'dilnoza', 'lèa', "o'g'il", 'qosimova', 'zo'].sort(),
    );
    expect(nameWordSet(['\u{1F600} \u{1F680}']).size).toBe(0);
  });
});
