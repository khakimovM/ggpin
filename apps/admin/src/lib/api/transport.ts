// The wire layer, kept apart from envelope parsing and the session rules so that tests and the
// dev mock can stand in for `fetch` without touching either.

export type HttpMethod = 'GET' | 'POST' | 'PATCH';

export interface TransportRequest {
  method: HttpMethod;
  /** Absolute URL, query string included. */
  url: string;
  /** Lower-case header names. */
  headers: Record<string, string>;
  /** Already serialised JSON, or undefined. */
  body?: string;
  signal?: AbortSignal;
}

export interface TransportResponse {
  status: number;
  /** Raw `Retry-After` header, parsed by the envelope layer. */
  retryAfter: string | null;
  /** Parsed JSON, or undefined for an empty or non-JSON body. */
  body: unknown;
}

export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

function parseJson(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The real transport. The admin session is an httpOnly cookie on the API origin, so every request
 * carries credentials; nothing is cached; a redirect is never followed with the cookie attached
 * (fetch rejects and the client reports NETWORK); the admin URL is never sent as a referrer.
 */
export const fetchTransport: Transport = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    credentials: 'include',
    mode: 'cors',
    cache: 'no-store',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    signal: request.signal,
  });
  return {
    status: response.status,
    retryAfter: response.headers.get('retry-after'),
    body: parseJson(await response.text()),
  };
};
