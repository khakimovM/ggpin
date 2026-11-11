import { z } from 'zod';

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
const baseUrl = httpUrl
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
  // Empty means "no support link": the UI hides the "write to operator" entry.
  NEXT_PUBLIC_SUPPORT_URL: z.union([z.literal(''), httpUrl]),
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
    | 'NEXT_PUBLIC_SUPPORT_URL',
    string | undefined
  >
>;

// Plain http is allowed in production only for a local host (CI and local runs of a production
// build talk to http://localhost); every real deployment must use https.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function assertSecureUrls(env: ClientEnv): void {
  const urls = {
    NEXT_PUBLIC_API_URL: env.NEXT_PUBLIC_API_URL,
    NEXT_PUBLIC_SITE_URL: env.NEXT_PUBLIC_SITE_URL,
    NEXT_PUBLIC_SUPPORT_URL: env.NEXT_PUBLIC_SUPPORT_URL,
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
