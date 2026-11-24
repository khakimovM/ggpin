import { requestNonce } from '../../../csp/request-nonce';
import { env } from '../../../env';
import { AnalyticsTracker } from './AnalyticsTracker';

/**
 * Umami page views (D-08, D-57): self-hosted, no cookies, marketing pages only. Rendered by the
 * (marketing) layout and nowhere else, so /tg, /pay, /store, /login and the account pages never
 * load it. A client-side move keeps the document, and with it a mounted tracker, so every link
 * between the zones is a full page load, in both directions (zones.ts): the site's links into the
 * private pages (SiteLink) and the private pages' links to the site (PrivateLink: the store footer's
 * offer, privacy and contacts, the 404 page's way home). The tracker is then never carried into a
 * private page, and Back from the site returns to a store document that never had it. Without
 * NEXT_PUBLIC_ANALYTICS_SITE_ID it renders nothing and nothing is requested.
 *
 * The script comes from our own origin (phase 11: nginx proxies /stats/ to the Umami container),
 * so the CSP needs no new host: script-src trusts it through the nonce, and the tracker posts to
 * `<script dir>/api/send` = /stats/api/send, which connect-src 'self' already allows.
 *
 * - data-exclude-search / data-exclude-hash: the tracker drops `?…` and `#…` from the page URL and
 *   the referrer (Umami ≥ v3.0.0, `normalize`);
 * - data-do-not-track: nothing is sent when the browser asks not to be tracked;
 * - data-before-send: our own filter (analytics-before-send.ts) has the last word on every beacon,
 *   and the tag is not rendered until that filter is in place (AnalyticsTracker).
 */
export async function SiteAnalytics() {
  const websiteId = env.NEXT_PUBLIC_ANALYTICS_SITE_ID;
  if (websiteId === '') return null;
  const nonce = await requestNonce();
  return <AnalyticsTracker websiteId={websiteId} nonce={nonce} />;
}
