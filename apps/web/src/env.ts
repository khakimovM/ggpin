import { parseClientEnv, type ClientEnv } from './env-schema';

// Evaluated when the app code is built or started: a production build with a missing value or any
// mock group fails here. (next.config.ts imports env-schema directly, so `next typegen` and
// lint, which share the production-build phase, are not affected.)
export const env: ClientEnv = parseClientEnv(
  {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
    NEXT_PUBLIC_BOT_USERNAME: process.env.NEXT_PUBLIC_BOT_USERNAME,
    NEXT_PUBLIC_API_MOCKS: process.env.NEXT_PUBLIC_API_MOCKS,
    NEXT_PUBLIC_SUPPORT_URL: process.env.NEXT_PUBLIC_SUPPORT_URL,
  },
  { production: process.env.NODE_ENV === 'production' },
);
