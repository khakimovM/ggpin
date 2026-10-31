import { redactSecrets } from '@repo/shared';

// Request and response are serialised to an allowlist, never copied: a Fastify/Node request
// carries the whole header map (cookies, bearer tokens, webhook secrets) and the socket.
// Redaction runs over the result as well, in case a future edit widens the allowlist.

const SAFE_REQUEST_HEADERS = ['user-agent', 'content-length'] as const;
const MAX_HEADER_LENGTH = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** `/a/b?token=x#frag` -> `/a/b`: queries can carry nonces and tokens. */
export function pathWithoutQuery(url: string): string {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
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
    path: typeof req.url === 'string' ? pathWithoutQuery(req.url) : undefined,
    headers,
  });
}

export function serializeResponse(res: unknown): unknown {
  if (!isRecord(res)) return undefined;
  return { statusCode: res.statusCode };
}
