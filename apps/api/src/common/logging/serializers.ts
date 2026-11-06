import { REDACTED, redactSecrets } from '@repo/shared';

// Request and response are serialised to an allowlist, never copied: a Fastify/Node request
// carries the whole header map (cookies, bearer tokens, webhook secrets) and the socket.
// Redaction runs over the result as well, in case a future edit widens the allowlist.

const SAFE_REQUEST_HEADERS = ['user-agent', 'content-length'] as const;
const MAX_HEADER_LENGTH = 200;
/** Paths are cut here in every log line: an 8 000-character id (D-42 (2)) must not bloat the log. */
export const MAX_PATH_LENGTH = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** `/a/b?token=x#frag` -> `/a/b`: queries can carry nonces and tokens. */
export function pathWithoutQuery(url: string): string {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

// The web login nonce travels in the PATH of GET /auth/telegram/status/:nonce. Anyone who reads
// it from a log could poll that login request, so the segment never reaches a log line. The
// match runs on the decoded path (a client may encode "telegram" or the slash), is
// case-insensitive, ignores the version prefix, and swallows everything after "status/".
const NONCE_ROUTE = /\/auth\/telegram\/status\/(.+)$/is;

// Malformed escapes ("%zz", a lone "%") make decodeURIComponent throw; a client can send
// them on purpose to dodge the redaction, so fall back to decoding byte by byte.
function decodeForMatching(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path.replace(/%([0-9a-f]{2})/gi, (_m, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
  }
}

/** Replaces the nonce in `/auth/telegram/status/<nonce>` paths with the redaction marker. */
export function redactLoginNonce(path: string): string {
  const decoded = decodeForMatching(path);
  const match = NONCE_ROUTE.exec(decoded);
  if (match === null) return path;
  const [whole = '', nonce = ''] = match;
  const prefix = whole.slice(0, whole.length - nonce.length);
  const trailingSlash = nonce.endsWith('/') ? '/' : '';
  return `${decoded.slice(0, match.index)}${prefix}${REDACTED}${trailingSlash}`;
}

/** What a request path may look like in a log line: no query, no login nonce. */
export function loggablePath(url: string): string {
  return redactLoginNonce(pathWithoutQuery(url));
}

export function serializeRequest(req: unknown): unknown {
  if (!isRecord(req)) return undefined;
  const headers: Record<string, string> = {};
  const source = isRecord(req.headers) ? req.headers : {};
  for (const name of SAFE_REQUEST_HEADERS) {
    const value = source[name];
    if (typeof value === 'string') headers[name] = value.slice(0, MAX_HEADER_LENGTH);
  }
  return redactSecrets({
    id: req.id,
    method: req.method,
    path: typeof req.url === 'string' ? loggablePath(req.url).slice(0, MAX_PATH_LENGTH) : undefined,
    headers,
  });
}

export function serializeResponse(res: unknown): unknown {
  if (!isRecord(res)) return undefined;
  return { statusCode: res.statusCode };
}
