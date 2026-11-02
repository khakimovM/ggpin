import type { MoneyLocale } from '../money';

/** The two UI locales; `uz` is the default (CLAUDE.md §1). Same union as `MoneyLocale`. */
export type Locale = MoneyLocale;
export const LOCALES = ['uz', 'ru'] as const satisfies readonly Locale[];
export const DEFAULT_LOCALE: Locale = 'uz';

// docs/07-BOT.md "Tilni aniqlash": ru, be, uk, kk -> ru; everything else -> uz.
const RUSSIAN_SPEAKING: ReadonlySet<string> = new Set(['ru', 'be', 'uk', 'kk']);

/**
 * Locale for a new user from Telegram's `language_code`. Telegram sends IETF tags such as
 * `ru` or `pt-br`, so only the primary subtag is compared, case-insensitively (`ru-RU` -> ru).
 */
export function localeFromTelegram(code?: string): Locale {
  const primary = code?.split(/[-_]/, 1)[0]?.toLowerCase() ?? '';
  return RUSSIAN_SPEAKING.has(primary) ? 'ru' : DEFAULT_LOCALE;
}
