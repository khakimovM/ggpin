import { describe, expect, it } from 'vitest';
import {
  OwnerHintSchema,
  PayLinkUrlSchema,
  buildPayLink,
  maskOwnerHint,
  readPayLocaleFromQuery,
  readPayTokenFromHash,
  shortHolderName,
} from './pay-link';

// Built, not spelled out: a 43-character base64url literal looks like a secret to scanners.
const TOKEN = `${'Tk'.repeat(21)}x`;

describe('pay link', () => {
  it('puts the token in the URL fragment, never in the query', () => {
    const url = buildPayLink('https://ggpin.example', 'cm3intent1', TOKEN);
    expect(url).toBe(`https://ggpin.example/pay/cm3intent1#t=${TOKEN}`);
    expect(url).not.toContain('?');
    expect(buildPayLink('https://ggpin.example///', 'cm3intent1', TOKEN)).toBe(url);
  });

  // dev and the e2e suite run on WEB_URL=http://localhost:3000; httpUrl() refused that and
  // POST /payments/intents answered 500.
  it('builds and accepts a link on localhost, an IP address and http', () => {
    for (const base of ['http://localhost:3000', 'http://127.0.0.1:3000', 'https://localhost']) {
      const url = buildPayLink(base, 'cm3intent1', TOKEN);
      expect(url).toBe(`${base}/pay/cm3intent1#t=${TOKEN}`);
      expect(PayLinkUrlSchema.safeParse(url).success, url).toBe(true);
    }
  });

  // D-38 Q21: the page language travels in the query, the token stays in the fragment.
  it('puts the page language in ?locale= (uz and ru) and the token after #', () => {
    for (const locale of ['uz', 'ru'] as const) {
      const url = buildPayLink('https://ggpin.example', 'cm3intent1', TOKEN, locale);
      expect(url).toBe(`https://ggpin.example/pay/cm3intent1?locale=${locale}#t=${TOKEN}`);
      expect(PayLinkUrlSchema.safeParse(url).success, url).toBe(true);
      // the query holds the language only: the token is not in anything a server receives
      expect(new URL(url).search).toBe(`?locale=${locale}`);
      expect(new URL(url).hash).toBe(`#t=${TOKEN}`);
    }
  });

  it('without a locale the link has no query at all (the page defaults to uz)', () => {
    const url = buildPayLink('http://localhost:3000', 'cm3intent1', TOKEN);
    expect(new URL(url).search).toBe('');
    expect(PayLinkUrlSchema.safeParse(url).success).toBe(true);
  });

  it('refuses an unknown locale when building and when validating', () => {
    expect(() =>
      buildPayLink('https://ggpin.example', 'cm3intent1', TOKEN, 'en' as unknown as 'uz'),
    ).toThrow();
    for (const query of ['?locale=en', '?locale=RU', '?locale=', '?locale=uz%00', '?locale=uzru']) {
      const url = `https://ggpin.example/pay/cm3intent1${query}#t=${TOKEN}`;
      expect(PayLinkUrlSchema.safeParse(url).success, url).toBe(false);
    }
  });

  it('refuses any other query, alone or next to the locale', () => {
    for (const query of [
      '?x=1',
      '?locale=ru&x=1',
      '?x=1&locale=ru',
      '?locale=uz&locale=ru',
      `?t=${TOKEN}`,
      `?locale=ru&t=${TOKEN}`,
    ]) {
      const url = `https://ggpin.example/pay/cm3intent1${query}#t=${TOKEN}`;
      expect(PayLinkUrlSchema.safeParse(url).success, url).toBe(false);
    }
    expect(
      PayLinkUrlSchema.safeParse(`https://ggpin.example/a?b=1/pay/cm3intent1#t=${TOKEN}`).success,
    ).toBe(false);
  });

  it('readPayLocaleFromQuery reads uz or ru and falls back to uz', () => {
    expect(readPayLocaleFromQuery('?locale=ru')).toBe('ru');
    expect(readPayLocaleFromQuery('?locale=uz')).toBe('uz');
    for (const search of ['', '?', '?locale=en', '?locale=RU', '?x=1&locale=ru', 'locale=ru']) {
      expect(readPayLocaleFromQuery(search), search).toBe('uz');
    }
  });

  it('refuses a malformed token or intent id when building', () => {
    expect(() => buildPayLink('https://ggpin.example', 'cm3intent1', 'short')).toThrow();
    expect(() => buildPayLink('https://ggpin.example', 'bad id', TOKEN)).toThrow();
  });

  it('PayLinkUrlSchema accepts only /pay/<id>#t=<token>', () => {
    expect(
      PayLinkUrlSchema.safeParse(`https://ggpin.example/pay/cm3intent1#t=${TOKEN}`).success,
    ).toBe(true);
    for (const bad of [
      `https://ggpin.example/pay/cm3intent1?t=${TOKEN}`, // the old query form
      `https://ggpin.example/pay/cm3intent1?x=1#t=${TOKEN}`,
      `https://ggpin.example/pay/cm3intent1#t=short`,
      `https://ggpin.example/pay/cm3intent1`,
      `https://ggpin.example/other/cm3intent1#t=${TOKEN}`,
      `ftp://ggpin.example/pay/cm3intent1#t=${TOKEN}`,
      `javascript:alert(1)//pay/cm3intent1#t=${TOKEN}`,
    ]) {
      expect(PayLinkUrlSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('readPayTokenFromHash returns the token or null', () => {
    expect(readPayTokenFromHash(`#t=${TOKEN}`)).toBe(TOKEN);
    for (const bad of [
      '',
      '#',
      '#t=',
      '#t=short',
      `t=${TOKEN}`,
      `#x=${TOKEN}`,
      `#t=${TOKEN}&y=1`,
    ]) {
      expect(readPayTokenFromHash(bad), bad).toBeNull();
    }
  });
});

describe('maskOwnerHint', () => {
  it('keeps the first and last character: Sardor -> S***r', () => {
    expect(maskOwnerHint('Sardor')).toBe('S***r');
    expect(maskOwnerHint('Aziz_k')).toBe('A***k');
  });

  it('a one-character name keeps only the first character', () => {
    expect(maskOwnerHint('S')).toBe('S***');
  });

  it('counts characters, not UTF-16 units', () => {
    expect(maskOwnerHint('Дильшод')).toBe('Д***д');
    expect(maskOwnerHint('𝔸ab𝔹')).toBe('𝔸***𝔹'); // astral letters are one character each
    expect(maskOwnerHint('😀abc😀')).toBe('a***c'); // emoji are symbols, not letters
  });

  it('keeps only letters and digits: combining marks, fillers and blank symbols vanish', () => {
    expect(maskOwnerHint('Śardòr')).toBe('S***r'); // combining accents
    expect(maskOwnerHint('ㅤSᅟarᅠdor⠀')).toBe('S***r'); // blank letters, braille
    expect(maskOwnerHint('Aziz_k.')).toBe('A***k'); // '_' and '.' are not letters
    expect(maskOwnerHint('7ab')).toBe('7***b');
  });

  it('falls through to the username when the first name shows nothing', () => {
    expect(maskOwnerHint('ㅤㅤ', 'aziz_k')).toBe('a***k');
    expect(maskOwnerHint('​', '⠀')).toBeNull();
    expect(maskOwnerHint(null, undefined)).toBeNull();
    expect(maskOwnerHint('Sardor', 'aziz_k')).toBe('S***r'); // the first name wins
  });

  it('a name of two characters or fewer shows only the first one', () => {
    expect(maskOwnerHint('Al')).toBe('A***');
    expect(maskOwnerHint('Я')).toBe('Я***');
    expect(maskOwnerHint('Ali')).toBe('A***i');
    expect(maskOwnerHint('A_l')).toBe('A***'); // '_' is dropped first, two letters remain
  });

  it('drops whitespace, control and bidi characters before masking', () => {
    expect(maskOwnerHint('  S a r‮dor\u0000 ')).toBe('S***r');
    expect(maskOwnerHint('‮​')).toBeNull();
  });

  it('no usable name gives null', () => {
    for (const name of [null, undefined, '', '   ']) expect(maskOwnerHint(name)).toBeNull();
  });

  it('every hint passes OwnerHintSchema; a full name or a control character does not', () => {
    for (const name of ['Sardor', 'S', 'Дильшод', '𝔸ab𝔹']) {
      expect(OwnerHintSchema.safeParse(maskOwnerHint(name)).success, name).toBe(true);
    }
    for (const bad of ['Sardor', 'S***rd', '***', 'S***‮', '', 'ㅤ***', 'S***ㅤ', '_***']) {
      expect(OwnerHintSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('shortHolderName', () => {
  it('first word in full, initial of the next: ALISHER KARIMOV -> ALISHER K.', () => {
    expect(shortHolderName('ALISHER KARIMOV')).toBe('ALISHER K.');
    expect(shortHolderName('  ALISHER   KARIMOV  OGLI ')).toBe('ALISHER K.');
  });

  it('a single word stays as is; nothing printable gives an empty string', () => {
    expect(shortHolderName('ALISHER')).toBe('ALISHER');
    expect(shortHolderName('')).toBe('');
    expect(shortHolderName(' ​ ')).toBe('');
  });

  it('strips control and format characters from the words', () => {
    expect(shortHolderName('ALI‮SHER KARI\u0000MOV')).toBe('ALISHER K.');
  });
});
