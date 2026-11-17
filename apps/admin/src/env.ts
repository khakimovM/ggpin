import { parseAdminEnv, type AdminEnv } from './env-schema';

// Vite inlines only literal `import.meta.env.VITE_X` reads, so they are spelled out one by one.
// vite.config.ts has already refused a bad production build; this second check guards a bundle
// produced some other way (and gives the dev server its defaults).
export const env: AdminEnv = parseAdminEnv(
  {
    VITE_API_URL: import.meta.env.VITE_API_URL,
    VITE_ENV_LABEL: import.meta.env.VITE_ENV_LABEL,
    VITE_API_MOCKS: import.meta.env.VITE_API_MOCKS,
  },
  { production: import.meta.env.PROD },
);
