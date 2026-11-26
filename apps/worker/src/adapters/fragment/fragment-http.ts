import { ADAPTER_CALL_TIMEOUT_MS } from '../fulfillment-adapter';
import { ForeignHostError, assertFragmentUrl } from './fragment-page';

// The one HTTP door to fragment.com (phase 5 S7; the S8 adapter and the keep-alive go through it).
//
// - `fetch` is injected: the worker passes Node's fetch only in a live process (fragment-session
//   module factory); tests pass a fake, and the dry run never builds this with a real one.
// - Host allowlist: only `https://fragment.com` (port 443, no credentials, assertFragmentUrl).
// - `redirect: 'manual'`: a 3xx is an error, never followed (a redirect could lead elsewhere,
//   or to the login page while we believe we are logged in).
// - A hard timeout on the whole exchange, body included (AbortSignal.timeout), joined with the
//   caller's signal; the body is read up to `maxBodyBytes` and the stream cancelled past it.
// - Errors carry a fixed code and message: never the URL query, a cookie, a header or the body.

export type FragmentFetch = (input: string, init: RequestInit) => Promise<Response>;

export const FRAGMENT_HTTP_TIMEOUT_MS = 8_000;
/** Fragment pages are tens of kilobytes; anything near this is not a page we know. */
export const FRAGMENT_MAX_BODY_BYTES = 2 * 1024 * 1024;

export type FragmentHttpErrorCode =
  'FOREIGN_HOST' | 'REDIRECT' | 'TIMEOUT' | 'ABORTED' | 'NETWORK' | 'TOO_LARGE';

export class FragmentHttpError extends Error {
  constructor(readonly code: FragmentHttpErrorCode) {
    super(`fragment.com request failed: ${code}`);
    this.name = 'FragmentHttpError';
  }
}

export interface FragmentRequest {
  readonly method: 'GET' | 'POST';
  /** A path on fragment.com (`/`, `/api?hash=...`); an absolute URL elsewhere is refused. */
  readonly path: string;
  readonly cookieHeader: string;
  /** `application/x-www-form-urlencoded` body of a POST. */
  readonly form?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface FragmentResponse {
  readonly status: number;
  readonly setCookies: readonly string[];
  readonly body: string;
}

export interface FragmentHttpOptions {
  readonly fetch: FragmentFetch;
  readonly timeoutMs?: number;
  readonly maxBodyBytes?: number;
}

// A generic desktop browser identity: requests must not name the project or its owner.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/130.0.0.0 Safari/537.36';

/** Rejects when `signal` aborts (so a body that never ends cannot outlive the timeout). */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error('read failed'));
      },
    );
  });
}

export class FragmentHttp {
  private readonly timeoutMs: number;
  private readonly maxBodyBytes: number;

  constructor(private readonly options: FragmentHttpOptions) {
    // Never longer than an adapter call may take (fulfillment-adapter.ts, S3b gate I-1).
    this.timeoutMs = Math.min(
      options.timeoutMs ?? FRAGMENT_HTTP_TIMEOUT_MS,
      ADAPTER_CALL_TIMEOUT_MS,
    );
    this.maxBodyBytes = options.maxBodyBytes ?? FRAGMENT_MAX_BODY_BYTES;
  }

  async request(request: FragmentRequest): Promise<FragmentResponse> {
    let url: URL;
    try {
      url = assertFragmentUrl(request.path);
    } catch (error) {
      if (error instanceof ForeignHostError) throw new FragmentHttpError('FOREIGN_HOST');
      throw error;
    }
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal =
      request.signal === undefined ? timeout : AbortSignal.any([timeout, request.signal]);
    const failure = (): FragmentHttpError =>
      new FragmentHttpError(timeout.aborted ? 'TIMEOUT' : signal.aborted ? 'ABORTED' : 'NETWORK');
    const headers: Record<string, string> = { 'user-agent': USER_AGENT, accept: '*/*' };
    if (request.cookieHeader !== '') headers['cookie'] = request.cookieHeader;
    let body: string | undefined;
    if (request.form !== undefined) {
      headers['content-type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      body = new URLSearchParams(Object.entries(request.form)).toString();
    }
    let response: Response;
    try {
      response = await untilAborted(
        this.options.fetch(url.href, {
          method: request.method,
          headers,
          body,
          redirect: 'manual',
          signal,
        }),
        signal,
      );
    } catch {
      throw failure();
    }
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel().catch(() => undefined);
      throw new FragmentHttpError('REDIRECT');
    }
    const text = await this.readBody(response, signal, failure);
    return { status: response.status, setCookies: response.headers.getSetCookie(), body: text };
  }

  private async readBody(
    response: Response,
    signal: AbortSignal,
    failure: () => FragmentHttpError,
  ): Promise<string> {
    const declared = response.headers.get('content-length');
    if (declared !== null && /^\d+$/.test(declared) && Number(declared) > this.maxBodyBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new FragmentHttpError('TOO_LARGE');
    }
    if (response.body === null) return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await untilAborted(reader.read(), signal);
        if (done) break;
        total += value.byteLength;
        if (total > this.maxBodyBytes) throw new FragmentHttpError('TOO_LARGE');
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      if (error instanceof FragmentHttpError) throw error;
      throw failure();
    }
    return Buffer.concat(chunks).toString('utf8');
  }
}
