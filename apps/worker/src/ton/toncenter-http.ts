import https from 'node:https';
import type { TonClientParameters } from '@ton/ton';
import type { TonApiKey } from '../config/ton-api-key';

// The HTTP transport of the toncenter client (audit I2, D-60 (4)). @ton/ton posts through axios
// with its defaults: no limit on the response size, redirects followed and proxy settings taken
// from the environment, and its zod@3 (a known high, CWE-770; the owner's written exception D-60
// (4) covers the worker only) then parses whatever came back. This adapter replaces axios's
// transport with one plain node:https request: https only, a response body of at most
// TONCENTER_MAX_RESPONSE_BYTES, no redirect followed (a 3xx is an error like any other non-2xx),
// no proxy (an Agent of its own, so neither axios's proxy-from-env nor NODE_USE_ENV_PROXY
// applies) and one deadline for the whole exchange. Errors carry a code and the status only:
// never the request headers (the API key) in a message.
//
// The X-API-Key header is set HERE from the config's TonApiKey holder (review m5, audit I-3): the
// TonClient is built without the key. A `fresh` adapter opens a new socket for every request (an
// Agent of its own per request, no keep-alive), so a lagging backend node that a kept-alive
// connection sticks to cannot answer the reads that confirm an EXPIRY observation (audit M-1 (b)).

export type TonHttpAdapter = NonNullable<TonClientParameters['httpAdapter']>;
type AdapterConfig = Parameters<TonHttpAdapter>[0];
type AdapterResponse = Awaited<ReturnType<TonHttpAdapter>>;

/**
 * A transactions page of SCAN_PAGE_SIZE (100, the documented limit) is a few hundred kilobytes;
 * 2 MiB leaves room and stops a flood. A page that is larger still (big message bodies) fails the
 * look as a gateway error; asking for a smaller page then is left to S9.
 */
export const TONCENTER_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

/** What the adapter needs of a response (node's IncomingMessage has it). */
export interface ResponseLike extends AsyncIterable<unknown> {
  readonly statusCode?: number | undefined;
  readonly statusMessage?: string | undefined;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  destroy(error?: Error): unknown;
}

/** What the adapter needs of a request (node's ClientRequest has it). */
export interface RequestLike {
  on(event: 'error', listener: (error: Error) => void): unknown;
  end(body: string): unknown;
}

export type RequestFn = (
  url: URL,
  options: https.RequestOptions,
  onResponse: (response: ResponseLike) => void,
) => RequestLike;

export interface BoundedHttpOptions {
  readonly maxBytes?: number;
  /** Sent as X-API-Key on every request; never part of a message. */
  readonly apiKey?: TonApiKey | undefined;
  /** A new socket per request (no keep-alive): the confirming reads of an EXPIRY observation. */
  readonly fresh?: boolean;
  /** Tests only: answers without a network. */
  readonly request?: RequestFn;
}

/** An error the gateway maps by its code; the message never holds a header or a body. */
export class TonHttpError extends Error {
  constructor(
    readonly code: 'ECONNABORTED' | 'ERR_RESPONSE_TOO_LARGE' | 'ERR_NOT_HTTPS' | 'ERR_BAD_BODY',
  ) {
    super(`toncenter transport: ${code}`);
    this.name = 'TonHttpError';
  }
}

/** A non-2xx answer, in the shape axios gives its adapters' rejections (status and body). */
export class TonHttpStatusError extends Error {
  readonly response: { readonly status: number; data: unknown; headers: object };

  constructor(status: number, data: string) {
    super(`toncenter answered HTTP ${String(status)}`);
    this.name = 'TonHttpStatusError';
    this.response = { status, data, headers: {} };
  }
}

const nodeRequest: RequestFn = (url, options, onResponse) =>
  https.request(url, options, onResponse);

function targetOf(config: AdapterConfig): URL {
  const base: unknown = config.baseURL;
  const params: unknown = config.params;
  if (typeof config.url !== 'string' || base !== undefined || params !== undefined) {
    throw new TonHttpError('ERR_NOT_HTTPS');
  }
  const url = new URL(config.url);
  if (url.protocol !== 'https:') throw new TonHttpError('ERR_NOT_HTTPS');
  return url;
}

function bodyOf(config: AdapterConfig): string {
  const data: unknown = config.data;
  if (typeof data !== 'string') throw new TonHttpError('ERR_BAD_BODY');
  return data;
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8');
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  throw new TonHttpError('ERR_BAD_BODY');
}

async function readCapped(response: ResponseLike, maxBytes: number): Promise<string> {
  const declared = Number(response.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    response.destroy();
    throw new TonHttpError('ERR_RESPONSE_TOO_LARGE');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    const buffer = toBuffer(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      response.destroy();
      throw new TonHttpError('ERR_RESPONSE_TOO_LARGE');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function exchange(
  send: RequestFn,
  url: URL,
  options: https.RequestOptions,
  body: string,
): Promise<ResponseLike> {
  return new Promise((resolve, reject) => {
    const request = send(url, options, resolve);
    request.on('error', reject);
    request.end(body);
  });
}

/** The pooled agent of a normal adapter; a fresh adapter makes one per request (and drops it). */
function agentFor(options: BoundedHttpOptions, pooled: https.Agent): https.Agent {
  return options.fresh === true ? new https.Agent({ keepAlive: false, maxSockets: 1 }) : pooled;
}

export function boundedHttpsAdapter(options: BoundedHttpOptions = {}): TonHttpAdapter {
  const maxBytes = options.maxBytes ?? TONCENTER_MAX_RESPONSE_BYTES;
  const send = options.request ?? nodeRequest;
  const pooled = new https.Agent({ keepAlive: true, maxSockets: 8 });
  const apiKey = options.apiKey;
  return async (config) => {
    const url = targetOf(config);
    const body = bodyOf(config);
    const headers = {
      ...config.headers.toJSON(true),
      'Content-Length': String(Buffer.byteLength(body)),
      ...(apiKey === undefined ? {} : { 'X-API-Key': apiKey.headerValueForToncenter() }),
    };
    const agent = agentFor(options, pooled);
    const controller = new AbortController();
    const timeoutMs =
      typeof config.timeout === 'number' && config.timeout > 0
        ? config.timeout
        : DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const method = (config.method ?? 'post').toUpperCase();
      const response = await exchange(
        send,
        url,
        { method, headers, agent, signal: controller.signal },
        body,
      );
      const data = await readCapped(response, maxBytes);
      // A body cut short by the deadline is not an answer.
      if (controller.signal.aborted) throw new TonHttpError('ECONNABORTED');
      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300) throw new TonHttpStatusError(status, data);
      const answer: AdapterResponse = {
        data,
        status,
        statusText: response.statusMessage ?? '',
        headers: {},
        config,
      };
      return answer;
    } catch (error) {
      if (controller.signal.aborted) throw new TonHttpError('ECONNABORTED');
      throw error;
    } finally {
      clearTimeout(timer);
      if (agent !== pooled) agent.destroy();
    }
  };
}
