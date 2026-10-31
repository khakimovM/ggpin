import { randomUUID } from 'node:crypto';

export const REQUEST_ID_HEADER = 'x-request-id';

// A client-supplied id is only reused when it cannot carry anything but an identifier: no
// whitespace, quotes or control characters (log injection, header splitting) and a bounded
// length. Anything else is replaced, never sanitised into something half-valid.
const VALID_REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

interface HeaderCarrier {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

// Fastify `genReqId`: runs once per request before any hook, so the id in the logs, in the
// `X-Request-Id` response header and in the filter's error log line is always the same value.
export function generateRequestId(req: HeaderCarrier): string {
  const incoming = req.headers[REQUEST_ID_HEADER];
  // A repeated header arrives as an array; treat that as untrusted rather than picking one.
  if (typeof incoming === 'string' && VALID_REQUEST_ID.test(incoming)) return incoming;
  return randomUUID();
}
