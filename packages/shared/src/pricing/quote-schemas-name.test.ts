import { describe, expect, it } from 'vitest';
import { RecipientSchema } from './quote-schemas';

// The recipient's display name (audit L3, owner decision R6): bidi and invisible characters are
// refused, the zero-width joiner of compound emoji is not.
describe('RecipientSchema display name', () => {
  it('a display name with invisible or bidi-control characters is refused (audit L3, R6)', () => {
    const name = (displayName: string) =>
      RecipientSchema.safeParse({ username: 'aziz_k', displayName }).success;
    expect(name('Aziz')).toBe(true);
    expect(name('Азиз Каримов')).toBe(true);
    // The exact list of owner decision R6: the Arabic letter mark, the zero-width space, the bidi
    // marks, embeddings, overrides and isolates, the BOM; plus an override at the start, NUL, newline.
    const bad = [
      'a\u061Cb',
      'a\u200Bb',
      'a\u200Eb',
      'a\u200Fb',
      'a\u202Ab',
      'a\u202Bb',
      'a\u202Cb',
      'a\u202Db',
      'a\u2066b',
      'a\u2067b',
      'a\u2068b',
      'a\u2069b',
      'a\uFEFFb',
      '\u202Etxt.exe',
      'a\u0000b',
      'a\nb',
    ];
    for (const value of bad) {
      expect(name(value), JSON.stringify(value)).toBe(false);
    }
  });

  it('a compound-emoji name passes: the zero-width joiner is allowed (owner decision R6)', () => {
    const name = (displayName: string) =>
      RecipientSchema.safeParse({ username: 'aziz_k', displayName }).success;
    expect(name('Family \u{1F468}\u200D\u{1F469}\u200D\u{1F467}')).toBe(true);
    expect(name('a\u200Db')).toBe(true);
    expect(name('a\u200Cb')).toBe(true);
    // A bidi override hidden after an otherwise fine emoji name still refuses it.
    expect(name('\u{1F468}\u200D\u{1F469}\u202E')).toBe(false);
  });
});

// D-59 Y8: more characters that hide in a name, and the "at least one visible character" rule.
// The characters are built from code points: they must not appear literally in this file.
const cp = (...points: number[]) => String.fromCodePoint(...points);
const accepts = (displayName: string) =>
  RecipientSchema.safeParse({ username: 'aziz_k', displayName }).success;

describe('RecipientSchema display name, D-59 Y8', () => {
  it('refuses the line and paragraph separators, the invisible operators and the Mongolian vowel separator', () => {
    const bad = [0x2028, 0x2029, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0x180e].map(
      (point) => `a${cp(point)}b`,
    );
    for (const value of bad) {
      expect(accepts(value), JSON.stringify(value)).toBe(false);
    }
  });

  it('a flag emoji made of a black flag and tag characters passes (England)', () => {
    const england = cp(0x1f3f4, 0xe0067, 0xe0062, 0xe0065, 0xe006e, 0xe0067, 0xe007f);
    expect(accepts(england)).toBe(true);
    expect(accepts(`${england} Aziz`)).toBe(true);
  });

  it('a name with nothing visible in it is refused: spaces, fillers, joiners, a soft hyphen', () => {
    for (const filler of [0x3164, 0x115f, 0x1160, 0xffa0]) {
      expect(accepts(cp(filler)), `U+${filler.toString(16)}`).toBe(false);
      expect(accepts(cp(filler, filler, 0x20, filler))).toBe(false);
    }
    expect(accepts(cp(0x200c, 0x200d))).toBe(false);
    expect(accepts(cp(0x00ad))).toBe(false);
    expect(accepts(cp(0x3000, 0x3164))).toBe(false);
    // The Braille blank U+2800 draws an empty cell (Z7): alone it is nothing, next to a letter it is a name.
    expect(accepts(cp(0x2800))).toBe(false);
    expect(accepts(cp(0x2800, 0x2800, 0x20))).toBe(false);
    expect(accepts(`A${cp(0x2800)}`)).toBe(true);
    // Bare tag characters show nothing; a visible letter next to a filler is a name.
    expect(accepts(cp(0xe0067, 0xe007f))).toBe(false);
    expect(accepts(`A${cp(0x3164)}`)).toBe(true);
    expect(accepts(cp(0x3164, 0x41))).toBe(true);
  });
});

// Audit R4-2: every other format character is refused too, and "visible" is defined positively, so
// a name made only of characters that draw nothing is refused whatever block they come from.
describe('RecipientSchema display name, audit R4-2', () => {
  it('refuses the remaining format characters, alone or inside a name', () => {
    const format = [
      0x00ad, 0x206a, 0x206f, 0xfff9, 0xfffa, 0xfffb, 0xe0001, 0x1d173, 0x1d17a, 0x1bca0, 0x13430,
    ];
    for (const point of format) {
      expect(accepts(cp(point)), `U+${point.toString(16)} alone`).toBe(false);
      expect(accepts(`a${cp(point)}b`), `U+${point.toString(16)} inside`).toBe(false);
    }
  });

  it('a name of combining marks or Mongolian variation selectors only shows nothing: refused', () => {
    expect(accepts(cp(0x180b))).toBe(false);
    expect(accepts(cp(0x180b, 0x180c, 0x180d))).toBe(false);
    expect(accepts(cp(0x0301, 0x0301))).toBe(false);
    expect(accepts(cp(0xfe0f))).toBe(false);
  });

  it('letters, digits, punctuation and symbols of any script are visible', () => {
    for (const name of [
      'A',
      '7',
      '!',
      '\u{1F600}',
      'Ўзбек',
      'Азиз',
      '日本',
      'مريم',
      cp(0x647, 0x200c, 0x627),
    ]) {
      expect(accepts(name), JSON.stringify(name)).toBe(true);
    }
    // A combining accent on a letter and a variation selector on an emoji stay allowed.
    expect(accepts(`e${cp(0x0301)}`)).toBe(true);
    expect(accepts(cp(0x2764, 0xfe0f))).toBe(true);
  });
});
