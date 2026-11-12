// Values the e2e app is built with (playwright.config.ts) and the specs expect back.
export const E2E_BOT_USERNAME = 'ggpin_bot';
export const E2E_BOT_URL = `https://t.me/${E2E_BOT_USERNAME}`;
export const E2E_CHANNEL_URL = 'https://t.me/ggpin_e2e_channel';
// The fixture catalog server (e2e/support/catalog-server.ts): the site's server-side rendering
// reads the public catalog from it (API_INTERNAL_URL).
export const E2E_CATALOG_PORT = 5100;
export const E2E_CATALOG_ORIGIN = `http://localhost:${E2E_CATALOG_PORT}`;
export const E2E_CATALOG_API_URL = `${E2E_CATALOG_ORIGIN}/api/v1`;
