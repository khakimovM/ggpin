import type { Messages } from './messages';

// Which top-level namespaces of the catalog each part of the website sends to the browser. A
// `NextIntlClientProvider` without `messages` would serialise the WHOLE catalog (bot texts, admin
// texts, alerts) into the page, so every provider names what its client components read.
type Namespaces = readonly (keyof Messages)[];

/** The root of every locale page: only what a marketing page's client islands and the 404 read. */
export const ROOT_NAMESPACES = ['common'] as const satisfies Namespaces;

/** The signed-in store: every screen of the web store and the account. */
export const STORE_NAMESPACES = [
  'common',
  'errors',
  'fields',
  'web',
  'store',
  'wallet',
  'account',
  'pay',
] as const satisfies Namespaces;

/** The sign-in page: its own texts (`web.login`), the shared ones and the API error texts. */
export const LOGIN_NAMESPACES = ['common', 'errors', 'web'] as const satisfies Namespaces;
