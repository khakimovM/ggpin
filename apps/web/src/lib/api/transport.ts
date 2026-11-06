// The wire layer, kept apart from envelope parsing and auth so that tests and the dev mock can
// stand in for `fetch` without touching either.

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface TransportRequest {
  method: HttpMethod;
  /** Absolute URL, query string included. */
  url: string;
  headers: Record<string, string>;
  /** Already serialised JSON, or undefined. */
  body?: string;
  credentials: 'include' | 'omit';
  cache?: RequestCache;
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
 * `fetch` rejections (offline, CORS, abort) are left to the caller: the HTTP client turns them
 * into `ApiError{NETWORK}` and lets an abort through untouched.
 */
export const fetchTransport: Transport = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    credentials: request.credentials,
    cache: request.cache,
    signal: request.signal,
    // The API never redirects. A 3xx (a misconfigured proxy, a hijacked route) must not be followed
    // with our cookies or tokens attached: fetch rejects, and the client reports NETWORK.
    redirect: 'error',
    // Responses never need our page URL, and a pay page URL carries a capability token.
    referrerPolicy: 'no-referrer',
  });
  return {
    status: response.status,
    retryAfter: response.headers.get('retry-after'),
    body: parseJson(await response.text()),
  };
};

/** A signal that aborts after `ms`; `AbortSignal.timeout` is missing before Safari 16.4. */
export function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}
