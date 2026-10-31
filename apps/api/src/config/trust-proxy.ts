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
  if (length === 0) return 'prefix /0 would trust every address; list the real proxy network';
  return null;
}

/** Parses a comma-separated TRUST_PROXY value; empty means "trust no proxy". */
export function parseTrustedProxies(raw: string): TrustedProxiesResult {
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  for (const [index, entry] of entries.entries()) {
    const problem = entryProblem(entry);
    // Position, not the text: keeps the message free of whatever was pasted.
    if (problem !== null) return { ok: false, problem: `entry ${index + 1}: ${problem}` };
  }
  return { ok: true, entries };
}
