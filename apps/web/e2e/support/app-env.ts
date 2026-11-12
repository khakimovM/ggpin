// Values the e2e app is built with (playwright.config.ts) and the specs expect back.
export const E2E_BOT_USERNAME = 'ggpin_bot';
export const E2E_BOT_URL = `https://t.me/${E2E_BOT_USERNAME}`;
export const E2E_CHANNEL_URL = 'https://t.me/ggpin_e2e_channel';
// The fixture catalog server (e2e/support/catalog-server.ts): the site's server-side rendering
// reads the public catalog from it (API_INTERNAL_URL).
export const E2E_CATALOG_PORT = 5100;
export const E2E_CATALOG_ORIGIN = `http://localhost:${E2E_CATALOG_PORT}`;
export const E2E_CATALOG_API_URL = `${E2E_CATALOG_ORIGIN}/api/v1`;

// The degraded pair (phase 8 S2): a second fixture catalog that always answers 500, and a second
// site server that reads it. The site caches a catalog answer for 60 s, so "the API is down" cannot
// be switched on in the main pair; it is a pair of its own (own cache key, own port) that never
// held a good answer. Specs open it with `test.use({ baseURL: E2E_DEGRADED_SITE_URL })`.
export const E2E_DEGRADED_CATALOG_PORT = 5101;
export const E2E_DEGRADED_CATALOG_ORIGIN = `http://localhost:${E2E_DEGRADED_CATALOG_PORT}`;
export const E2E_DEGRADED_CATALOG_API_URL = `${E2E_DEGRADED_CATALOG_ORIGIN}/api/v1`;
export const E2E_DEGRADED_SITE_PORT = 3101;
export const E2E_DEGRADED_SITE_URL = `http://localhost:${E2E_DEGRADED_SITE_PORT}`;
