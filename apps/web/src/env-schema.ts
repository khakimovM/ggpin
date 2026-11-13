import { z } from 'zod';
import { configuredTelegramUrl } from './telegram/t-me-url';

// Groups of API endpoints that may be served by the in-browser mock transport (phase 7 only).
// `wallet` and `payments` are gone (phase 4 is merged: those endpoints are real); naming them in
// NEXT_PUBLIC_API_MOCKS is a configuration error, not a silent no-op.
export const MOCK_GROUP_NAMES = ['recipients', 'quotes', 'orders', 'referrals'] as const;
export type MockGroupName = (typeof MOCK_GROUP_NAMES)[number];

// Local-development fallbacks. Production never uses them: a missing value fails the build.
const DEV_DEFAULTS = {
  NEXT_PUBLIC_API_URL: 'http://localhost:5000/api/v1',
  NEXT_PUBLIC_SITE_URL: 'http://localhost:3000',
  NEXT_PUBLIC_BOT_USERNAME: 'ggpin_bot',
} as const;

// Bot usernames: 5-32 chars, letters/digits/underscore, starting with a letter, ending in "bot".
const botUsername = z
  .string()
  .regex(/^(?=.{5,32}$)[A-Za-z][A-Za-z0-9_]*bot$/i, 'invalid bot username');

// Only http(s): rejects javascript:, data:, ftp: and friends. Production additionally requires
// https (see assertSecureUrls).
const httpUrl = z.url({ protocol: /^https?$/ });

// The API and site URLs are joined with paths all over the app (`${base}/auth/refresh`, cookie
// path `/api/v1/auth`), so they are normalised here, once: no trailing slash (it would produce
// `//auth/refresh`), and no query, hash or credentials (they would be glued into every request).
export const baseUrl = httpUrl
  .refine(
    (value) => {
      if (/[?#]/.test(value)) return false;
      // A refinement can run on a value the URL check already rejected. (try/catch, not
      // URL.canParse: that is missing before Safari 17, i.e. in the iOS 16 Telegram web view.)
      try {
        const url = new URL(value);
        return url.username === '' && url.password === '';
      } catch {
        return false;
      }
    },
    { message: 'must not contain a query, a hash or credentials' },
  )
  .transform((value) => value.replace(/\/+$/, ''));

// A t.me link from configuration: the brand channel and the support chat. Both are shown on our own
// public pages (footer, contacts), so only https://t.me/<path> by the one rule in t-me-url.ts gets
// in, and the value is normalised here (`https://T.ME/x` becomes `https://t.me/x`): the site links use
// the parsed value as it is, nothing downstream checks it a second way.
const telegramUrl = (what: string) =>
  z.union([
    z.literal(''),
    z.string().transform((value, ctx) => {
      const href = configuredTelegramUrl(value);
      if (href === null) {
        ctx.addIssue({ code: 'custom', message: `must look like https://t.me/<${what}>` });
        return z.NEVER;
      }
      return href;
    }),
  ]);

const mockList = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== ''),
  )
  .pipe(z.array(z.enum(MOCK_GROUP_NAMES)));

const schema = z.object({
  NEXT_PUBLIC_API_URL: baseUrl,
  NEXT_PUBLIC_SITE_URL: baseUrl,
  NEXT_PUBLIC_BOT_USERNAME: botUsername,
  NEXT_PUBLIC_API_MOCKS: mockList,
  // Empty means "no support link": the UI hides the "write to operator" entry. Only the
  // operator's https://t.me/<handle>: it is shown on the public contacts page.
  NEXT_PUBLIC_SUPPORT_URL: telegramUrl('handle'),
  // Empty means "no channel": the footer and contacts hide the Channel link.
  NEXT_PUBLIC_TELEGRAM_CHANNEL_URL: telegramUrl('channel'),
});

export type ClientEnv = z.infer<typeof schema>;

// Next.js inlines only literal `process.env.NEXT_PUBLIC_X` reads, so callers pass an explicit
// object instead of this module reading `process.env` dynamically.
export type RawClientEnv = Partial<
  Record<
    | 'NEXT_PUBLIC_API_URL'
    | 'NEXT_PUBLIC_SITE_URL'
    | 'NEXT_PUBLIC_BOT_USERNAME'
    | 'NEXT_PUBLIC_API_MOCKS'
    | 'NEXT_PUBLIC_SUPPORT_URL'
    | 'NEXT_PUBLIC_TELEGRAM_CHANNEL_URL',
    string | undefined
  >
>;

// Plain http is allowed in production only for a local host (CI and local runs of a production
// build talk to http://localhost); every real deployment must use https. (The t.me links are https
// by their own rule, in every mode.)
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function assertSecureUrls(env: ClientEnv): void {
  const urls = {
    NEXT_PUBLIC_API_URL: env.NEXT_PUBLIC_API_URL,
    NEXT_PUBLIC_SITE_URL: env.NEXT_PUBLIC_SITE_URL,
  };
  for (const [name, value] of Object.entries(urls)) {
    if (value === '') continue;
    const url = new URL(value);
    if (url.protocol !== 'https:' && !LOCAL_HOSTS.has(url.hostname)) {
      throw new Error(`${name} must use https in a production build.`);
    }
  }
}

export function parseClientEnv(raw: RawClientEnv, mode: { production: boolean }): ClientEnv {
  const defaults: Partial<typeof DEV_DEFAULTS> = mode.production ? {} : DEV_DEFAULTS;
  const parsed = schema.parse({
    NEXT_PUBLIC_API_URL: raw.NEXT_PUBLIC_API_URL ?? defaults.NEXT_PUBLIC_API_URL,
    NEXT_PUBLIC_SITE_URL: raw.NEXT_PUBLIC_SITE_URL ?? defaults.NEXT_PUBLIC_SITE_URL,
    NEXT_PUBLIC_BOT_USERNAME: raw.NEXT_PUBLIC_BOT_USERNAME ?? defaults.NEXT_PUBLIC_BOT_USERNAME,
    NEXT_PUBLIC_API_MOCKS: raw.NEXT_PUBLIC_API_MOCKS ?? '',
    NEXT_PUBLIC_SUPPORT_URL: raw.NEXT_PUBLIC_SUPPORT_URL ?? '',
    NEXT_PUBLIC_TELEGRAM_CHANNEL_URL: raw.NEXT_PUBLIC_TELEGRAM_CHANNEL_URL ?? '',
  });
  if (mode.production) assertSecureUrls(parsed);
  // Mocks must never reach production: a mocked wallet/order would show money that does not exist.
  if (mode.production && parsed.NEXT_PUBLIC_API_MOCKS.length > 0) {
    throw new Error(
      'NEXT_PUBLIC_API_MOCKS must be empty in a production build (mock API is development-only).',
    );
  }
  return parsed;
}
