// The one place that turns "call this endpoint" into a validated result. Auth differences live
// in the AuthStrategy, the wire in the Transport, the envelope in envelope.ts.
import { IdempotencyKeySchema, type PageMeta } from '@repo/shared';
import { z } from 'zod';
import type { AuthStrategy, SessionMode } from './auth-strategy';
import { errorFromResponse, parseResponse } from './envelope';
import { ApiError } from './errors';
import { apiUrl } from './url';
import type { MockGroupName } from './mock-groups';
import type { HttpMethod, Transport, TransportRequest, TransportResponse } from './transport';

type QueryValue = string | number | boolean | readonly string[] | undefined;

export interface ApiRequest {
  /** Defaults to GET. */
  method?: HttpMethod;
  /** Path below the API base URL, starting with a slash: `/me/wallet`. */
  path: string;
  query?: Readonly<Record<string, QueryValue>>;
  body?: unknown;
  headers?: Readonly<Record<string, string>>;
  /** Required by the API on order and payment-intent creation; one key per checkout attempt. */
  idempotencyKey?: string;
  /** Defaults to `required`. */
  session?: SessionMode;
  /** The mock group this endpoint belongs to; the real transport is used unless it is mocked. */
  group?: MockGroupName;
  /** HTTP cache mode. Defaults to `no-store`; only public, cacheable reads override it. */
  cache?: RequestCache;
  signal?: AbortSignal;
}

export interface ApiClientDeps {
  baseUrl: string;
  getStrategy: () => AuthStrategy;
  transportFor: (group: MockGroupName | undefined) => Promise<Transport>;
  now?: () => number;
}

export interface ApiClient {
  /** Validated `data` of a success envelope. */
  fetch: <S extends z.ZodType>(request: ApiRequest, schema: S) => Promise<z.infer<S>>;
  /** A page: `data` is an array of `itemSchema`, `meta` is required. */
  fetchList: <S extends z.ZodType>(
    request: ApiRequest,
    itemSchema: S,
  ) => Promise<{ items: z.infer<S>[]; meta: PageMeta }>;
}

function serialiseQuery(query: ApiRequest['query']): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    params.set(key, typeof value === 'object' ? value.join(',') : String(value));
  }
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

function buildRequest(baseUrl: string, request: ApiRequest): TransportRequest {
  const headers: Record<string, string> = { accept: 'application/json', ...request.headers };
  if (request.body !== undefined) headers['content-type'] = 'application/json';
  if (request.idempotencyKey !== undefined) {
    const key = IdempotencyKeySchema.safeParse(request.idempotencyKey);
    // A programming error, but reported like every other failure: an ApiError, no stack of Zod
    // internals (and the key itself is not echoed).
    if (!key.success) throw new ApiError({ status: 400, code: 'VALIDATION_ERROR' });
    headers['idempotency-key'] = key.data;
  }
  return {
    method: request.method ?? 'GET',
    url: apiUrl(baseUrl, `${request.path}${serialiseQuery(request.query)}`),
    headers,
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
    // Strategies upgrade this to `include` for the web channel; the default never leaks cookies.
    credentials: 'omit',
    // Nothing comes from the HTTP cache unless the endpoint opts in (the public catalog does, with
    // `cache: 'default'`): session and pay-page data are private to this browser.
    cache: request.cache ?? 'no-store',
    signal: request.signal,
  };
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

async function send(transport: Transport, request: TransportRequest): Promise<TransportResponse> {
  try {
    return await transport(request);
  } catch (error) {
    // A cancelled query is not a failure: let TanStack Query see the abort.
    if (isAbort(error)) throw error;
    throw new ApiError({ status: 0, code: 'NETWORK' });
  }
}

export function createApiClient(deps: ApiClientDeps): ApiClient {
  const now = deps.now ?? Date.now;

  async function execute<S extends z.ZodType>(request: ApiRequest, schema: S) {
    const strategy = deps.getStrategy();
    const transport = await deps.transportFor(request.group);
    const mode = request.session ?? 'required';
    const base = buildRequest(deps.baseUrl, request);
    const sessionBound = mode === 'required' || mode === 'optional';

    const sentAtEpoch = strategy.epoch();
    let response = await send(transport, strategy.prepare(base, mode));

    if (sessionBound && response.status === 401) {
      const code = errorFromResponse(response, now()).code;
      if (code === 'UNAUTHORIZED') {
        const outcome = await strategy.recover(sentAtEpoch, mode);
        if (outcome.kind === 'lost') {
          strategy.onSessionLost(mode === 'required');
          throw outcome.error;
        }
        // Resent once, with the renewed credentials. A 401 again is final (no loop).
        response = await send(transport, strategy.prepare(base, mode));
      } else if (code === 'TOKEN_REUSE_DETECTED') {
        strategy.onSessionLost(mode === 'required', errorFromResponse(response, now()));
      }
    }
    // A blocked user cannot use this session on either channel, whichever request noticed.
    if (sessionBound && response.status === 403) {
      const error = errorFromResponse(response, now());
      // The reason travels with the loss, so later requests fail with USER_BLOCKED, not a
      // generic UNAUTHORIZED.
      if (error.code === 'USER_BLOCKED') strategy.onSessionLost(mode === 'required', error);
    }
    return parseResponse(response, schema, now());
  }

  return {
    fetch: async (request, schema) => (await execute(request, schema)).data,

    fetchList: async (request, itemSchema) => {
      const { data, meta } = await execute(request, z.array(itemSchema));
      if (meta === undefined) throw new ApiError({ status: 200, code: 'INTERNAL_ERROR' });
      return { items: data, meta };
    },
  };
}
