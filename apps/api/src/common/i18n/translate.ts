import ru from '@repo/i18n/ru.json';
import uz from '@repo/i18n/uz.json';
import { DEFAULT_LOCALE, type Locale } from '@repo/shared';
import { escapeHtml } from './html';

export type TranslateParams = Readonly<Record<string, string | number>>;

export class TranslationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranslationError';
  }
}

function flatten(node: unknown, prefix: string, out: Map<string, string>): Map<string, string> {
  if (typeof node === 'string') {
    out.set(prefix, node);
  } else if (typeof node === 'object' && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      flatten(value, prefix === '' ? key : `${prefix}.${key}`, out);
    }
  }
  return out;
}

const CATALOGS: Readonly<Record<Locale, ReadonlyMap<string, string>>> = {
  uz: flatten(uz, '', new Map()),
  ru: flatten(ru, '', new Map()),
};

// Bot templates use only `{name}`. `{count, plural, ...}` / `{x, select, ...}` need an ICU
// formatter we have not added; failing loudly beats sending a half-rendered message.
const ICU_ARGUMENT = /\{\s*\w+\s*,/;
const PLACEHOLDER = /\{(\w+)\}/g;

export function renderTemplate(template: string, key: string, params: TranslateParams): string {
  if (ICU_ARGUMENT.test(template)) {
    throw new TranslationError(`"${key}" uses ICU plural/select, which the bot cannot render yet`);
  }
  return template.replace(PLACEHOLDER, (_whole, name: string) => {
    const value = Object.hasOwn(params, name) ? params[name] : undefined;
    if (value === undefined) throw new TranslationError(`"${key}" needs param "${name}"`);
    return escapeHtml(String(value));
  });
}

/**
 * Renders a catalog message. Params are HTML-escaped because every bot message is sent with
 * `parse_mode: 'HTML'`; the template itself is trusted. Throws on a missing key, a missing
 * param, or ICU syntax.
 */
export function translate(locale: Locale, key: string, params: TranslateParams = {}): string {
  const template = CATALOGS[locale].get(key);
  if (template === undefined) throw new TranslationError(`Missing message "${key}" for ${locale}`);
  return renderTemplate(template, key, params);
}

/**
 * Production variant: a broken message must not leave the user in silence. Falls back to the
 * default locale, then to the bare key, and reports the problem through `onProblem` so it
 * shows up in logs. Tests and development use the strict `translate`.
 */
export function translateLenient(
  locale: Locale,
  key: string,
  params: TranslateParams,
  onProblem: (error: TranslationError) => void,
): string {
  try {
    return translate(locale, key, params);
  } catch (error) {
    if (!(error instanceof TranslationError)) throw error;
    onProblem(error);
  }
  try {
    return translate(DEFAULT_LOCALE, key, params);
  } catch (error) {
    if (!(error instanceof TranslationError)) throw error;
    return escapeHtml(key);
  }
}
