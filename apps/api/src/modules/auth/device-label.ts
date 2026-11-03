// Turns a raw User-Agent into a label from a FIXED list, e.g. "Chrome, Windows". The raw header
// is attacker-controlled and Telegram auto-links URLs and @mentions in message text, so the
// notice must never echo it: whatever the header says, the output is built only from the
// literals below (or is null when nothing is recognised).
//
// Order matters: many browsers also say "Chrome" or "Safari", and iOS says "like Mac OS X".

const BROWSERS: readonly (readonly [label: string, pattern: RegExp])[] = [
  ['Telegram', /Telegram/],
  ['Edge', /\b(?:Edg|EdgA|EdgiOS|Edge)\//],
  ['Opera', /\b(?:OPR|OPT)\/|Opera/],
  ['Yandex', /YaBrowser\//],
  ['Samsung Internet', /SamsungBrowser\//],
  ['Firefox', /\b(?:Firefox|FxiOS)\//],
  ['Chrome', /\b(?:Chrome|CriOS)\//],
  ['Safari', /\bVersion\/[\d.]+.*Safari\//],
];

const SYSTEMS: readonly (readonly [label: string, pattern: RegExp])[] = [
  ['Windows', /Windows NT/],
  ['iOS', /\b(?:iPhone|iPad|iPod)\b/],
  ['Android', /Android/],
  ['macOS', /Macintosh|Mac OS X/],
  ['Linux', /Linux|X11/],
];

// Real user agents are well under 300 characters; a megabyte header is not worth scanning.
const MAX_SCANNED_CHARS = 512;

function firstMatch(
  table: readonly (readonly [string, RegExp])[],
  userAgent: string,
): string | null {
  for (const [label, pattern] of table) {
    if (pattern.test(userAgent)) return label;
  }
  return null;
}

/** "Chrome, Windows", "Safari", "Android", or null when nothing is recognised. */
export function deviceLabel(userAgent: string | null | undefined): string | null {
  if (userAgent === null || userAgent === undefined) return null;
  const text = userAgent.slice(0, MAX_SCANNED_CHARS);
  const parts = [firstMatch(BROWSERS, text), firstMatch(SYSTEMS, text)];
  const known = parts.filter((part): part is string => part !== null);
  return known.length === 0 ? null : known.join(', ');
}
