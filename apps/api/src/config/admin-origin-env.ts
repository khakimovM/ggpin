import { BRAND } from '@repo/shared';

function urlOf(value: string | undefined): URL | null {
  if (value === undefined) return null;
  try {
    return new URL(value);
  } catch {
    return null; // a malformed URL is reported by the schema
  }
}

/**
 * Production rules for ADMIN_URL (S2-m1, S2-2). The admin guards trust exactly
 * `Origin === ADMIN_URL`, so the admin origin must belong to the admin panel alone:
 *   - different from the store's origin (WEB_URL) and the Mini App's (MINI_APP_URL), or a store
 *     page could call admin routes with the admin Origin;
 *   - different from the API's own public origin (TELEGRAM_WEBHOOK_URL): the panel is a separate
 *     site; the P11-S3 proxy (`deploy/proxy/Caddyfile` on `feat/p11-launch`) serves the admin API
 *     on the panel's own origin (admin.ggpin.uz/api/v1/admin/*, WireGuard only) and never on
 *     api.ggpin.uz, so a page on the public API name is never ADMIN_URL's origin
 *     (AdminCsrfGuard's same-origin read also checks Host);
 *   - a subdomain of the brand's domain (admin.ggpin.uz), the host the bot's code message names.
 * The messages name the rule, never the URL.
 */
export function adminOriginProblems(env: Readonly<Record<string, string | undefined>>): string[] {
  const admin = urlOf(env['ADMIN_URL']);
  if (admin === null) return [];
  const problems: string[] = [];
  const web = urlOf(env['WEB_URL']);
  const miniApp = urlOf(env['MINI_APP_URL']);
  if (web !== null && web.origin === admin.origin) {
    problems.push('ADMIN_URL: must not share its origin with WEB_URL in production');
  }
  if (miniApp !== null && miniApp.origin === admin.origin) {
    problems.push('ADMIN_URL: must not share its origin with MINI_APP_URL in production');
  }
  // The API's own public origin: the webhook URL is the one env value that names it (S2 CR 5).
  const api = urlOf(env['TELEGRAM_WEBHOOK_URL']);
  if (api !== null && api.origin === admin.origin) {
    problems.push(
      'ADMIN_URL: must not share its origin with the API (TELEGRAM_WEBHOOK_URL) in production',
    );
  }
  if (!admin.hostname.toLowerCase().endsWith(`.${BRAND.domain}`)) {
    problems.push(`ADMIN_URL: must be a subdomain of ${BRAND.domain} in production`);
  }
  return problems;
}
