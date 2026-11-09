/**
 * Where "Xaridni davom ettirish" leads after a top-up: the Mini App page the visitor came from
 * (the product page with the purchase they could not pay). It travels as `?from=<path>`, so it is
 * untrusted input: only a path inside the Mini App (`/tg/...`) is followed; a scheme, a host, `//`,
 * a backslash or a `..` segment is dropped, and the button then reads "Bosh sahifaga".
 */
export function safeFrom(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length > 200) return null;
  // Encoded dots, slashes and backslashes have no business in a path we built ourselves.
  if (/%(?:2e|2f|5c)/i.test(value) || value.includes('\\') || value.includes('..')) return null;
  if ([...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return null;
  try {
    // Judged AFTER the URL parser has normalised it: what is followed is what was checked.
    const url = new URL(value, 'https://mini.app.invalid');
    if (url.origin !== 'https://mini.app.invalid') return null;
    const path = url.pathname;
    if (path.includes('//') || !(path === '/tg' || path.startsWith('/tg/'))) return null;
    return path + url.search;
  } catch {
    return null;
  }
}

/** `?from=...` for the next Mini App page, or an empty string when there is nothing to carry. */
export function fromQuery(from: string | null): string {
  return from === null ? '' : `?from=${encodeURIComponent(from)}`;
}
