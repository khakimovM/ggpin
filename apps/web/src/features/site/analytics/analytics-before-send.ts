import { isTrackedPath } from './tracked-paths';

// The last word on what one Umami beacon may carry (phase 8 S5). Umami calls the function named
// by the script's `data-before-send` with (type, payload) right before each request, and sends
// nothing when it returns a falsy value (umami-software/umami src/tracker/index.ts, `send`).
//
// Why a hook on top of `data-exclude-search` / `data-exclude-hash`:
// - The tracker stays in the window after a client-side navigation and reports every
//   history.pushState as a page view. The site's own links leave the marketing pages with a full
//   page load (SiteLink), but a history change the page makes itself must still never report a
//   page outside them, as the page or as the referrer.
// - Before v3.0.0 the tracker sent the first page view's URL and the referrer without applying the
//   two exclude flags (v2.19.0: `let currentUrl = href`). The server version is chosen in phase 11;
//   this hook keeps the guarantee whatever runs there.

/** The window property the script tag names in `data-before-send`. */
export const ANALYTICS_BEFORE_SEND = 'ggpinAnalyticsBeforeSend';

/**
 * The page view fields that may leave the browser; any other field the tracker adds (a user id,
 * custom data, a tag, whatever a later version invents) is dropped.
 */
const PASSED_FIELDS = ['website', 'screen', 'language', 'title', 'hostname'] as const;

/**
 * The URL without search and hash; `null` when it is not a URL at all. Relative values (Umami strips
 * our own origin from a same-site referrer) are read against `origin`.
 */
function withoutSearchAndHash(value: string, origin: string): URL | null {
  try {
    const url = new URL(value, origin);
    url.search = '';
    url.hash = '';
    return url;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * What the referrer may say: the path of a marketing page of ours, or only the origin of an outside
 * site; nothing (`''`) for any other page of ours (a store, login or account path may hold an order
 * id), for a page without an origin (`data:`, an app link) and for a value that is not a URL.
 */
function safeReferrer(raw: unknown, origin: string): string {
  if (typeof raw !== 'string' || raw === '') return '';
  const url = withoutSearchAndHash(raw, origin);
  if (url === null) return '';
  if (url.origin === origin) return isTrackedPath(url.pathname) ? url.pathname : '';
  return url.origin === 'null' ? '' : url.origin;
}

/**
 * The payload as it may leave the browser, or `false` to send nothing.
 *
 * Only page views (`type` "event" without a `name`) of marketing pages are sent; performance,
 * error and identify payloads and custom events are dropped (we use none of them). The URL keeps
 * only origin and path, the referrer what `safeReferrer` allows, and the other fields are the
 * allowlist above (string values only).
 */
export function analyticsBeforeSend(
  type: unknown,
  payload: unknown,
  origin: string,
): Record<string, string> | false {
  if (type !== 'event' || !isRecord(payload)) return false;
  if (payload.name !== undefined || typeof payload.url !== 'string') return false;

  const url = withoutSearchAndHash(payload.url, origin);
  if (url === null || url.origin !== origin || !isTrackedPath(url.pathname)) return false;

  const out: Record<string, string> = {};
  for (const field of PASSED_FIELDS) {
    const value = payload[field];
    if (typeof value === 'string') out[field] = value;
  }
  out.url = url.toString();
  out.referrer = safeReferrer(payload.referrer, origin);
  return out;
}
