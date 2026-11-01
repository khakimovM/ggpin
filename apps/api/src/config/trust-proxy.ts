import { isIP } from 'node:net';

// TRUST_PROXY is an allowlist of the reverse proxies that may speak for a client: IPs and/or
// CIDRs. Fastify (proxy-addr) then honours X-Forwarded-For only when the TCP peer is on the
// list, and takes the right-most address that is not itself a trusted proxy.
//
// Why not a hop count: a count never looks at WHO connected. A client that reaches the API
// directly (a published port, another container on the network) could send its own
// X-Forwarded-For and pick its own request.ip, i.e. its own rate-limit key (the class of
// GHSA-3m5p-2c4r-xxw2). Matching the peer address closes that.

export type TrustedProxiesResult =
  | { readonly ok: true; readonly entries: readonly string[] }
  | { readonly ok: false; readonly problem: string };

const MAX_PREFIX: Readonly<Record<number, number>> = { 4: 32, 6: 128 };

// A proxy list is a handful of hosts or one small network. Anything wider trusts (almost)
// every address, so a client could pick its own request.ip: 0.0.0.0/1 + 128.0.0.0/1 covers
// the whole IPv4 space without a /0. IPv4 below /8 and IPv6 below /32 are rejected.
const MIN_PREFIX: Readonly<Record<number, number>> = { 4: 8, 6: 32 };

const MAPPED_PREFIX_BITS = 96; // ::ffff:0:0/96 is the IPv4-mapped IPv6 range

// The 16 bytes of an IPv6 address (`::` expanded, an embedded dotted IPv4 tail converted).
function ipv6Bytes(address: string): number[] | null {
  let text = address.toLowerCase();
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
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  const bytes: number[] = [];
  for (const group of all) {
    const value = Number.parseInt(group, 16);
    if (Number.isNaN(value)) return null;
    bytes.push(value >> 8, value & 0xff);
  }
  return bytes.length === 16 ? bytes : null;
}

// proxy-addr turns `::ffff:0:0/96` into 0.0.0.0/0 (trust everyone), so an IPv4-mapped entry
// is rewritten to its plain IPv4 form (prefix - 96) BEFORE it is range-checked. Returns the
// rewritten entry, or null when the entry is not an IPv4-mapped IPv6 address.
function unmapIPv4(address: string, prefix: number | null): string | { problem: string } | null {
  const bytes = ipv6Bytes(address);
  if (bytes === null) return null;
  const isMapped =
    bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (!isMapped) return null;
  if (prefix !== null && prefix < MAPPED_PREFIX_BITS) {
    return { problem: 'IPv4-mapped IPv6 range wider than /96 would trust far more than IPv4' };
  }
  const v4 = bytes.slice(12).join('.');
  return prefix === null ? v4 : `${v4}/${String(prefix - MAPPED_PREFIX_BITS)}`;
}

// Returns what is wrong with one entry, or null when it is a usable IP / CIDR.
function entryProblem(entry: string): string | null {
  if (entry === 'true' || entry === 'false' || entry === '*') {
    return 'must be an IP address or CIDR, not "true", "false" or a wildcard';
  }
  const [address = '', prefix, ...rest] = entry.split('/');
  const family = isIP(address);
  if (family === 0) {
    return /^\d+$/.test(entry)
      ? 'a bare number (hop count) is not allowed; list the proxy IPs or CIDRs'
      : 'is not a valid IPv4/IPv6 address or CIDR';
  }
  if (prefix === undefined) return null;
  if (rest.length > 0 || !/^\d{1,3}$/.test(prefix)) return 'has an invalid CIDR prefix';
  const length = Number(prefix);
  if (length > (MAX_PREFIX[family] ?? 0)) return 'has a CIDR prefix longer than the address';
  if (length < (MIN_PREFIX[family] ?? 0)) {
    return `prefix /${prefix} is too wide: IPv${String(family)} proxy networks must be /${String(MIN_PREFIX[family])} or narrower`;
  }
  return null;
}

// Validates one entry and returns its canonical form for Fastify.
function normaliseEntry(entry: string): { entry: string } | { problem: string } {
  const problem = entryProblem(entry);
  if (problem !== null) return { problem };
  const [address = '', prefix] = entry.split('/');
  if (isIP(address) !== 6) return { entry };
  const unmapped = unmapIPv4(address, prefix === undefined ? null : Number(prefix));
  if (unmapped === null) return { entry };
  if (typeof unmapped !== 'string') return unmapped;
  const again = entryProblem(unmapped);
  return again === null ? { entry: unmapped } : { problem: again };
}

/** Parses a comma-separated TRUST_PROXY value; empty means "trust no proxy". */
export function parseTrustedProxies(raw: string): TrustedProxiesResult {
  const raws = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  const entries: string[] = [];
  for (const [index, candidate] of raws.entries()) {
    const result = normaliseEntry(candidate);
    // Position, not the text: keeps the message free of whatever was pasted.
    if ('problem' in result) return { ok: false, problem: `entry ${index + 1}: ${result.problem}` };
    entries.push(result.entry);
  }
  return { ok: true, entries };
}
