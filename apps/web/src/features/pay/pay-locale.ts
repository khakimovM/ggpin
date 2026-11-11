// No value imports on purpose: the edge middleware imports this file, and it must not drag in the
// whole `@repo/shared` barrel (zod and every schema) to read one query parameter.

/** Set by the middleware from `?locale=`, so the first HTML already says `<html lang>` right. */
export const PAY_LOCALE_HEADER = 'x-pay-locale';

export type PayLocale = 'uz' | 'ru';

/**
 * THE rule for the pay page language (D-38), judged on the DECODED query: exactly one parameter,
 * named `locale`, with one value, `ru` or `uz`. A missing value, any other value, a second
 * parameter or a repeated one is Uzbek. `?locale=ru&`, `?locale=%72u` and `?locale=ru` therefore
 * all mean Russian, in the middleware (`<html lang>`) and in the page (the text) alike.
 */
export function payLocaleFromEntries(entries: ReadonlyArray<readonly [string, string]>): PayLocale {
  const only = entries.length === 1 ? entries[0] : undefined;
  return only?.[0] === 'locale' && only[1] === 'ru' ? 'ru' : 'uz';
}

type Query = Record<string, string | string[] | undefined>;

/** The same rule for the page's `searchParams` record (Next has already decoded it). */
export function payLocaleOf(query: Query): PayLocale {
  const entries: Array<readonly [string, string]> = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    // A repeated parameter arrives as an array: two values, so not a lone `locale`.
    if (Array.isArray(value)) return 'uz';
    entries.push([key, value]);
  }
  return payLocaleFromEntries(entries);
}
