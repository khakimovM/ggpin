// Reads every occurrence of a cookie name from the raw Cookie header. @fastify/cookie (cookie@2)
// keeps only the FIRST value of a repeated name, and browsers send the cookie with the longest
// Path first, so a planted twin (a cookie with a Domain attribute and a longer Path) would
// silently shadow the visitor's own cookie. Production names are `__Host-`, which the browser
// refuses with a Domain, so a twin should not exist at all; callers that hold a credential still
// check whether a name appears more than once, as a second line (a dev name, a browser bug).
//
// The parsing mirrors cookie@2.0.1 (`parseCookie`) on purpose: if this reader and the library
// disagreed about what counts as "the same name", a twin could slip past the count. So: pairs are
// split on ";", names and values are trimmed of SP and HTAB only (not \v, \f or other
// whitespace), quotes are kept, and a value is percent-decoded only when it contains "%" (the raw
// value on a malformed escape).

const SP_HTAB = /^[ \t]+|[ \t]+$/g;

function trim(text: string): string {
  return text.replace(SP_HTAB, '');
}

function decode(value: string): string {
  if (!value.includes('%')) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** All values of cookie `name`, in header order. Empty values are kept (they still count). */
export function cookieValues(header: string | string[] | undefined, name: string): string[] {
  if (header === undefined) return [];
  const text = Array.isArray(header) ? header.join('; ') : header;
  const values: string[] = [];
  for (const part of text.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (trim(part.slice(0, eq)) === name) values.push(decode(trim(part.slice(eq + 1))));
  }
  return values;
}
