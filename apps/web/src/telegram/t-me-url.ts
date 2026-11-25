// The one rule for a t.me link that comes from configuration (the brand's channel, the support
// chat): the env schema normalises with it and the site links rely on its result, so a value is
// either a clean `https://t.me/<path>` or it fails the build. Pure: the env schema imports it.

const TELEGRAM_ORIGIN = 'https://t.me';
// A handle, `+invite`, `joinchat/<hash>` or `c/<id>/<post>`: nothing that needs escaping, so an
// odd character (a quote, a space, `%`) can never reach an href.
const PATH = /^\/[A-Za-z0-9_+/-]+$/;

/**
 * The normalised `https://t.me/<path>` link (`new URL(value).href`), or null when the value is not
 * one: another scheme or host (`t.me.evil.example`, `telegram.me`), a port, credentials (empty ones,
 * as in `https://@t.me/x`, are dropped by the URL parser and never reach the result), a query
 * or a fragment (even an empty `?` or `#`), or a path with anything outside `PATH`.
 */
export function configuredTelegramUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 't.me' || url.port !== '') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (!PATH.test(url.pathname)) return null;
  const href = `${TELEGRAM_ORIGIN}${url.pathname}`;
  // `href` keeps an empty `?` or `#` that `search`/`hash` report as ''; comparing the whole
  // serialised URL rejects those too.
  return url.href === href ? href : null;
}
