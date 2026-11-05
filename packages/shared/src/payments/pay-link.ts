// The pay link and the two privacy transforms of the pay page (docs/04 "Havola tokeni", D-39).
// The token travels in the URL FRAGMENT (`#t=`): a fragment is never sent to any server, not
// ours, not a proxy's, and not in a Referer header, which is why it replaced the `?t=` query
// (D-37 (15)). The page reads it from `location.hash`, strips it with `history.replaceState`
// and sends it to the API in the `X-Pay-Token` header.
import { z } from 'zod';
import { DEFAULT_LOCALE, LOCALES, type Locale } from '../auth/locale';
import { ResourceIdSchema } from '../common-schemas';
import { PAY_TOKEN_PATTERN } from './bank-feed';

// The one query the link may carry is the page language (D-38 Q21); anything else, in
// particular the retired `?t=` token, is refused.
const PAY_LINK_TAIL = /\/pay\/[A-Za-z0-9_-]{1,64}(?:\?locale=(?:uz|ru))?#t=[A-Za-z0-9_-]{43}$/;

/**
 * `${WEB_URL}/pay/<intentId>?locale=<uz|ru>#t=<token>` (the `?locale=` part is optional, the
 * page then shows Uzbek). The old `?t=` form and any other query do not pass.
 */
// z.url, not z.httpUrl: httpUrl refuses localhost and IP hosts, which is what dev and the e2e
// suite use as WEB_URL. Requiring https is the environment's job (production boot check).
export const PayLinkUrlSchema = z
  .url({ protocol: /^https?$/ })
  .max(512)
  .refine((url) => PAY_LINK_TAIL.test(url) && !url.replace(PAY_LINK_TAIL, '').includes('?'), {
    message: 'pay link must end in /pay/<intentId>[?locale=uz|ru]#t=<43-char token>',
  });

/**
 * Builds the pay link; the API calls this, so the format has a single definition. `locale` is
 * the language of the user who created the request (the page cannot know it: it has no session).
 */
export function buildPayLink(
  webUrl: string,
  intentId: string,
  token: string,
  locale?: Locale,
): string {
  if (!PAY_TOKEN_PATTERN.test(token)) throw new Error('pay token has the wrong shape');
  const base = webUrl.replace(/\/+$/, '');
  const query = locale === undefined ? '' : `?locale=${z.enum(LOCALES).parse(locale)}`;
  return PayLinkUrlSchema.parse(
    `${base}/pay/${ResourceIdSchema.parse(intentId)}${query}#t=${token}`,
  );
}

/**
 * The page language from `location.search` (`?locale=ru`); anything else, including a missing
 * or unknown value, is the default language (uz).
 */
export function readPayLocaleFromQuery(search: string): Locale {
  const value = /^\?locale=(uz|ru)$/.exec(search)?.[1];
  return value === 'ru' || value === 'uz' ? value : DEFAULT_LOCALE;
}

/**
 * Reads the token from `location.hash` (e.g. `#t=abc...`). Returns null when it is absent or
 * malformed; the pay page then shows "link expired or cancelled".
 */
export function readPayTokenFromHash(hash: string): string | null {
  const match = /^#t=([A-Za-z0-9_-]{43})$/.exec(hash);
  return match?.[1] ?? null;
}

// Only letters and digits can appear in a hint. That drops whitespace, control and format
// characters (bidi overrides, zero-width joiners), combining marks and symbols (U+2800 braille
// blank); the Hangul fillers are letters that render as blanks, so they are listed by hand.
const HINT_CHAR = /^[\p{L}\p{N}]$/u;
const BLANK_LETTERS = /[\u115F\u1160\u3164\uFFA0]/u;
const isHintChar = (char: string): boolean => HINT_CHAR.test(char) && !BLANK_LETTERS.test(char);

/**
 * `ownerHint` of the pay page (D-37 (7)): lets a payer who received a link from someone else
 * notice that it is not their own account, without exposing a name. Call it as
 * `maskOwnerHint(firstName, username)`: the first candidate that keeps at least one letter or
 * digit wins (a name made only of invisible characters falls through to the username). Only
 * letters and digits are kept (see HINT_CHAR). With three or more of them the first and the
 * last stay with `***` between (`Sardor` -> `S***r`); with two or fewer only the first stays
 * (`Al` -> `A***`: a two-letter name would otherwise be shown whole). Nothing usable -> null.
 */
export function maskOwnerHint(...candidates: (string | null | undefined)[]): string | null {
  for (const candidate of candidates) {
    const chars = Array.from(candidate ?? '').filter(isHintChar);
    const first = chars[0];
    if (first === undefined) continue;
    const last = chars.length >= 3 ? chars[chars.length - 1] : '';
    return `${first}***${last}`;
  }
  return null;
}

/** Schema of a hint produced by `maskOwnerHint` (letter or digit, `***`, optional last one). */
export const OwnerHintSchema = z
  .string()
  .regex(/^[\p{L}\p{N}]\*\*\*[\p{L}\p{N}]?$/u)
  .refine((hint) => !BLANK_LETTERS.test(hint), { message: 'hint shows a blank letter' });

/**
 * The card holder as the pay page shows it: first word in full, then the initial of the next
 * word (`ALISHER KARIMOV` -> `ALISHER K.`). A one-word name is shown as is. The full name never
 * leaves the API.
 */
export function shortHolderName(fullName: string): string {
  const words = fullName
    .split(/\s+/)
    .map((word) => word.replace(/\p{C}/gu, ''))
    .filter((word) => word !== '');
  const [first, second] = words;
  if (first === undefined) return '';
  const initial = second === undefined ? undefined : Array.from(second)[0];
  return initial === undefined ? first : `${first} ${initial}.`;
}
