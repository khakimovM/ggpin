import { DEFAULT_LOCALE, type Locale } from '@repo/shared';

/**
 * A path of the web app in a locale: the default locale has no URL prefix (`localePrefix:
 * 'as-needed'`, see routing.ts and login-redirect.ts), the others do.
 */
export function localizedPath(locale: Locale, path: `/${string}`): string {
  const prefix = locale === DEFAULT_LOCALE ? '' : `/${locale}`;
  return path === '/' ? prefix || '/' : `${prefix}${path}`;
}

/** Where a visitor lands after signing in when the login page had no (safe) `next`. */
export const storePath = (locale: Locale): string => localizedPath(locale, '/store');
export const homePath = (locale: Locale): string => localizedPath(locale, '/');
export const loginPath = (locale: Locale): string => localizedPath(locale, '/login');
