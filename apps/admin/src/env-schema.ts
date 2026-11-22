import { z } from 'zod';

// The admin SPA's build-time configuration (VITE_* values are shipped to the browser: never a
// secret here). Pure: vite.config.ts runs it at build time (a bad production build stops there),
// src/env.ts again in the browser.

// Endpoint groups the in-browser mock transport may answer (phase 9, until each API exists).
// Naming anything else in VITE_API_MOCKS is a configuration error, not a silent no-op.
// orders, wallet and fragment have no API before phase 9-B (S10-S12): there the mock is the only
// way to see the screens; the other groups exist in the API and are mocked only for tests.
export const MOCK_GROUP_NAMES = [
  'auth',
  'confirmations',
  'dashboard',
  'orders',
  'users',
  'payments',
  'catalog',
  'settings',
  'queues',
  'wallet',
  'fragment',
  'audit',
  'admins',
] as const;
export type MockGroupName = (typeof MOCK_GROUP_NAMES)[number];

// The environment badge of the shell and the login page (Admin.dc.html `env`).
export const ENV_LABELS = ['DEV', 'STAGING', 'PRODUCTION'] as const;
export type EnvLabel = (typeof ENV_LABELS)[number];

const DEV_DEFAULTS = {
  VITE_API_URL: 'http://localhost:5000/api/v1',
  VITE_ENV_LABEL: 'DEV',
} as const;

// No trailing slash (paths are appended), no query, hash or credentials (they would be glued into
// every request), and http(s) only.
const baseUrl = z
  .url({ protocol: /^https?$/ })
  .refine(
    (value) => {
      if (/[?#]/.test(value)) return false;
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
  VITE_API_URL: baseUrl,
  VITE_ENV_LABEL: z.enum(ENV_LABELS),
  VITE_API_MOCKS: mockList,
});

export type AdminEnv = z.infer<typeof schema>;
export type RawAdminEnv = Partial<
  Record<'VITE_API_URL' | 'VITE_ENV_LABEL' | 'VITE_API_MOCKS', string | undefined>
>;

export const MOCKS_IN_PRODUCTION_MESSAGE =
  'VITE_API_MOCKS must be empty in a production build (the mock API is development-only).';

// Plain http only for a local host (a local production build talks to http://localhost).
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * `production` is true for every `vite build` and for the built bundle at run time; only the dev
 * server and the unit tests run with it false. A production build needs every value spelled out
 * (no defaults), https for a non-local API, and no mock group at all: a mocked admin would show
 * orders and balances that do not exist and accept actions that do nothing.
 */
export function parseAdminEnv(raw: RawAdminEnv, mode: { production: boolean }): AdminEnv {
  const defaults: Partial<typeof DEV_DEFAULTS> = mode.production ? {} : DEV_DEFAULTS;
  const parsed = schema.parse({
    VITE_API_URL: raw.VITE_API_URL || defaults.VITE_API_URL,
    VITE_ENV_LABEL: raw.VITE_ENV_LABEL || defaults.VITE_ENV_LABEL,
    VITE_API_MOCKS: raw.VITE_API_MOCKS ?? '',
  });
  if (!mode.production) return parsed;
  if (parsed.VITE_API_MOCKS.length > 0) throw new Error(MOCKS_IN_PRODUCTION_MESSAGE);
  const api = new URL(parsed.VITE_API_URL);
  if (api.protocol !== 'https:' && !LOCAL_HOSTS.has(api.hostname)) {
    throw new Error('VITE_API_URL must use https in a production build.');
  }
  return parsed;
}
