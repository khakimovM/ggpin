import type { Locale } from '@repo/shared';

// The two locales, for code that ships to the browser on the marketing pages. `@repo/shared` is one
// barrel that carries every Zod schema of the API; a runtime import from it in a client component
// puts all of Zod (about 50 KB gzipped) on the landing, and its parse time shows in Lighthouse's
// Total Blocking Time. Only the TYPE is imported from there (erased at build); the values are
// repeated here, and client-locales.test.ts fails if they ever differ from the shared ones.
export const DEFAULT_LOCALE_CLIENT: Locale = 'uz';
export const LOCALES_CLIENT: readonly Locale[] = ['uz', 'ru'];
