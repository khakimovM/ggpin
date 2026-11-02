import { isIP } from 'node:net';

// The raw client IP is PII we do not need: a session list only has to let the owner recognise
// "this is my phone / my laptop". We keep the network, not the host: IPv4 /24, IPv6 /48.

const MAX_USER_AGENT_LENGTH = 256;

/** `203.0.113.45` -> `203.0.113.x`, `2001:db8:85a3:1::7` -> `2001:db8:85a3::x`; junk -> null. */
export function maskIp(ip: string | null | undefined): string | null {
  if (ip === null || ip === undefined) return null;
  const address = ip.split('%')[0] ?? ''; // drop an IPv6 zone id
  const family = isIP(address);
  if (family === 4) return maskV4(address);
  if (family === 6) return maskV6(address);
  return null;
}

/** Stored UA: bounded, so a hostile header cannot bloat the table; empty -> null. */
export function truncateUserAgent(userAgent: string | null | undefined): string | null {
  if (userAgent === null || userAgent === undefined || userAgent === '') return null;
  return userAgent.slice(0, MAX_USER_AGENT_LENGTH);
}

function maskV4(address: string): string {
  const [a, b, c] = address.split('.');
  return `${a ?? '0'}.${b ?? '0'}.${c ?? '0'}.x`;
}

function maskV6(address: string): string | null {
  const lower = address.toLowerCase();
  // ::ffff:203.0.113.45 is an IPv4 client seen through a dual-stack socket.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped?.[1] !== undefined) return maskV4(mapped[1]);

  let text = lower;
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (tail !== null) {
    const [, a = '0', b = '0', c = '0', d = '0'] = tail;
    const hex = (hi: string, lo: string): string => ((Number(hi) << 8) | Number(lo)).toString(16);
    text = `${text.slice(0, tail.index)}${hex(a, b)}:${hex(c, d)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string): string[] => (part === '' ? [] : part.split(':'));
  const head = groups(halves[0] ?? '');
  const rest = groups(halves[1] ?? '');
  const missing = 8 - head.length - rest.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const full = [...head, ...new Array<string>(missing).fill('0'), ...rest];
  const prefix = full.slice(0, 3).map((group) => Number.parseInt(group, 16).toString(16));
  return `${prefix.join(':')}::x`;
}
