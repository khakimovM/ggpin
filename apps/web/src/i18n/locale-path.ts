import type { Locale } from '@repo/shared';
import { DEFAULT_LOCALE_CLIENT, LOCALES_CLIENT } from './client-locales';
import { localizedPath } from './paths';

/**
 * The path of the page the visitor is on, without its locale prefix (`/ru/store` -> `/store`,
 * `/store` -> `/store`). The default locale has no prefix in the URL.
 */
export function stripLocale(pathname: string): `/${string}` {
  const first = pathname.split('/')[1];
  const prefixed = LOCALES_CLIENT.find(
    (locale) => locale !== DEFAULT_LOCALE_CLIENT && locale === first,
  );
  if (prefixed === undefined) return pathname === '' ? '/' : (pathname as `/${string}`);
  const rest = pathname.slice(prefixed.length + 1);
  return rest === '' ? '/' : (rest as `/${string}`);
}

/** The same page in another language, query kept (`/store?q=a` in ru -> `/store?q=a`). */
export function switchLocalePath(pathname: string, search: string, target: Locale): string {
  return `${localizedPath(target, stripLocale(pathname))}${search}`;
}
