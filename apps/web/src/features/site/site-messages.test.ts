import { describe, expect, it } from 'vitest';
import { MESSAGES } from '../../i18n/messages';

// Typography the website's texts (`site.*` of the catalogs) keep, checked on the catalogs: the e2e
// check (site-fit.spec.ts) sees only the texts its pages draw, a new key is caught here first.

/** Every text under a branch of a catalog, with its key. */
function texts(branch: unknown, key: string): [key: string, text: string][] {
  if (typeof branch === 'string') return [[key, branch]];
  if (typeof branch !== 'object' || branch === null) return [];
  return Object.entries(branch).flatMap(([name, value]) => texts(value, `${key}.${name}`));
}

/** A range of numbers ("1–2 daqiqa"), however it is dashed and spaced. */
const RANGE = /\d[\s\u00A0\u2060]*[-\u2013\u2014][\s\u00A0\u2060]*\d/gu;
/** The one way to write it: an en dash held to both numbers by word joiners (U+2060). */
const JOINED = /^\d\u2060\u2013\u2060\d$/u;

const ranges = (branch: unknown) =>
  texts(branch, 'site').flatMap(([key, text]) =>
    [...text.matchAll(RANGE)].map((match) => ({ key, range: match[0] })),
  );

describe('the website texts', () => {
  it.each(['uz', 'ru'] as const)(
    '%s: every range of numbers is joined, so that "1–2" never breaks over two lines',
    (locale) => {
      const found = ranges(MESSAGES[locale].site);
      // The catalogs have such ranges ("1–2 daqiqa"): a test that finds none checks nothing.
      expect(found.length).toBeGreaterThan(0);
      const loose = found.filter(({ range }) => !JOINED.test(range));
      expect(loose.map(({ key, range }) => `${key}: ${range}`)).toEqual([]);
    },
  );

  it('a range typed without the joiners is found, with a plain dash or a spaced hyphen', () => {
    const found = ranges({ lead: 'Yetkazish 1–2 daqiqa, kechqurun 3 - 5.' });
    expect(found.map(({ range }) => range)).toEqual(['1–2', '3 - 5']);
    expect(found.some(({ range }) => JOINED.test(range))).toBe(false);
  });
});
